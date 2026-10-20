/**
 * AI review client.
 *
 * Two ways to run a review, in priority order:
 *
 *   1. An external review service, if `AI_REVIEW_SERVICE_URL` is set. The
 *      contract is unchanged: POST {AI_REVIEW_SERVICE_URL}/review with
 *      { documentType, text } and get a ReviewScore back. This path exists so
 *      a future isolated deployment can be dropped in without touching the app.
 *
 *   2. In-process provider call (`ai-providers.ts`) — Groq or Gemini, chosen by
 *      `AI_PROVIDER`. This is the default and needs no hosting: the old Railway
 *      service is gone and AgentRouter no longer accepts the key.
 *
 * Both paths are validated by the same `validateReviewScore`, and neither ever
 * fabricates a review. Failures surface as the error contract the API route
 * already understands: AiConfigError, AiCapacityError, or a plain Error mapped
 * to HTTP 502.
 */

import {
  runReview,
  ProviderError,
  getProvider,
  getModel,
} from "@/lib/ai-providers";

/** Optional external review service. Empty means "call the provider directly". */
export function getReviewServiceUrl(): string {
  return process.env.AI_REVIEW_SERVICE_URL || "";
}

/**
 * Deprecated: the model name used before the review moved in-process.
 * Prefer the `model` returned by `reviewDocumentWithMeta`, which is the model
 * that actually produced the review. Kept exported for older callers.
 */
export const AGENTROUTER_MODEL =
  process.env.AI_REVIEW_MODEL || process.env.AGENTROUTER_MODEL || getModel(getProvider());

/** AI review service not configured (AI_REVIEW_SERVICE_URL missing / auth issue). */
export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigError";
  }
}

/** Review service reachable but busy / rate-limited. */
export class AiCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiCapacityError";
  }
}

/**
 * Stable internal classification for "the review service's upstream gateway
 * answered with an Aliyun/Alibaba WAF challenge". Carried on the error so
 * internal code can branch on it. Never sent to the client.
 */
export const AGENTROUTER_WAF_BLOCK = "AGENTROUTER_WAF_BLOCK";

/** The review service's upstream (AgentRouter) is blocked by the Aliyun WAF. */
export class AiWafBlockError extends Error {
  readonly code = AGENTROUTER_WAF_BLOCK;
  constructor(message: string) {
    super(message);
    this.name = "AiWafBlockError";
  }
}

/**
 * Verdict on whether a document appears to need a signature and whether the
 * text shows evidence of one. Produced by the review service and normalized
 * there; SmartScholar treats it as optional because deployed versions that
 * predate the field omit it (absence means "no verdict", never a failure).
 */
export interface SignatureCheck {
  /** Whether this document appears to be the kind that needs a signature at all. */
  required: boolean;
  /** SIGNED/NOT_SIGNED only meaningful when `required` is true. */
  status: "SIGNED" | "NOT_SIGNED" | "UNCERTAIN" | "NOT_APPLICABLE";
  note: string;
}

const SIGNATURE_STATUSES = new Set<SignatureCheck["status"]>([
  "SIGNED",
  "NOT_SIGNED",
  "UNCERTAIN",
  "NOT_APPLICABLE",
]);

/**
 * Defensive parse of the review service's `signatureCheck` field. Returns the
 * object only when well-formed; null when the service omitted the field or
 * sent something malformed — the review still succeeds, there's just no
 * signature verdict to persist or show.
 */
export function normalizeSignatureCheck(value: unknown): SignatureCheck | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { required?: unknown; status?: unknown; note?: unknown };
  if (typeof v.status !== "string" || !SIGNATURE_STATUSES.has(v.status as SignatureCheck["status"])) {
    return null;
  }
  return {
    required: typeof v.required === "boolean" ? v.required : v.status !== "NOT_APPLICABLE",
    status: v.status as SignatureCheck["status"],
    note: typeof v.note === "string" ? v.note : "",
  };
}

