/**
 * AgentRouter relay — a transparent proxy, nothing more.
 *
 * Why this exists: agentrouter.org sits behind a WAF that answers requests
 * coming from Vercel's datacenter IPs with an HTML challenge page (HTTP 200,
 * text/html). Requests from a residential IP work fine, and Railway's egress
 * was accepted for months, so this tiny service is deployed there instead.
 *
 * What it does NOT do: it has no prompt, no schema, no retries and no model
 * knowledge. The Next.js app still builds the prompt and validates the review;
 * this only adds the credentials and the client-fingerprint headers AgentRouter
 * requires, then returns the upstream response byte for byte — including error
 * bodies and content types, so the app's existing classification still applies.
 *
 * Endpoints:
 *   GET  /health                 → { ok, upstream, configured }
 *   POST /v1/chat/completions    → forwarded to AgentRouter unchanged
 *
 * Environment:
 *   AGENTROUTER_API_KEY    (required) the gateway key — lives ONLY here
 *   RELAY_TOKEN            (strongly recommended) shared secret; when set, the
 *                          caller must send it as `x-relay-token`
 *   AGENTROUTER_ENDPOINT   default https://agentrouter.org
 *   AGENTROUTER_ORIGINATOR / _USER_AGENT / _VERSION   fingerprint headers
 *   UPSTREAM_TIMEOUT_MS    default 120000
 *
 * No dependencies: this runs on Node 20+ alone, so the image stays small and
 * there is no lockfile to rot.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3000);
const ENDPOINT = (process.env.AGENTROUTER_ENDPOINT || "https://agentrouter.org").replace(/\/+$/, "");
const API_KEY = (process.env.AGENTROUTER_API_KEY || "").trim();
const RELAY_TOKEN = (process.env.RELAY_TOKEN || "").trim();
const ORIGINATOR = process.env.AGENTROUTER_ORIGINATOR || "codex_cli_rs";
const USER_AGENT = process.env.AGENTROUTER_USER_AGENT || "codex_cli_rs/0.101.0";
const VERSION = process.env.AGENTROUTER_VERSION || "0.101.0";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000);
const MAX_BODY_BYTES = 512 * 1024;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    // Deliberately says whether the key is configured, never what it is.
    return sendJson(res, 200, {
      ok: true,
      service: "agentrouter-relay",
      upstream: ENDPOINT,
      configured: Boolean(API_KEY),
      tokenRequired: Boolean(RELAY_TOKEN),
    });
  }

  if (url.pathname !== "/v1/chat/completions") {
    return sendJson(res, 404, {
      error: { message: "Not found. POST /v1/chat/completions" },
    });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: { message: "Use POST." } });
  }

  if (!API_KEY) {
    log("rejected: AGENTROUTER_API_KEY is not set");
    return sendJson(res, 500, {
      error: { message: "Relay is not configured: AGENTROUTER_API_KEY is missing." },
    });
  }

  if (RELAY_TOKEN && req.headers["x-relay-token"] !== RELAY_TOKEN) {
    log("rejected: bad or missing x-relay-token");
    return sendJson(res, 401, {
      error: { message: "Invalid or missing x-relay-token." },
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: { message: e.message } });
  }

  const started = Date.now();
  try {
    const upstream = await fetch(`${ENDPOINT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        Originator: ORIGINATOR,
        "User-Agent": USER_AGENT,
        Version: VERSION,
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const text = await upstream.text();
    const ms = Date.now() - started;
    const contentType = upstream.headers.get("content-type") || "application/json";
    log(`forwarded status=${upstream.status} bytes=${text.length} ms=${ms}`);

    // Forward verbatim: the app classifies JSON vs HTML vs empty itself, and
    // its logs need the real status and content type.
    res.writeHead(upstream.status, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    res.end(text);
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    const ms = Date.now() - started;
    log(`upstream failure name=${e?.name} ms=${ms}: ${e?.message}`);
    sendJson(res, timeout ? 504 : 502, {
      error: {
        message: timeout
          ? `AgentRouter timed out after ${UPSTREAM_TIMEOUT_MS}ms.`
          : `AgentRouter unreachable: ${e?.message || String(e)}`,
      },
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  log(`agentrouter relay listening on :${PORT}`);
  log(`upstream=${ENDPOINT} keyConfigured=${Boolean(API_KEY)} tokenRequired=${Boolean(RELAY_TOKEN)}`);
  if (!API_KEY) log("WARNING: AGENTROUTER_API_KEY is missing — every request will fail with 500.");
  if (!RELAY_TOKEN) log("WARNING: RELAY_TOKEN is unset — the relay is open to anyone who finds the URL.");
});
