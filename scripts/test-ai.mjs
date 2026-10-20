import "./_env.mjs";

/**
 * Checks whether document reviews can actually run.
 *
 *   node scripts/test-ai.mjs
 *
 * Two paths, same priority as src/lib/ai-review.ts:
 *
 *   1. If AI_REVIEW_SERVICE_URL is set, POST a sample to {URL}/review and
 *      expect a ReviewScore back. (Optional — the old Railway service is gone.)
 *   2. Otherwise call the in-process provider directly (AI_PROVIDER = groq |
 *      gemini) and check that it answers with valid JSON in the ReviewScore
 *      shape. This is the default path.
 *
 * The request here is intentionally tiny: it answers "is the key/model/network
 * working?", not "is the review prompt good?". Review quality is exercised by
 * src/lib/__tests__/ai-review.test.ts.
 *
 * Reads nothing from the database and writes nothing anywhere.
 */

const SERVICE_URL = (process.env.AI_REVIEW_SERVICE_URL || "").trim();
const RAW_PROVIDER = (process.env.AI_PROVIDER || "groq").trim().toLowerCase();
const PROVIDER = RAW_PROVIDER === "gemini" || RAW_PROVIDER === "agentrouter" ? RAW_PROVIDER : "groq";
const DEFAULT_MODEL =
  PROVIDER === "groq" ? "openai/gpt-oss-120b" : PROVIDER === "gemini" ? "gemini-3-flash-preview" : "deepseek-v4-flash";
const MODEL = (process.env.AI_REVIEW_MODEL || "").trim() || DEFAULT_MODEL;
const KEY =
  (PROVIDER === "groq"
    ? process.env.GROQ_API_KEY
    : PROVIDER === "gemini"
      ? process.env.GEMINI_API_KEY
      : process.env.AGENTROUTER_API_KEY) || "";

const TINY_DOC = `CV — Sample Student
BSc Computer Science, University of Jordan, 2025, GPA 3.6/4.0
Intern, Aramex (2024): built an internal dashboard used by 40 staff.
Skills: Python, SQL, React.`;

const SHAPE = `{"overallQuality":{"score":1-10,"strengthsSummary":"...","weaknessesSummary":"..."},"atsCompatibility":{"score":1-10,"missingKeywords":["..."],"improvements":["..."]},"competitiveness":{"score":1-10,"uniqueStrengths":"...","differentiation":"..."},"topImprovements":["..."],"quickWins":["..."],"overallAssessment":"..."}`;

const PROMPT = `Review this CV for a scholarship application. Return ONLY JSON in this shape: ${SHAPE}\n\n${TINY_DOC}`;

function ok(m) { console.log(`  \x1b[32m✓\x1b[0m ${m}`); }
function bad(m) { console.log(`  \x1b[31m✗\x1b[0m ${m}`); }
function info(m) { console.log(`    ${m}`); }

function isReviewScore(s) {
  const inRange = (n) => typeof n === "number" && n >= 1 && n <= 10;
  return (
    s &&
    typeof s === "object" &&
    inRange(s.overallQuality?.score) &&
    inRange(s.atsCompatibility?.score) &&
    inRange(s.competitiveness?.score) &&
    Array.isArray(s.topImprovements)
  );
}

function parseJsonLoose(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

async function testService() {
  console.log(`External review service: ${SERVICE_URL}/review\n`);
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${SERVICE_URL}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentType: "CV", text: TINY_DOC }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    bad(`network error: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const body = await res.text();
  const ms = Date.now() - started;

  if (!res.ok) {
    bad(`HTTP ${res.status} after ${ms}ms`);
    try { info(JSON.parse(body).message || body.slice(0, 300)); } catch { info(body.replace(/\s+/g, " ").slice(0, 300)); }
    if (res.status === 401 || res.status === 403) info("The service rejects SmartScholar — check its auth config.");
    if (res.status === 404) info("404 usually means the deployment was deleted. Clear AI_REVIEW_SERVICE_URL to use the in-process provider.");
    process.exitCode = 1;
    return;
  }

  const parsed = parseJsonLoose(body);
  if (!isReviewScore(parsed)) {
    bad(`HTTP 200 but the body is not a valid ReviewScore (missing 1–10 sub-scores)`);
    process.exitCode = 1;
    return;
  }
  ok(`working — ${ms}ms`);
  info(`overall=${parsed.overallQuality.score} ats=${parsed.atsCompatibility.score} competitive=${parsed.competitiveness.score}`);
}

async function testProvider() {
  console.log(`In-process provider: ${PROVIDER} · model ${MODEL}\n`);

  if (!KEY) {
    bad(`${PROVIDER === "groq" ? "GROQ_API_KEY" : PROVIDER === "gemini" ? "GEMINI_API_KEY" : "AGENTROUTER_API_KEY"} is not set in .env`);
    info("Get a free key: groq.com/keys  ·  aistudio.google.com/apikey  ·  agentrouter.org");
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  let res;
  try {
    if (PROVIDER === "groq") {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_completion_tokens: 2500,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: PROMPT }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } else if (PROVIDER === "agentrouter") {
      // x-api-key + client fingerprint headers; Bearer is answered with 401.
      const base = (process.env.AGENTROUTER_ENDPOINT || "https://agentrouter.org").replace(/\/+$/, "");
      res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY,
          Originator: process.env.AGENTROUTER_ORIGINATOR || "codex_cli_rs",
          "User-Agent": process.env.AGENTROUTER_USER_AGENT || "codex_cli_rs/0.101.0",
          Version: process.env.AGENTROUTER_VERSION || "0.101.0",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: 2500,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: PROMPT }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } else {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: PROMPT }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2500, responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(60_000),
        }
      );
    }
  } catch (e) {
    bad(`network error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const body = await res.text();
  const ms = Date.now() - started;

  if (!res.ok) {
    bad(`HTTP ${res.status} after ${ms}ms`);
    let msg = body;
    try { msg = JSON.parse(body).error?.message || msg; } catch { /* keep raw */ }
    info(String(msg).replace(/\s+/g, " ").slice(0, 300));
    if (res.status === 401 || res.status === 403) info("The API key was rejected — rotate it and update .env + Vercel.");
    if (res.status === 404) info(`Model "${MODEL}" is not available to this account. Change AI_REVIEW_MODEL.`);
    if (res.status === 429) info("Rate limited — the key works, but this account is out of capacity right now.");
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(body);
  const content =
    PROVIDER === "gemini"
      ? payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("")
      : payload.choices?.[0]?.message?.content;

  const parsed = parseJsonLoose(content ?? "");
  if (!isReviewScore(parsed)) {
    bad(`HTTP 200 but the model did not return a valid ReviewScore`);
    info(String(content).replace(/\s+/g, " ").slice(0, 300));
    process.exitCode = 1;
    return;
  }

  ok(`working — ${ms}ms`);
  info(`overall=${parsed.overallQuality.score} ats=${parsed.atsCompatibility.score} competitive=${parsed.competitiveness.score}`);
}

async function main() {
  console.log("AI document review\n");
  if (SERVICE_URL) await testService();
  else await testProvider();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