export interface ReviewScore {
  overallQuality: {
    score: number;
    strengthsSummary: string;
    weaknessesSummary: string;
  };
  atsCompatibility: {
    score: number;
    missingKeywords: string[];
    improvements: string[];
  };
  competitiveness: {
    score: number;
    uniqueStrengths: string;
    differentiation: string;
  };
  topImprovements: string[];
  quickWins: string[];
  overallAssessment: string;
  signatureCheck?: SignatureCheck;
}

export function calculateAverageScore(review: ReviewScore): number {
  const avg = Math.round(
    (review.overallQuality.score +
     review.atsCompatibility.score +
     review.competitiveness.score) / 3
  );
  return avg;
}

/** Max chars of an error message we'll surface to the client. */
const MAX_CLIENT_ERROR = 300;
function truncateForClient(message: string): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length > MAX_CLIENT_ERROR ? single.slice(0, MAX_CLIENT_ERROR) + "…" : single;
}

/**
 * Verbose request logging. Off by default: request bodies are the user's
 * document text and must not sit in production logs.
 */
const AI_DEBUG = process.env.AI_DEBUG === "true";
function debugLog(...args: unknown[]) {
  if (AI_DEBUG) console.log(...args);
}

/**
 * Structured, production-safe pipeline metadata. Numbers, model names and
 * fingerprints only — never user ids, document contents or response bodies.
 */
function infoLog(...args: unknown[]) {
  console.info("[ai-review]", ...args);
}

/**
 * Stable short fingerprint of a string (FNV-1a, hex). Used in logs so two
 * requests can be compared for "same input?" without ever printing the
 * document content. Not cryptographic — it exists to spot identical inputs.
 */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Upstream timeout for the review-service request. */
