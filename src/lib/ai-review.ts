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
import {
  assumptionNote,
  type CandidateStage,
  type CandidateStageInfo,
  type StageConfidence,
} from "@/lib/candidate-stage";

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
 * The configured review service answered 404, which means the deployment
 * itself is gone — a deleted Railway app answers `{"message":"Application
 * not found"}`. Internal only: it never reaches the client, because the caller
 * falls back to the in-process provider (which is fully functional).
 */
class RemoteServiceMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteServiceMissingError";
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

/** The eight rated criteria. Weights live in `SCORE_WEIGHTS` below. */
export type CriterionKey =
  | "objectiveFocus"
  | "evidenceOutcomes"
  | "relevanceToTarget"
  | "depthAndContribution"
  | "leadershipInitiative"
  | "skillsEvidence"
  | "writingClarity"
  | "atsReadability";

export const CRITERION_KEYS: CriterionKey[] = [
  "objectiveFocus",
  "evidenceOutcomes",
  "relevanceToTarget",
  "depthAndContribution",
  "leadershipInitiative",
  "skillsEvidence",
  "writingClarity",
  "atsReadability",
];

export interface ReviewCriterion {
  rating: number;
  /** Must quote or closely paraphrase a specific line from the document. */
  justification: string;
}

export type ReviewCriteria = Record<CriterionKey, ReviewCriterion>;

export type ImprovementSeverity = "high" | "medium" | "polish";

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
  /** Present on new reviews; absent on legacy rows produced before stages. */
  stage?: CandidateStage;
  stageConfidence?: StageConfidence;
  /** Shown to the student when the stage had to be assumed. */
  stageAssumption?: string;
  /** Aligned by index with `topImprovements`. */
  improvementSeverities?: ImprovementSeverity[];
  /** The ratings the model returned, kept for transparency and debugging. */
  criteria?: ReviewCriteria;
}

/**
 * Fixed weights, not model judgement: the same ratings must produce the same
 * three headline scores on every run. Weights sum to 1.0 per score.
 */
export const SCORE_WEIGHTS: Record<
  "overallQuality" | "atsCompatibility" | "competitiveness",
  Partial<Record<CriterionKey, number>>
> = {
  overallQuality: {
    objectiveFocus: 0.15,
    evidenceOutcomes: 0.2,
    relevanceToTarget: 0.15,
    depthAndContribution: 0.15,
    leadershipInitiative: 0.1,
    skillsEvidence: 0.1,
    writingClarity: 0.15,
  },
  atsCompatibility: {
    atsReadability: 0.6,
    relevanceToTarget: 0.2,
    objectiveFocus: 0.1,
    skillsEvidence: 0.1,
  },
  competitiveness: {
    evidenceOutcomes: 0.25,
    depthAndContribution: 0.2,
    leadershipInitiative: 0.2,
    relevanceToTarget: 0.2,
    objectiveFocus: 0.15,
  },
};

