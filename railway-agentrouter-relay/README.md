# AgentRouter relay

A ~200-line, dependency-free proxy that lets the Vercel deployment use
AgentRouter.

## Why it exists

`agentrouter.org` sits behind a WAF that answers requests from **Vercel's
datacenter IPs** with an HTML challenge page (`HTTP 200`, `text/html`). The same
request from a residential IP works. Railway's egress was accepted for months
by the previous deployment, so the relay lives there.

It is deliberately dumb: no prompt, no schema, no retries, no model list. The
Next.js app still builds the prompt and validates the review. The relay adds
the AgentRouter credentials and client-fingerprint headers and returns the
upstream response **byte for byte** — including error bodies and content types —
so the app's own error classification and fallback still work.

```
Vercel (Next.js)  ──POST /v1/chat/completions──▶  Railway relay  ──▶  agentrouter.org
  prompt + model                                    adds x-api-key
  validates JSON                                    + fingerprint headers
```

## Deploy on Railway

1. **New Project** → *Deploy from a GitHub repo* → `ahmedhashem2010/SmartScholar`.
2. Open the service → **Settings** → **Root Directory** → `railway-agentrouter-relay`.
   (Railway must build only this folder; the Next.js app belongs to Vercel.)
3. **Variables** → add:

   | Variable | Value |
   |---|---|
   | `AGENTROUTER_API_KEY` | your `sk-...` gateway key |
   | `RELAY_TOKEN` | a long random string, e.g. `openssl rand -hex 32` |

   Optional: `AGENTROUTER_ORIGINATOR`, `AGENTROUTER_USER_AGENT`,
   `AGENTROUTER_VERSION`, `UPSTREAM_TIMEOUT_MS` (default 120000).
4. **Settings → Networking → Generate Domain**. Copy the URL.
5. Verify:

   ```bash
   curl https://<your-domain>/health
   # {"ok":true,"service":"agentrouter-relay","configured":true,"tokenRequired":true}
   ```

Failure modes worth knowing:

- `/health` shows `configured:false` → the key variable did not land on the service.
- `401 Invalid or missing x-relay-token` → `RELAY_TOKEN` on Railway and
  `AGENTROUTER_RELAY_TOKEN` in Vercel do not match.
- `504 AgentRouter timed out` → the gateway is slow; the app's own 40s timeout
  usually fires first.

## Wire it into Vercel

| Variable | Value |
|---|---|
| `AGENTROUTER_RELAY_URL` | the Railway domain, e.g. `https://agentrouter-relay.up.railway.app` |
| `AGENTROUTER_RELAY_TOKEN` | same value as `RELAY_TOKEN` |
| `AI_PROVIDER` | `agentrouter` |
| `AI_REVIEW_MODEL` | `deepseek-v4-flash` |

Then redeploy the Vercel app (environment changes only apply to a new build).

Leave `AGENTROUTER_API_KEY` **out of Vercel** when the relay is in use — only
the relay needs it. With `AGENTROUTER_RELAY_URL` set, the app sends no key and
no fingerprint headers; the relay owns both.

## Security

- The relay is a public URL that spends your AgentRouter credits. Always set
  `RELAY_TOKEN`; without it the server logs a warning and accepts anyone.
- It only accepts `POST /v1/chat/completions`, caps bodies at 512 KB, and never
  echoes the API key.
- The key is never logged. Upstream status, byte counts and latency are.

## Run locally

```bash
cd railway-agentrouter-relay
AGENTROUTER_API_KEY=sk-... RELAY_TOKEN=dev node server.mjs
# then point the app at it:
#   AGENTROUTER_RELAY_URL=http://localhost:3000
#   AGENTROUTER_RELAY_TOKEN=dev
```
