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

import {
  assumptionNote,
  stageLabel,
  toPromptStage,
  type CandidateStage,
  type CandidateStageInfo,
} from "@/lib/candidate-stage";

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
  // The stage-aware prompt asks for eight rated criteria plus prose, so the
  // answer is longer than the old three-score response. Reasoning still comes
  // out of this same budget; 6000 occasionally left nothing for the JSON.
  agentrouter: 8_000,
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
  // AI_REVIEW_MODEL names the *primary* provider's model. Applying it to a
  // fallback provider sends an id that provider has never heard of (AgentRouter's
  // deepseek id to Groq answers 404), so the fallback would fail exactly when it
  // is needed. Fallbacks use their own default unless AI_REVIEW_MODEL is scoped
  // to them by the primary being the same provider.
  const override = (process.env.AI_REVIEW_MODEL || "").trim();
  if (override && provider === getProvider()) return override;
  // Legacy: the old Railway service used AGENTROUTER_MODEL. It named Claude
  // models that this gateway no longer serves, so only honour it when it looks
  // like a model the current provider can actually run.
  const legacy = (process.env.AGENTROUTER_MODEL || "").trim();
  if (provider === "agentrouter" && legacy && !legacy.startsWith("claude-")) return legacy;
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
  // Must stay below the route's 60s maxDuration. The stage-aware prompt asks
  // for eight rated criteria plus prose, so answers are longer than the old
  // three-score response and 40s occasionally timed out on a reasoning model.
  // 50s leaves room to save the review; a configured fallback would need its
  // own headroom, which is why production uses AI_REVIEW_FALLBACK=none.
  const raw = Number(process.env.AI_REVIEW_TIMEOUT_MS || 50_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
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

export function buildReviewPrompt(
  text: string,
  documentType: string,
  truncated: boolean,
  stage?: CandidateStageInfo
): string {
  const guidance = DOCUMENT_GUIDANCE[documentType] ?? DOCUMENT_GUIDANCE.OTHER;
  const language = (process.env.AI_REVIEW_LANGUAGE || "auto").trim().toLowerCase();
  const languageRule =
    language === "ar"
      ? "Write every piece of prose in Modern Standard Arabic. Keep technical terms, tool names and quoted phrases from the document in their original language."
      : language === "en"
        ? "Write every piece of prose in English."
        : "Write every piece of prose in the language the document is mainly written in. If the document mixes languages, use Arabic for the prose and keep quoted phrases in their original language.";

  const stageBlock = stage ? buildStageBlock(stage) : NEUTRAL_STAGE_BLOCK;

  return `You are the document reviewer inside SmartScholar, a free service that helps Arab and Middle Eastern students win international scholarships. A student uploaded one document and will act on your feedback. Tell them honestly and specifically how competitive it is and what to change before they submit it.

Rules:
- Judge only the text below. Never invent achievements, numbers or institutions that are not there.
- Be specific. Quote or paraphrase the actual line you mean. "Add more detail" is useless; "Your Aramex internship names the tool but not the result — say what the dashboard changed for those 40 staff" is useful.
- Be honest, not encouraging. A weak document gets a low score with clear reasons. Do not inflate.
- Never mention that you are an AI, and never address the reader as "the candidate" — write to the student.

Document type: ${documentType || "OTHER"}
${guidance}

${stageBlock}

How to rate:
Rate eight criteria, each an integer from 1 to 10, calibrated to the applicant stage above — not to an elite graduate applicant. Every rating needs a justification that quotes or closely paraphrases a specific line from the document. If you cannot point at a line, the rating is not justified.

- objectiveFocus: is the goal (degree, field, programme type) stated and consistently pursued?
- evidenceOutcomes: claims backed by concrete results, numbers, scope or duration — not duties.
- relevanceToTarget: how much of the content supports the stated objective and target field.
- depthAndContribution: how deep the work goes and what the student personally did, versus observation or membership.
- leadershipInitiative: responsibility, initiative and follow-through appropriate to the stage.
- skillsEvidence: skills demonstrated through use rather than listed as keywords.
- writingClarity: structure, concision, grammar, and whether a reader can skim it.
- atsReadability: standard headings, parseable layout, and terms a scholarship or admissions reader expects for the stated goal.

Then produce:
- ats.missingKeywords: genuinely absent terms that matter for the stated objective AND are realistic at this stage. Do not pad, and do not ask a high schooler for graduate-level credentials.
- ats.improvements: 1 to 3 concrete formatting/parsing fixes.
- overallQuality.strengthsSummary / weaknessesSummary: each must name something concrete from the text.
- competitiveness.uniqueStrengths / differentiation: what this student could claim that other applicants for the same goal could not. Differentiation must be specific to this document.
- topImprovements: at most 5 items, ordered by severity — high, then medium, then polish. Label each "high", "medium" or "polish". If the major gaps are already addressed, label the remaining items "polish" and do not let them dominate. Never list the same fact twice under different labels.
- quickWins: 2 to 4 fixes that take under ten minutes.
- overallAssessment: 2 to 4 sentences a student can read without jargon. If the stage was assumed, include the assumption note.
- signatureCheck: whether this kind of document normally requires a signature, and whether the text shows evidence of one. Note that text extraction usually drops images, so a scanned signature often cannot be seen — say so instead of guessing.

Stage rules you must not break:
- The stage expectations are part of the rating, not just the prose. Reflect missing stage-level evidence in the relevant criteria instead of only mentioning it in the summary.
- Judge against the stated stage only. Never penalise a high schooler for lacking publications, preprints, internships, work experience or conference talks.
- Never suggest missing keywords that are unrealistic at this stage or unrelated to the student's stated objective.
- Never recommend inventing, inflating or embellishing achievements. If evidence is thin, recommend how to document real work — scope, result, what changed — or which accessible next step to take.
- Treat every claim as self-reported. Do not penalise the absence of attached certificates or transcripts.
- Do not move the goalposts: do not raise the bar after the student meets it, and do not let a minor style issue outweigh a real gap.
- If a criticism could be pasted under any other CV, rewrite it until it could only belong to this one.

${languageRule}

Return ONLY a JSON object with exactly this shape — no prose, no markdown fences, no trailing commentary:
{
  "criteria": {
    "objectiveFocus": { "rating": <integer 1-10>, "justification": <string> },
    "evidenceOutcomes": { "rating": <integer 1-10>, "justification": <string> },
    "relevanceToTarget": { "rating": <integer 1-10>, "justification": <string> },
    "depthAndContribution": { "rating": <integer 1-10>, "justification": <string> },
    "leadershipInitiative": { "rating": <integer 1-10>, "justification": <string> },
    "skillsEvidence": { "rating": <integer 1-10>, "justification": <string> },
    "writingClarity": { "rating": <integer 1-10>, "justification": <string> },
    "atsReadability": { "rating": <integer 1-10>, "justification": <string> }
  },
  "ats": { "missingKeywords": [<string>], "improvements": [<string>] },
  "overallQuality": { "strengthsSummary": <string>, "weaknessesSummary": <string> },
  "competitiveness": { "uniqueStrengths": <string>, "differentiation": <string> },
  "topImprovements": [{ "severity": "<high|medium|polish>", "text": <string> }],
  "quickWins": [<string>],
  "overallAssessment": <string>,
  "signatureCheck": { "required": <boolean>, "status": "<SIGNED|NOT_SIGNED|UNCERTAIN|NOT_APPLICABLE>", "note": <string> }
}
${truncated ? "\nNote: the document was cut off at a length limit. Judge what is present and say in overallAssessment that the end of the document was not reviewed." : ""}

DOCUMENT:
${text}`;
}

/**
 * Stage-specific expectations. These are expectations, not quotas: "participation
 * with a clear role" is enough at Grade 11-12, and winning is never required.
 * The scale anchors are part of the rubric the product committed to; they are
 * not a per-fixture answer key.
 */
function stageExpectations(stage: CandidateStage): string {
  switch (stage) {
    case "high_school_g10":
      return `Expect strong basics and curiosity. School-level or beginner participation is completely fine: a school club, one small project, an online course, a first competition entry. Do NOT expect awards, research, publications or external recognition. Anything missing is a low-severity "next step", not a failure.`;
    case "high_school_g11":
    case "high_school_g12":
      return `Expect some initiative beyond school coursework: at least one competition, olympiad, summer/enrichment programme, hackathon, certification, research or mentored project, or a real-world project with an outcome. Winning is NOT required — participation with a clear role is enough. If none exists, flag it as a medium-severity gap with concrete, accessible suggestions (name kinds of programmes and competitions), not a harsh penalty. Do not expect internships, publications or work experience.`;
    case "undergraduate":
      return `Expect sustained projects or internships, some leadership, and measurable outcomes. Coursework alone is not enough at this stage, but one serious project with a real result outweighs five club memberships.`;
    case "masters":
      return `Expect relevant degree-level coursework depth, research or thesis experience, internships or work experience, and publications or technical output where the field expects them. Look for a clear research or career focus that explains why this programme. A CV whose strongest evidence is school projects, school competitions or secondary coursework does NOT meet this bar, even if it is excellent for a high-schooler: without degree-level coursework, research/thesis work, an internship or work experience, evidenceOutcomes and depthAndContribution cannot exceed 5, and competitiveness cannot exceed 6. Say plainly which of those is missing.`;
    case "phd_or_professional":
      return `Expect a research track record: publications or equivalent output, advanced specialisation, and evidence strong enough for academic references. Absence of these is a real gap at this stage.`;
  }
}

function buildStageBlock(stage: CandidateStageInfo): string {
  const json = JSON.stringify(toPromptStage(stage), null, 2);
  const assumed =
    stage.confidence === "low"
      ? `\nThe stage was assumed, not known. Include this line verbatim in overallAssessment: "${assumptionNote(stage)}"`
      : "";
  return `APPLICANT STAGE — ${stageLabel(stage.stage)} (derived from the student's profile; use it as given and never re-derive or change it from the document).
${json}

What is expected at this stage:
${stageExpectations(stage.stage)}

Scale anchors for this stage:
- A document that meets the expectations above with a focused objective, specific evidence and at least one relevant external activity should score 8-9.
- A solid, complete but generic document — clear education, some projects or activities, no standout result — should score 5-6. Do not push it into the vague band just because it is not distinctive.
- A vague, evidence-free document should score 2-4.
Do not cap a strong high-school document at 7 because it is not graduate-level.${assumed}`;
}

/**
 * Used only when a caller has no profile stage (e.g. an internal tool). The
 * route always passes one; this keeps the function total and the prompt honest
 * rather than inventing a stage.
 */
const NEUTRAL_STAGE_BLOCK = `APPLICANT STAGE: not provided.
Do not assume a stage. If the document states its objective, judge against that objective and say in overallAssessment that a stage-specific review needs an updated profile. Do not penalise missing graduate-level credentials you cannot confirm are expected.`;

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
function describeNonJson(provider: string, res: Response, body: string, endpoint?: string): string {
  const contentType = res.headers.get("content-type") || "no content-type";
  const preview = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  console.error(
    `[ai-providers] ${provider} non-JSON body: status=${res.status} contentType=${contentType} ` +
      `bytes=${body.length} endpoint=${endpoint || "unknown"} preview=${JSON.stringify(preview)}`
  );
  // Naming the endpoint matters: the same WAF page comes back from the gateway
  // whether the call left from Vercel or from the relay, and this is the only
  // thing in the error that says which route was actually used.
  return (
    `${provider} returned a non-JSON response (HTTP ${res.status}, ${contentType}, ${body.length} bytes)` +
    (endpoint ? ` from ${endpoint}.` : ".")
  );
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
        temperature: 0,
        seed: 7,
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
const CRITERION_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "integer" },
    justification: { type: "string" },
  },
  required: ["rating", "justification"],
} as const;