function reviewServiceTimeoutMs(): number {
  const raw = Number(process.env.AI_REVIEW_TIMEOUT_MS || 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Parse the review-service error body ({ error, message }) and classify it
 * into the error contract SmartScholar's route already understands:
 *   - 401/403            -> AiConfigError   (service not configured / auth)
 *   - 429                -> AiCapacityError (rate limit)
 *   - UPSTREAM_WAF_BLOCK -> AiWafBlockError (gateway WAF block, not retryable)
 *   - everything else    -> plain Error with the client-safe service message
 * The API key never appears in any of these messages.
 */
function mapReviewServiceError(status: number, body: string): Error {
  let parsed: { error?: string; message?: string } = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = {};
  }
  const code = parsed.error || "";
  const message = parsed.message || `AI review service returned HTTP ${status}.`;

  if (status === 401 || status === 403) {
    return new AiConfigError(message);
  }
  if (status === 429) {
    return new AiCapacityError(message);
  }
  if (code === "UPSTREAM_WAF_BLOCK") {
    console.error(
      "[ai-review] review service reported an Aliyun WAF block from its upstream gateway"
    );
    return new AiWafBlockError(message);
  }
  return new Error(message);
}

/**
 * Validate the ReviewScore returned by the review service, with the same
 * strictness as before (object with numeric 1-10 sub-scores).
 */
function validateReviewScore(data: unknown): ReviewScore {
  if (!data || typeof data !== "object") {
    throw new Error("AI review service returned a malformed review.");
  }
  const d = data as {
    overallQuality?: { score?: unknown };
    atsCompatibility?: { score?: unknown };
    competitiveness?: { score?: unknown };
  };
  const scores = [
    d.overallQuality?.score,
    d.atsCompatibility?.score,
    d.competitiveness?.score,
  ];
  if (scores.some((s) => typeof s !== "number")) {
    throw new Error("AI review service returned a malformed review.");
  }
  if (scores.some((s) => (s as number) < 1 || (s as number) > 10)) {
    throw new Error("AI review service returned a malformed review.");
  }
  return data as ReviewScore;
}

/**
 * POST {documentType, text} to an external review service and return the parsed
 * ReviewScore. Only used when AI_REVIEW_SERVICE_URL is configured.
 */
async function callRemoteService(
  text: string,
  documentType: string
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  const url = getReviewServiceUrl();

  debugLog(`[review-service] POST ${url}/review`);

  let response: Response;
  try {
    response = await fetch(`${url}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentType, text }),
      signal: AbortSignal.timeout(reviewServiceTimeoutMs()),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      infoLog(`review service timeout after ${reviewServiceTimeoutMs()}ms`);
      throw new Error("AI review service timed out. Please try again.");
    }
    infoLog("review service network error:", e instanceof Error ? e.message : String(e));
    throw new Error("AI review service is unreachable. Please try again.");
  }

  const ct = response.headers.get("content-type") || "";
  const body = await response.text().catch(() => "");
  infoLog(
    `review service response status=${response.status} contentType=${ct} responseChars=${body.length}`
  );

  if (!response.ok) {
    throw mapReviewServiceError(response.status, body);
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    console.error(
      "[ai-review] review service non-JSON response:",
      `status=${response.status} content-type=${ct} responseChars=${body.length}`
    );
    throw new Error("AI review service returned a non-JSON response.");
  }

  return {
    review: validateReviewScore(data),
    provider: "review-service",
    model: AGENTROUTER_MODEL,
  };
}

/**
 * Call the configured provider in-process (Groq or Gemini).
 *
 * Provider errors are translated into the classes the API route already maps:
 *   config   -> AiConfigError    (missing key, unknown model)
 *   capacity -> AiCapacityError  (rate limit / overloaded / quota)
 *   upstream -> plain Error      (network, timeout, 5xx)
 *   malformed-> plain Error      (the model answered but not with usable JSON)
 */
async function callProviderInProcess(
  text: string,
  documentType: string
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  try {
    const result = await runReview(text, documentType);
    return {
      review: validateReviewScore(result.review),
      provider: result.provider,
      model: result.model,
    };
  } catch (e) {
    if (e instanceof ProviderError) {
      infoLog(`provider ${e.provider} failed kind=${e.kind}: ${e.message}`);
      if (e.kind === "config") throw new AiConfigError(e.message);
      if (e.kind === "capacity") throw new AiCapacityError(e.message);
      throw new Error(e.message);
    }
    throw e;
  }
}

/** Route to the external service when configured, otherwise call the provider. */
async function callReviewService(
  text: string,
  documentType: string
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  if (getReviewServiceUrl()) {
    return callRemoteService(text, documentType);
  }
  return callProviderInProcess(text, documentType);
}

/**
 * Review a document and report which provider/model actually produced it.
 *
 * THROWS on any failure — it never fabricates a successful review. A thrown
 * error is a real failure the caller must surface to the user.
 */
export async function reviewDocumentWithMeta(
  text: string,
  documentType: string
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  if (!text || text.trim().length === 0) {
    const err = new Error("The document contains no extractable text to review.");
    infoLog(`rejected empty text for documentType=${documentType}`);
    throw err;
  }

  const target = getReviewServiceUrl() ? "review-service" : getProvider();
  infoLog(
    `review started documentType=${documentType} textChars=${text.length} ` +
      `target=${target} model=${getModel(getProvider())} ` +
      `fallback=${process.env.AI_REVIEW_FALLBACK || "none"} ` +
      `textFingerprint=${fingerprint(text)}`
  );
  debugLog(`[review] text preview (300 chars): ${text.slice(0, 300).replace(/\s+/g, " ")}`);

  let result: { review: ReviewScore; provider: string; model: string };
  try {
    result = await callReviewService(text, documentType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai-review] review failed:", msg);
    if (
      e instanceof AiConfigError ||
      e instanceof AiCapacityError ||
      e instanceof AiWafBlockError
    )
      throw e;
    throw new Error(`AI review failed: ${truncateForClient(msg)}`);
  }

  infoLog(
    `review received provider=${result.provider} model=${result.model} ` +
      `responseChars=${JSON.stringify(result.review).length}`
  );
  return result;
}

/** Backwards-compatible wrapper: the review without the provider metadata. */
export async function reviewDocument(
  text: string,
  documentType: string
): Promise<ReviewScore> {
  const { review } = await reviewDocumentWithMeta(text, documentType);
  return review;
}
