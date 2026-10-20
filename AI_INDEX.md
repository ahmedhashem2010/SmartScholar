# AI_INDEX — SmartScholar

Inventory of AI-related modules. Facts only.

## AI Providers

Reviews run **in-process**: `src/lib/ai-review.ts` validates and maps errors,
`src/lib/ai-providers.ts` holds the prompt and calls the provider chosen by
`AI_PROVIDER` (agentrouter | groq | gemini). There is no external review
service; `AI_REVIEW_SERVICE_URL` is optional and normally empty. Fallback is
opt-in (`AI_REVIEW_FALLBACK`) and capacity-only.

| Provider | File | Purpose |
|----------|------|---------|
| agentrouter | `src/lib/ai-providers.ts` (`callAgentRouter`) | Gateway at agentrouter.org; `x-api-key` + fingerprint headers; default model `deepseek-v4-flash` |
| groq | `src/lib/ai-providers.ts` (`callGroq`) | OpenAI-compatible JSON mode; default model `openai/gpt-oss-120b` |
| gemini | `src/lib/ai-providers.ts` (`callGemini`) | Structured output via `responseSchema`; default model `gemini-3-flash-preview` |
| Review client | `src/lib/ai-review.ts` | Prompt orchestration, ReviewScore validation, error mapping |
| Embedding provider | `smartscholar-backend/scripts/generateEmbeddings.ts` | Generates scholarship vector embeddings (backend) |
| Deep-extract AI | `smartscholar-backend/src/deep-extract/ai.ts` | AI extraction for the ingestion pipeline (backend) |

## AI API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/documents/[id]/review` | Runs AI document review, stores result, counts against the free daily review quota |

## AI Services

| File | Function |
|------|----------|
| `src/lib/ai-review.ts` | `reviewDocument`, `getReviewServiceUrl`, `calculateAverageScore`, `fingerprint`, `AiConfigError`, `AiCapacityError`, `AiWafBlockError` |
| `src/lib/scholarship-matcher.ts` | `matchScholarshipsToUser` (deterministic matching) |
| `src/lib/roadmap-generator.ts` | roadmap milestone generation (deterministic) |
| `smartscholar-backend/src/deep-extract/ai.ts` | AI-assisted field extraction |
| `smartscholar-backend/scripts/generateEmbeddings.ts` | embedding generation |

## AI Prompts

| File | Prompt purpose |
|------|----------------|
| `src/lib/ai-providers.ts` (`buildReviewPrompt`) | Scores a CV / personal statement / motivation letter on quality, ATS compatibility and competitiveness; returns the ReviewScore JSON, including a signature verdict |
| `smartscholar-backend/src/deep-extract/ai.ts` | Extraction prompt for structured scholarship fields |

## AI Environment Variables

| Variable | Module |
|----------|--------|
| `AI_PROVIDER` | `src/lib/ai-providers.ts` — `agentrouter` \| `groq` \| `gemini` |
| `AI_REVIEW_MODEL` | `src/lib/ai-providers.ts` — model id for the chosen provider |
| `AGENTROUTER_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` | `src/lib/ai-providers.ts` — key for the provider in use |
| `AI_REVIEW_FALLBACK` | `src/lib/ai-providers.ts` — opt-in capacity-only fallback provider |
| `AI_MAX_INPUT_CHARS` | `src/lib/ai-providers.ts` — document truncation limit (default 16000) |
| `AI_REVIEW_LANGUAGE` | `src/lib/ai-providers.ts` — `auto` \| `ar` \| `en` for review prose |
| `AGENTROUTER_ENDPOINT`, `AGENTROUTER_ORIGINATOR`, `AGENTROUTER_USER_AGENT`, `AGENTROUTER_VERSION` | `src/lib/ai-providers.ts` — gateway base URL and client-fingerprint headers |
| `AI_REVIEW_SERVICE_URL` | `src/lib/ai-review.ts` — optional external service (normally empty) |
| `AI_REVIEW_TIMEOUT_MS` | `src/lib/ai-review.ts` (optional, default 40s) |
| `AI_DEBUG` | `src/lib/ai-review.ts` |
| `EMBEDDING_API_URL` | `smartscholar-backend/scripts/generateEmbeddings.ts` |
| `EMBEDDING_API_KEY` | `smartscholar-backend/scripts/generateEmbeddings.ts` |
| `EMBEDDING_MODEL` | `smartscholar-backend/scripts/generateEmbeddings.ts` |

## AI Flow

```
User Upload (document)
        ↓
Review API (/api/documents/[id]/review)  ← auth, quota, text extraction
        ↓
reviewDocumentWithMeta (src/lib/ai-review.ts)
        ↓
AI Provider (src/lib/ai-providers.ts — agentrouter | groq | gemini)
        ↓
AI Provider (no fallback unless AI_REVIEW_FALLBACK is set)
        ↓
Database (Review record, review quota updated)
        ↓
Frontend (score + feedback display)
```