const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "object",
      properties: {
        objectiveFocus: CRITERION_SCHEMA,
        evidenceOutcomes: CRITERION_SCHEMA,
        relevanceToTarget: CRITERION_SCHEMA,
        depthAndContribution: CRITERION_SCHEMA,
        leadershipInitiative: CRITERION_SCHEMA,
        skillsEvidence: CRITERION_SCHEMA,
        writingClarity: CRITERION_SCHEMA,
        atsReadability: CRITERION_SCHEMA,
      },
      required: [
        "objectiveFocus",
        "evidenceOutcomes",
        "relevanceToTarget",
        "depthAndContribution",
        "leadershipInitiative",
        "skillsEvidence",
        "writingClarity",
        "atsReadability",
      ],
    },
    ats: {
      type: "object",
      properties: {
        missingKeywords: { type: "array", items: { type: "string" } },
        improvements: { type: "array", items: { type: "string" } },
      },
      required: ["missingKeywords", "improvements"],
    },
    overallQuality: {
      type: "object",
      properties: {
        strengthsSummary: { type: "string" },
        weaknessesSummary: { type: "string" },
      },
      required: ["strengthsSummary", "weaknessesSummary"],
    },
    competitiveness: {
      type: "object",
      properties: {
        uniqueStrengths: { type: "string" },
        differentiation: { type: "string" },
      },
      required: ["uniqueStrengths", "differentiation"],
    },
    topImprovements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "polish"] },
          text: { type: "string" },
        },
        required: ["severity", "text"],
      },
    },
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
    "criteria",
    "ats",
    "overallQuality",
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
            temperature: 0,
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
        // Greedy decoding: the same CV should produce the same ratings. The
        // score weights remove drift in the arithmetic; this removes most of it
        // in the ratings themselves.
        temperature: 0,
        seed: 7,
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
    throw new ProviderError("upstream", "agentrouter", describeNonJson("AgentRouter", res, body, base));
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
    // Gated: model prose can quote the student's document. Off in production.
    if (process.env.AI_DEBUG === "true") {
      console.error("[ai-providers] AgentRouter non-JSON content preview:", content.slice(0, 500));
    }
    throw new ProviderError("malformed", "agentrouter", "AgentRouter returned text that is not valid JSON.");
  }
  return parsed;
}

async function callProvider(
  provider: ProviderName,
  text: string,
  documentType: string,
  stage?: CandidateStageInfo
): Promise<ReviewProviderResult> {
  const { text: body, truncated } = truncateInput(text);
  const prompt = buildReviewPrompt(body, documentType, truncated, stage);
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
export async function runReview(
  text: string,
  documentType: string,
  stage?: CandidateStageInfo
): Promise<ReviewProviderResult> {
  const primary = getProvider();
  try {
    return await callProvider(primary, text, documentType, stage);
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
    const result = await callProvider(fallback, text, documentType, stage);
    return { ...result, fallbackFrom: primary };
  }
}

/** True when at least one provider has a key configured. Used by diagnostics. */
export function hasAnyProviderKey(): boolean {
  return Boolean(getApiKey(getProvider()) || (getFallbackProvider() && getApiKey(getFallbackProvider()!)));
}
