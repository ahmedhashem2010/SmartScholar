/**
 * AI review providers.
 *
 * The review used to be delegated to a separate service on Railway that held
 * the AgentRouter key. That service is gone, so the review runs in-process
 * instead: this module is the only place that talks to an upstream model.
 *
 * Three providers are supported over plain `fetch`:
 *   - agentrouter — AgentRouter gateway, the account's cheapest chat model
 *   - groq        (default) — fast, JSON mode, strong free tier
 *   - gemini      — larger context, structured output mode
 *
 * This module deliberately knows nothing about `ReviewScore` or SmartScholar's
 * error classes: it returns raw JSON and throws `ProviderError` tagged with a
 * `kind`. `ai-review.ts` validates the shape and maps the error into the
 * contract the API route already understands. That keeps the dependency
 * one-way (ai-review -> ai-providers) and avoids an import cycle.
 */

export type ProviderName = "groq" | "gemini" | "agentrouter";

/**
 * Why a provider call failed.
 *   config    — bad/missing key, unknown model, malformed request
 *   capacity  — rate limit, overloaded, out of quota  (retry later)
 *   upstream  — network error, timeout, 5xx
 *   malformed — the model answered, but not with usable JSON
 */
export type ProviderErrorKind = "config" | "capacity" | "upstream" | "malformed";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: ProviderName;
  constructor(kind: ProviderErrorKind, provider: ProviderName, message: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
  }
}

export interface ReviewProviderResult {
  /** Raw parsed JSON. Validation happens in ai-review.ts. */
  review: unknown;
  provider: ProviderName;
  model: string;
  /** Set when the configured primary provider was out of capacity. */
  fallbackFrom?: ProviderName;
}

/** Defaults per provider. `AI_REVIEW_MODEL` overrides any one of them. */
const DEFAULT_MODELS: Record<ProviderName, string> = {
  agentrouter: "deepseek-v4-flash",
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3-flash-preview",
};

/**
 * Groq's free tier meters 8k tokens/minute across the whole organization, so a
 * very long document can consume the entire window in one request. Truncating
 * the input keeps a review possible instead of failing outright; the prompt is
 * told the text was cut so it can say so rather than judge a partial document
 * as if it were complete.
 */
const DEFAULT_MAX_INPUT_CHARS = 16_000;

/**
 * Max output tokens per provider.
 *
 * AgentRouter's deepseek-v4-flash is a reasoning model: it emits hidden
 * reasoning before the JSON, and that amount varies run to run. At 3000 the
 * reasoning occasionally consumed the entire budget and the content came back
 * empty, so it gets room to think plus room to answer.
 *
 * Groq's free tier meters 8k tokens/minute, so its budget stays modest — a
 * larger one would make the *next* review hit the rate limit.
 */
const MAX_OUTPUT_TOKENS: Record<ProviderName, number> = {
  agentrouter: 6_000,
  groq: 3_000,
  gemini: 3_000,
};

export function getProvider(): ProviderName {
  const raw = (process.env.AI_PROVIDER || "groq").trim().toLowerCase();
  if (raw === "gemini") return "gemini";
  if (raw === "agentrouter") return "agentrouter";
  return "groq";
}

/** Provider to fall back to when the primary is out of capacity. "" = none. */
export function getFallbackProvider(): ProviderName | null {
  const raw = (process.env.AI_REVIEW_FALLBACK || "").trim().toLowerCase();
  if (raw === "none" || raw === "off") return null;
  if (!raw) {
    // Unset means "use the obvious safety net": if a Groq key is present, an
    // AgentRouter outage should cost review *quality*, not the whole review.
    // Set AI_REVIEW_FALLBACK=none to require a single provider.
    return getApiKey("groq") ? "groq" : null;
  }
  if (raw === "gemini") return "gemini";
  if (raw === "groq") return "groq";
  if (raw === "agentrouter") return "agentrouter";
  return null;
}