function clampScore(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

/** Pure, deterministic: ratings in, the three headline scores out. */
export function computeScoresFromCriteria(criteria: ReviewCriteria): {
  overallQuality: number;
  atsCompatibility: number;
  competitiveness: number;
} {
  const weighted = (weights: Partial<Record<CriterionKey, number>>) =>
    clampScore(
      Object.entries(weights).reduce(
        (sum, [key, weight]) => sum + criteria[key as CriterionKey].rating * (weight ?? 0),
        0
      )
    );
  return {
    overallQuality: weighted(SCORE_WEIGHTS.overallQuality),
    atsCompatibility: weighted(SCORE_WEIGHTS.atsCompatibility),
    competitiveness: weighted(SCORE_WEIGHTS.competitiveness),
  };
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
 *   - 404                -> RemoteServiceMissingError (deployment deleted)
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
  if (status === 404) {
    return new RemoteServiceMissingError(message);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readCriteria(data: unknown): ReviewCriteria | null {
  const raw = asRecord(asRecord(data)?.criteria);
  if (!raw) return null;

  const criteria = {} as ReviewCriteria;
  for (const key of CRITERION_KEYS) {
    const item = asRecord(raw[key]);
    if (!item) return null;
    const rating = item.rating;
    if (typeof rating !== "number" || !Number.isFinite(rating) || rating < 1 || rating > 10) {
      return null;
    }
    const justification = typeof item.justification === "string" ? item.justification.trim() : "";
    // A rating without a quote is exactly the generic feedback this rubric
    // exists to prevent. Treat it as a malformed answer so it is retried rather
    // than shown to the student.
    if (!justification) return null;
    criteria[key] = { rating: clampScore(rating), justification };
  }
  return criteria;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function normalizeImprovements(value: unknown): {
  texts: string[];
  severities: ImprovementSeverity[];
} {
  const items = Array.isArray(value) ? value : [];
  const texts: string[] = [];
  const severities: ImprovementSeverity[] = [];
  for (const item of items.slice(0, 5)) {
    if (typeof item === "string" && item.trim()) {
      texts.push(item.trim());
      severities.push("medium");
      continue;
    }
    const record = asRecord(item);
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const severity = record?.severity;
    texts.push(text);
    severities.push(
      severity === "high" || severity === "medium" || severity === "polish" ? severity : "medium"
    );
  }
  return { texts, severities };
}

function attachStage(review: ReviewScore, stage?: CandidateStageInfo): ReviewScore {
  if (!stage) return review;
  return {
    ...review,
    stage: stage.stage,
    stageConfidence: stage.confidence,
    stageAssumption: assumptionNote(stage) ?? undefined,
  };
}

/** New shape: ratings + prose in, fixed-weight scores in code. */
function buildReviewFromCriteria(
  data: unknown,
  criteria: ReviewCriteria,
  stage?: CandidateStageInfo
): ReviewScore {
  const root = asRecord(data) ?? {};
  const scores = computeScoresFromCriteria(criteria);
  const ats = asRecord(root.ats);
  const quality = asRecord(root.overallQuality);
  const competitive = asRecord(root.competitiveness);
  const improvements = normalizeImprovements(root.topImprovements);

  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  return attachStage(
    {
      overallQuality: {
        score: scores.overallQuality,
        strengthsSummary: text(quality?.strengthsSummary),
        weaknessesSummary: text(quality?.weaknessesSummary),
      },
      atsCompatibility: {
        score: scores.atsCompatibility,
        missingKeywords: stringArray(ats?.missingKeywords),
        improvements: stringArray(ats?.improvements),
      },
      competitiveness: {
        score: scores.competitiveness,
        uniqueStrengths: text(competitive?.uniqueStrengths),
        differentiation: text(competitive?.differentiation),
      },
      topImprovements: improvements.texts,
      improvementSeverities: improvements.severities,
      quickWins: stringArray(root.quickWins),
      overallAssessment: text(root.overallAssessment),
      signatureCheck: normalizeSignatureCheck(root.signatureCheck) ?? undefined,
      criteria,
    },
    stage
  );
}

/**
 * Validate the review. Two accepted shapes:
 *
 *   - criteria (current prompt): eight 1-10 ratings with quotes. The three
 *     headline scores are computed here, so the same ratings always produce the
 *     same scores and a rerun cannot drift because the model felt different.
 *   - legacy scores (external service / older deployments): three 1-10 numbers.
 *     Still accepted so an older service dropped in via AI_REVIEW_SERVICE_URL
 *     keeps working.
 */
function validateReviewScore(data: unknown, stage?: CandidateStageInfo): ReviewScore {
  if (!data || typeof data !== "object") {
    throw new Error("AI review service returned a malformed review.");
  }

  const criteria = readCriteria(data);
  if (criteria) return buildReviewFromCriteria(data, criteria, stage);

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
    console.error("[ai-review] malformed review: no criteria and no numeric scores");
    throw new Error("AI review service returned a malformed review.");
  }
  if (scores.some((s) => (s as number) < 1 || (s as number) > 10)) {
    console.error("[ai-review] malformed review: a score is outside 1-10");
    throw new Error("AI review service returned a malformed review.");
  }
  return attachStage(data as ReviewScore, stage);
}

/**
 * POST {documentType, text} to an external review service and return the parsed
 * ReviewScore. Only used when AI_REVIEW_SERVICE_URL is configured.
 */
async function callRemoteService(
  text: string,
  documentType: string,
  stage?: CandidateStageInfo
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
    review: validateReviewScore(data, stage),
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
  documentType: string,
  stage?: CandidateStageInfo
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  try {
    const result = await runReview(text, documentType, stage);
    return {
      review: validateReviewScore(result.review, stage),
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
  documentType: string,
  stage?: CandidateStageInfo
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  const url = getReviewServiceUrl();
  if (!url) return callProviderInProcess(text, documentType, stage);

  try {
    return await callRemoteService(text, documentType, stage);
  } catch (e) {
    if (!(e instanceof RemoteServiceMissingError)) throw e;

    // A 404 means the deployment is gone, not that it is briefly unavailable —
    // a deleted Railway app answers "Application not found". The in-process
    // provider is fully functional, so use it rather than failing a review over
    // an environment variable someone forgot to delete.
    let host = "the configured URL";
    try {
      host = new URL(url).host;
    } catch {
      /* keep the placeholder */
    }
    console.error(
      `[ai-review] AI_REVIEW_SERVICE_URL (${host}) returned 404 — that service no longer exists. ` +
        `Falling back to the in-process provider. Remove AI_REVIEW_SERVICE_URL in Vercel to silence this.`
    );
    return callProviderInProcess(text, documentType, stage);
  }
}

/**
 * Review a document and report which provider/model actually produced it.
 *
 * THROWS on any failure — it never fabricates a successful review. A thrown
 * error is a real failure the caller must surface to the user.
 */
export async function reviewDocumentWithMeta(
  text: string,
  documentType: string,
  stage?: CandidateStageInfo
): Promise<{ review: ReviewScore; provider: string; model: string }> {
  if (!text || text.trim().length === 0) {
    const err = new Error("The document contains no extractable text to review.");
    infoLog(`rejected empty text for documentType=${documentType}`);
    throw err;
  }

  const target = getReviewServiceUrl() ? "review-service" : getProvider();
  // Stage metadata is safe to log (no date of birth, no age, no document text).
  infoLog(
    `review started documentType=${documentType} textChars=${text.length} ` +
      `target=${target} model=${getModel(getProvider())} ` +
      `fallback=${process.env.AI_REVIEW_FALLBACK || "none"} ` +
      (stage
        ? `stage=${stage.stage} stageConfidence=${stage.confidence} stageBasis=${stage.basis} ageBand=${stage.ageBand} `
        : "stage=none ") +
      `textFingerprint=${fingerprint(text)}`
  );
  debugLog(`[review] text preview (300 chars): ${text.slice(0, 300).replace(/\s+/g, " ")}`);

  let result: { review: ReviewScore; provider: string; model: string };
  try {
    result = await callReviewService(text, documentType, stage);
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
  documentType: string,
  stage?: CandidateStageInfo
): Promise<ReviewScore> {
  const { review } = await reviewDocumentWithMeta(text, documentType, stage);
  return review;
}
