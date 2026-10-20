import "./_env.mjs";

/**
 * AgentRouter diagnostic — lists what the account's model group actually
 * serves, then runs one real chat completion with the configured model.
 *
 *   node scripts/test-agentrouter.mjs
 *
 * Two gateway behaviours this script exists to prove, because both fail with a
 * bare 401 that looks like "bad key":
 *   1. Auth is `x-api-key`, not `Authorization: Bearer`.
 *   2. The gateway fingerprints the client. Originator / User-Agent / Version
 *      must be present or every request is rejected as
 *      "unauthorized client detected".
 *
 * Model groups differ per account, and some models only serve
 * /v1/responses — which is too slow for the app's 60s serverless budget. The
 * model list below tells you which ones this key can actually run.
 *
 * Reads nothing from the database and writes nothing anywhere.
 */

const KEY = process.env.AGENTROUTER_API_KEY || "";
const BASE = (process.env.AGENTROUTER_ENDPOINT || "https://agentrouter.org").replace(/\/+$/, "");
const MODEL = process.env.AI_REVIEW_MODEL || "deepseek-v4-flash";

const HEADERS = {
  "x-api-key": KEY,
  Originator: process.env.AGENTROUTER_ORIGINATOR || "codex_cli_rs",
  "User-Agent": process.env.AGENTROUTER_USER_AGENT || "codex_cli_rs/0.101.0",
  Version: process.env.AGENTROUTER_VERSION || "0.101.0",
};

function ok(m) { console.log(`  \x1b[32m✓\x1b[0m ${m}`); }
function bad(m) { console.log(`  \x1b[31m✗\x1b[0m ${m}`); }
function info(m) { console.log(`    ${m}`); }

function clean(s) {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function listModels() {
  try {
    const res = await fetch(`${BASE}/v1/models`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    if (!res.ok) {
      bad(`GET /v1/models — HTTP ${res.status}`);
      info(clean(body));
      if (res.status === 401) {
        info("401 here usually means the fingerprint headers are wrong, not the key.");
      }
      return false;
    }
    const models = JSON.parse(body).data ?? [];
    ok(`GET /v1/models — ${models.length} model(s) available to this key`);
    for (const m of models) {
      info(`${m.id}  [${(m.supported_endpoint_types ?? []).join(", ")}]`);
    }
    if (!models.some((m) => m.id === MODEL)) {
      info(`\nNote: "${MODEL}" is not in the list above — set AI_REVIEW_MODEL to one that is.`);
    }
    return true;
  } catch (e) {
    bad(`GET /v1/models — ${e.message}`);
    return false;
  }
}

async function chat() {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...HEADERS },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: 'Return ONLY this JSON: {"ok": true, "model_works": true}',
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.text();
    const ms = Date.now() - started;

    if (!res.ok) {
      bad(`POST /v1/chat/completions — HTTP ${res.status} (${ms}ms)`);
      info(clean(body));
      if (res.status === 401) info("Check the fingerprint headers; this is usually not the key.");
      if (res.status === 400) info("The model may only serve /v1/responses, or your group has no channel for it.");
      if (res.status === 429) info("Rate limited — the key works; try again shortly.");
      return false;
    }

    const p = JSON.parse(body);
    const content = p.choices?.[0]?.message?.content ?? "";
    const reasoning = p.choices?.[0]?.message?.reasoning_content ?? "";
    if (!content) {
      bad(`HTTP 200 but the completion is empty (${ms}ms, reasoning ${reasoning.length} chars)`);
      info("A reasoning model spent its whole output budget thinking. Raise max_tokens.");
      return false;
    }
    ok(`POST /v1/chat/completions — working in ${ms}ms`);
    info(`model=${p.model ?? MODEL} reply=${clean(content)}`);
    if (reasoning) info(`hidden reasoning: ${reasoning.length} chars (normal for deepseek-v4-flash)`);
    return true;
  } catch (e) {
    bad(`POST /v1/chat/completions — ${e.name}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`AgentRouter diagnostic (${BASE})\n`);

  if (!KEY) {
    bad("AGENTROUTER_API_KEY not set in .env");
    info("Get a key at https://agentrouter.org and add it to .env + Vercel.");
    process.exitCode = 1;
    return;
  }

  info(`model: ${MODEL}\n`);
  const listed = await listModels();
  console.log();
  const worked = await chat();

  if (!listed || !worked) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