export function getModel(provider: ProviderName): string {
  const override = (process.env.AI_REVIEW_MODEL || "").trim();
  if (override) return override;
  // Legacy: the old Railway service used AGENTROUTER_MODEL. It named Claude
  // models that this gateway no longer serves, so only honour it when it looks
  // like a model the current provider can actually run.
  const legacy = (process.env.AGENTROUTER_MODEL || "").trim();
  if (legacy && !legacy.startsWith("claude-")) return legacy;
  return DEFAULT_MODELS[provider];
}

function getApiKey(provider: ProviderName): string {
  const key =
    provider === "groq"
      ? process.env.GROQ_API_KEY || process.env.AI_PROVIDER_API_KEY
      : provider === "gemini"
        ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.AI_PROVIDER_API_KEY
        : process.env.AGENTROUTER_API_KEY || process.env.AI_PROVIDER_API_KEY;
  return (key || "").trim();
}

function timeoutMs(): number {
  // Must stay below the route's 60s maxDuration so a fallback still has room
  // to run: 40s + a Groq answer (~3s) + saving the review fits with margin.
  const raw = Number(process.env.AI_REVIEW_TIMEOUT_MS || 40_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 40_000;
}

function maxInputChars(): number {
  const raw = Number(process.env.AI_MAX_INPUT_CHARS || DEFAULT_MAX_INPUT_CHARS);
  return Number.isFinite(raw) && raw > 500 ? raw : DEFAULT_MAX_INPUT_CHARS;
}

/** Cut on a word boundary so the tail isn't a half-word. */
function truncateInput(text: string): { text: string; truncated: boolean } {
  const limit = maxInputChars();
  if (text.length <= limit) return { text, truncated: false };
  const slice = text.slice(0, limit);
  const boundary = slice.lastIndexOf(" ");
  return {
    text: (boundary > limit * 0.8 ? slice.slice(0, boundary) : slice) + "\n\n[document truncated for length]",
    truncated: true,
  };
}

const DOCUMENT_GUIDANCE: Record<string, string> = {
  CV: `This is a CV / résumé. Weigh: whether the degree, GPA and graduation year are easy to find; whether experience bullets state results rather than duties; relevance of skills to the target programme; unexplained gaps or vague entries; ATS-friendliness (tables, columns, graphics, unusual headings).`,
  PERSONAL_STATEMENT: `This is a personal statement. Weigh: whether the opening states a specific goal rather than a platitude; whether claims are backed by concrete experience; a clear link between past work and the target programme; specificity about the university/programme; a coherent narrative; the ending's forward plan; clichés and filler.`,
  MOTIVATION_LETTER: `This is a motivation letter. Weigh: whether it addresses this specific programme and institution rather than any programme; evidence that the student understands what the programme teaches; a credible reason the student needs it; a clear contribution they can make; tone and length discipline.`,
  OTHER: `This is a miscellaneous application document. Judge clarity of purpose, structure, relevance to a scholarship application, and whether the reader can tell what it is for within the first paragraph.`,
};

export function buildReviewPrompt(text: string, documentType: string, truncated: boolean): string {
  const guidance = DOCUMENT_GUIDANCE[documentType] ?? DOCUMENT_GUIDANCE.OTHER;
  const language = (process.env.AI_REVIEW_LANGUAGE || "auto").trim().toLowerCase();
  const languageRule =
    language === "ar"
      ? "Write every piece of prose in Modern Standard Arabic. Keep technical terms, tool names and quoted phrases from the document in their original language."
      : language === "en"
        ? "Write every piece of prose in English."
        : "Write every piece of prose in the language the document is mainly written in. If the document mixes languages, use Arabic for the prose and keep quoted phrases in their original language.";

  return `You are the document reviewer inside SmartScholar, a free service that helps Arab and Middle Eastern students win international scholarships. A student uploaded one document and will act on your feedback. Tell them honestly and specifically how competitive it is and what to change before they submit it.

Rules:
- Judge only the text below. Never invent achievements, numbers or institutions that are not there.
- Be specific. Quote or paraphrase the actual line you mean. "Add more detail" is useless; "Your Aramex internship names the tool but not the result — say what the dashboard changed for those 40 staff" is useful.
- Be honest, not encouraging. A weak document gets a low score with clear reasons. Do not inflate.
- Never mention that you are an AI, and never address the reader as "the candidate" — write to the student.

Document type: ${documentType || "OTHER"}
${guidance}

Score three things, each an integer from 1 to 10. Calibration: 1-3 not submittable, 4-5 needs substantial work, 6-7 solid, 8-9 strong and competitive, 10 exceptional.

1. overallQuality — the document as a piece of writing and as evidence of the student's fit. Strengths and weaknesses must each name something concrete from the text.
2. atsCompatibility — how well this survives automated screening: standard section headings, parseable formatting, and the keywords a scholarship or admissions reader expects for the stated goal. Put the genuinely absent terms in missingKeywords; do not pad the list.
3. competitiveness — how this document compares with other applicants for a competitive international scholarship. Differentiation must be something only this student could claim.

Then produce:
- topImprovements: 3 to 5 items, ordered by impact, each one concrete enough to act on today.
- quickWins: 2 to 4 small fixes that take under ten minutes.
- overallAssessment: 2 to 4 sentences a student can read and understand without jargon.
- signatureCheck: whether this kind of document normally requires a signature, and whether this text shows evidence of one. status is SIGNED, NOT_SIGNED, UNCERTAIN or NOT_APPLICABLE. Note that text extraction usually drops images, so a scanned signature often cannot be seen — say so instead of guessing.

${languageRule}

Return ONLY a JSON object with exactly this shape — no prose, no markdown fences, no trailing commentary:
{
  "overallQuality": { "score": <integer 1-10>, "strengthsSummary": <string>, "weaknessesSummary": <string> },
  "atsCompatibility": { "score": <integer 1-10>, "missingKeywords": [<string>], "improvements": [<string>] },
  "competitiveness": { "score": <integer 1-10>, "uniqueStrengths": <string>, "differentiation": <string> },
  "topImprovements": [<string>],
  "quickWins": [<string>],
  "overallAssessment": <string>,
  "signatureCheck": { "required": <boolean>, "status": "<SIGNED|NOT_SIGNED|UNCERTAIN|NOT_APPLICABLE>", "note": <string> }
}
${truncated ? "\nNote: the document was cut off at a length limit. Judge what is present and say in overallAssessment that the end of the document was not reviewed." : ""}

DOCUMENT:
${text}`;
}

/**
 * Describe a 2xx response whose body is not JSON.
 *
 * A model that answers with prose is a malformed *answer*. An HTML page or an
 * empty body is the gateway (or a WAF/proxy in front of it) failing before the
 * model ever runs. Only the second case is worth retrying elsewhere, so this
 * helper also logs a short, sanitized preview — the preview is usually the only
 * way to tell a Cloudflare interstitial from a truncated response, and it never
 * contains a key.
 */
function describeNonJson(provider: string, res: Response, body: string): string {
  const contentType = res.headers.get("content-type") || "no content-type";
  const preview = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  console.error(
    `[ai-providers] ${provider} non-JSON body: status=${res.status} contentType=${contentType} ` +
      `bytes=${body.length} preview=${JSON.stringify(preview)}`
  );
  return `${provider} returned a non-JSON response (HTTP ${res.status}, ${contentType}, ${body.length} bytes).`;
}

/** Strip ```json fences and any leading prose a model may add defensively. */
function parseJsonLoose(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callGroq(prompt: string, model: string): Promise<unknown> {
  const key = getApiKey("groq");
  if (!key) {
    throw new ProviderError("config", "groq", "GROQ_API_KEY is missing from the server environment.");
  }

  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_completion_tokens: MAX_OUTPUT_TOKENS.groq,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError("upstream", "groq", `Groq timed out after ${timeoutMs()}ms.`);
    }
    throw new ProviderError("upstream", "groq", `Groq is unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await res.text().catch(() => "");

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("config", "groq", "Groq rejected the API key (HTTP " + res.status + ").");
    }
    if (res.status === 429) {
      throw new ProviderError("capacity", "groq", "Groq rate limit reached (HTTP 429).");
    }
    if (res.status === 400 || res.status === 404) {
      // Almost always a model id this account cannot serve.
      throw new ProviderError("config", "groq", `Groq rejected the request for model "${model}" (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    throw new ProviderError("upstream", "groq", `Groq returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  let payload: { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ProviderError("upstream", "groq", describeNonJson("Groq", res, body));
  }

  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    if (choice?.finish_reason === "length") {
      throw new ProviderError("capacity", "groq", "Groq used its entire output budget and returned no review.");
    }
    throw new ProviderError("malformed", "groq", "Groq returned an empty completion.");
  }
  const parsed = parseJsonLoose(content);
  if (parsed === null) {
    throw new ProviderError("malformed", "groq", "Groq returned text that is not valid JSON.");
  }
  return parsed;
}

/** Structured-output schema for Gemini (OpenAPI subset). */
const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    overallQuality: {
      type: "object",
      properties: {
        score: { type: "integer" },
        strengthsSummary: { type: "string" },
        weaknessesSummary: { type: "string" },
      },
      required: ["score", "strengthsSummary", "weaknessesSummary"],
    },
    atsCompatibility: {
      type: "object",
      properties: {
        score: { type: "integer" },
        missingKeywords: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } },
      },
      required: ["score", "missingKeywords", "improvements"],
    },
    competitiveness: {
      type: "object",
      properties: {
        score: { type: "integer" },
        uniqueStrengths: { type: "string" },
        differentiation: { type: "string" },
      },
      required: ["score", "uniqueStrengths", "differentiation"],
    },
    topImprovements: { type: "array", items: { type: "string" } },
    quickWins: { type: "array", items: { type: "string" } },
    overallAssessment: { type: "string" },
    signatureCheck: {
      type: "object",
      properties: {
        required: { type: "boolean" },
        status: { type: "string", enum: ["SIGNED", "NOT_SIGNED", "UNCERTAIN", "NOT_APPLICABLE"] },
        note: { type: "string" },
      },
      required: ["required", "status", "note"],
    },
  },
  required: [
    "overallQuality",
    "atsCompatibility",
    "competitiveness",
    "topImprovements",
    "quickWins",
    "overallAssessment",
  ],
} as const;

async function callGemini(prompt: string, model: string): Promise<unknown> {
  const key = getApiKey("gemini");
  if (!key) {
    throw new ProviderError("config", "gemini", "GEMINI_API_KEY is missing from the server environment.");
  }

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4_000,
            responseMimeType: "application/json",
            responseSchema: GEMINI_SCHEMA,
          },
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      }
    );
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError("upstream", "gemini", `Gemini timed out after ${timeoutMs()}ms.`);
    }
    throw new ProviderError("upstream", "gemini", `Gemini is unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await res.text().catch(() => "");

  if (!res.ok) {
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body)?.error?.message ?? message;
    } catch {
      /* keep raw */
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("config", "gemini", `Gemini rejected the API key (HTTP ${res.status}): ${message}`);
    }
    if (res.status === 429) {
      throw new ProviderError("capacity", "gemini", `Gemini quota exhausted (HTTP 429): ${message}`);
    }
    if (res.status === 400 || res.status === 404) {
      throw new ProviderError("config", "gemini", `Gemini rejected model "${model}" (HTTP ${res.status}): ${message}`);
    }
    if (res.status === 503) {
      throw new ProviderError("capacity", "gemini", `Gemini is overloaded (HTTP 503): ${message}`);
    }
    throw new ProviderError("upstream", "gemini", `Gemini returned HTTP ${res.status}: ${message}`);
  }

  let payload: {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ProviderError("upstream", "gemini", describeNonJson("Gemini", res, body));
  }

  const candidate = payload.candidates?.[0];
  const content = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!content) {
    const reason = candidate?.finishReason ?? "unknown";
    throw new ProviderError("malformed", "gemini", `Gemini returned no text (finishReason: ${reason}).`);
  }
  const parsed = parseJsonLoose(content);
  if (parsed === null) {
    throw new ProviderError("malformed", "gemini", "Gemini returned text that is not valid JSON.");
  }
  return parsed;
}

/**
 * AgentRouter (agentrouter.org) — an OpenAI-compatible gateway.
 *
 * Two quirks, both confirmed live:
 *   1. Auth is `x-api-key`, not `Authorization: Bearer` (Bearer gets 401
 *      "unauthorized client detected").
 *   2. The gateway fingerprints the client from Originator / User-Agent /
 *      Version. Wrong or missing values produce the same 401, which is
 *      indistinguishable from a bad key. The defaults mimic the Codex CLI and
 *      can be overridden without a code change.
 *
 * The account's model group decides what works: some models only serve
 * /v1/responses (they are too slow for a 60s serverless budget), so the default
 * is the chat-capable `deepseek-v4-flash`.
 */
function agentRouterHeaders(): Record<string, string> {
  return {
    "x-api-key": getApiKey("agentrouter"),
    Originator: process.env.AGENTROUTER_ORIGINATOR || "codex_cli_rs",
    "User-Agent": process.env.AGENTROUTER_USER_AGENT || "codex_cli_rs/0.101.0",
    Version: process.env.AGENTROUTER_VERSION || "0.101.0",
  };
}

/**
 * Optional relay base URL (`railway-agentrouter-relay`).
 *
 * AgentRouter's WAF answers Vercel's datacenter IPs with an HTML challenge page,
 * so production reaches it through a tiny relay whose egress it accepts. When
 * this is set, the relay owns the key and the fingerprint headers and the app
 * sends neither. Left unset, the app talks to the gateway directly, which is
 * what local development needs.
 */
function agentRouterRelayUrl(): string {
  return (process.env.AGENTROUTER_RELAY_URL || "").trim().replace(/\/+$/, "");
}

async function callAgentRouter(prompt: string, model: string): Promise<unknown> {
  const relay = agentRouterRelayUrl();

  if (!relay && !getApiKey("agentrouter")) {
    throw new ProviderError("config", "agentrouter", "AGENTROUTER_API_KEY is missing from the server environment.");
  }

  const base = relay || (process.env.AGENTROUTER_ENDPOINT || "https://agentrouter.org").replace(/\/+$/, "");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (relay) {
    const token = (process.env.AGENTROUTER_RELAY_TOKEN || "").trim();
    if (token) headers["x-relay-token"] = token;
  } else {
    Object.assign(headers, agentRouterHeaders());
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: MAX_OUTPUT_TOKENS.agentrouter,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const where = relay ? "The AgentRouter relay" : "AgentRouter";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError("upstream", "agentrouter", `${where} timed out after ${timeoutMs()}ms.`);
    }
    throw new ProviderError("upstream", "agentrouter", `${where} is unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await res.text().catch(() => "");

  if (!res.ok) {
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body)?.error?.message ?? message;
    } catch {
      /* keep raw */
    }
    if (res.status === 401 || res.status === 403) {
      if (relay) {
        throw new ProviderError(
          "config",
          "agentrouter",
          `The AgentRouter relay rejected the request (HTTP ${res.status}): ${message} ` +
            `Check that AGENTROUTER_RELAY_TOKEN matches RELAY_TOKEN on the relay.`
        );
      }
      const fingerprintIssue = /unauthorized client/i.test(message);
      throw new ProviderError(
        "config",
        "agentrouter",
        fingerprintIssue
          ? "AgentRouter rejected the client fingerprint (not the key). Its gateway requires the Originator/User-Agent/Version headers from AGENTROUTER_* env vars."
          : `AgentRouter rejected the API key (HTTP ${res.status}): ${message}`
      );
    }
    if (res.status === 429) {
      throw new ProviderError("capacity", "agentrouter", `AgentRouter rate limit reached (HTTP 429): ${message}`);
    }
    if (res.status === 400 || res.status === 404) {
      // Usually a model this account's group cannot serve, or one that only
      // serves /v1/responses.
      throw new ProviderError("config", "agentrouter", `AgentRouter rejected model "${model}" (HTTP ${res.status}): ${message}`);
    }
    throw new ProviderError("upstream", "agentrouter", `AgentRouter returned HTTP ${res.status}: ${message}`);
  }

  let payload: {
    choices?: {
      message?: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }[];
  };
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ProviderError("upstream", "agentrouter", describeNonJson("AgentRouter", res, body));
  }

  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // A reasoning model can spend the whole output budget thinking and then
    // have nothing left for the answer. That is capacity, not a bad answer:
    // retrying or using the fallback provider succeeds, whereas "malformed"
    // would wrongly blame the prompt. `finish_reason` is not reliable here —
    // the gateway sometimes reports "stop" — so reasoning output is the signal.
    const reasoned = Boolean(choice?.message?.reasoning_content);
    if (choice?.finish_reason === "length" || reasoned) {
      throw new ProviderError(
        "capacity",
        "agentrouter",
        "AgentRouter's model used its entire output budget on reasoning and returned no review."
      );
    }
    throw new ProviderError("malformed", "agentrouter", "AgentRouter returned an empty completion.");
  }
  const parsed = parseJsonLoose(content);
  if (parsed === null) {
    throw new ProviderError("malformed", "agentrouter", "AgentRouter returned text that is not valid JSON.");
  }
  return parsed;
}

async function callProvider(provider: ProviderName, text: string, documentType: string): Promise<ReviewProviderResult> {
  const { text: body, truncated } = truncateInput(text);
  const prompt = buildReviewPrompt(body, documentType, truncated);
  const model = getModel(provider);

  const review =
    provider === "gemini"
      ? await callGemini(prompt, model)
      : provider === "agentrouter"
        ? await callAgentRouter(prompt, model)
        : await callGroq(prompt, model);
  return { review, provider, model };
}

/**
 * Run the review on the configured provider.
 *
 * Fallback is single-hop and infrastructure-only (capacity or upstream) —
 * never for a bad key or for a model whose own answer is malformed, because
 * those are bugs that a second provider would silently paper over. It defaults
 * to Groq when `AI_REVIEW_FALLBACK` is unset and a Groq key exists; `none`
 * disables it. The caller records which provider and model actually produced
 * the review.
 */
export async function runReview(text: string, documentType: string): Promise<ReviewProviderResult> {
  const primary = getProvider();
  try {
    return await callProvider(primary, text, documentType);
  } catch (e) {
    const fallback = getFallbackProvider();
    const kind = e instanceof ProviderError ? e.kind : null;
    const eligible = kind === "capacity" || kind === "upstream";
    const canFallBack =
      fallback !== null &&
      fallback !== primary &&
      eligible &&
      Boolean(getApiKey(fallback));

    if (!canFallBack) {
      // A fallback that is configured but has no key is a deployment mistake.
      // Say so, instead of showing the primary's gateway error and leaving the
      // operator to guess why the safety net did not catch them.
      if (fallback !== null && fallback !== primary && eligible && !getApiKey(fallback)) {
        throw new ProviderError(
          "config",
          primary,
          `${e instanceof Error ? e.message : String(e)} ` +
            `(${fallback} is configured as the fallback provider but its API key is missing from the server environment.)`
        );
      }
      throw e;
    }

    console.warn(
      `[ai-providers] ${primary} failed (${kind}); falling back to ${fallback}`
    );
    const result = await callProvider(fallback, text, documentType);
    return { ...result, fallbackFrom: primary };
  }
}

/** True when at least one provider has a key configured. Used by diagnostics. */
export function hasAnyProviderKey(): boolean {
  return Boolean(getApiKey(getProvider()) || (getFallbackProvider() && getApiKey(getFallbackProvider()!)));
}
