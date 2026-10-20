import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  reviewDocument,
  calculateAverageScore,
  fingerprint,
  getReviewServiceUrl,
  AiConfigError,
  AiCapacityError,
  AiWafBlockError,
  AGENTROUTER_WAF_BLOCK,
  type ReviewScore,
} from "@/lib/ai-review";

/* ------------------------------------------------------------------ */
/* AI review tests.                                                    */
/*                                                                     */
/* Two paths exist and both are covered here:                           */
/*   A. AI_REVIEW_SERVICE_URL set  -> POST to the external service.     */
/*      The request body is { documentType, text } — no model, no key.  */
/*   B. No URL -> in-process provider (Groq / Gemini), which is the     */
/*      default now that the Railway service is gone.                   */
/*                                                                     */
/* In both cases the guarantees are the same: HTTP statuses map to the  */
/* route's error contract, malformed answers are rejected, and no fake  */
/* review is ever returned after a failure.                             */
/* ------------------------------------------------------------------ */

const REVIEW_URL = "https://my-review-service.up.railway.app/review";

const validReview: ReviewScore = {
  overallQuality: {
    score: 8,
    strengthsSummary: "Strong project history",
    weaknessesSummary: "Needs more leadership examples",
  },
  atsCompatibility: {
    score: 7,
    missingKeywords: ["International"],
    improvements: ["Mention the fellowship"],
  },
  competitiveness: {
    score: 6,
    uniqueStrengths: "Built a research project",
    differentiation: "First in class project",
  },
  topImprovements: ["Add awards", "Quantify impact", "Add volunteering"],
  quickWins: ["Fix formatting", "Add GPA"],
  overallAssessment: "Solid application with room to grow",
};

const originalFetch = globalThis.fetch;

type Route = { url: string; status?: number; body?: string; contentType?: string };

function mockFetch(routes: Route[]): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes.find((r) => url.includes(r.url));
    return Promise.resolve(
      new Response(route?.body ?? "{}", {
        status: route?.status ?? 200,
        headers: { "content-type": route?.contentType ?? "application/json" },
      })
    );
  }) as typeof fetch;
  return calls;
}

/** A valid review body served by the review service. */
function reviewJson(text: string): Route {
  return { url: REVIEW_URL, body: JSON.stringify(text) };
}

/** A valid ReviewScore served as the response body. */
function reviewScore(text: string): Route {
  return { ...reviewJson(text), body: JSON.stringify(validReview) };
}

function bodyOf(call: { init: RequestInit }): { documentType: string; text: string } {
  return JSON.parse(String(call.init.body));
}

const ENV_KEYS = [
  "AI_REVIEW_SERVICE_URL",
  "AI_PROVIDER",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "AGENTROUTER_API_KEY",
  "AGENTROUTER_RELAY_URL",
  "AGENTROUTER_RELAY_TOKEN",
  "AI_PROVIDER_API_KEY",
  "AI_REVIEW_MODEL",
  "AI_REVIEW_FALLBACK",
  "AI_MAX_INPUT_CHARS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  process.env.AI_REVIEW_SERVICE_URL = "https://my-review-service.up.railway.app";
  delete process.env.AI_DEBUG;
  process.env.AI_PROVIDER = "groq";
  delete process.env.AI_REVIEW_MODEL;
  delete process.env.AI_REVIEW_FALLBACK;
  delete process.env.AI_MAX_INPUT_CHARS;
  delete process.env.AI_PROVIDER_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
  delete process.env.AGENTROUTER_RELAY_URL;
  delete process.env.AGENTROUTER_RELAY_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("getReviewServiceUrl", () => {
  it("reads the base URL from the environment", () => {
    expect(getReviewServiceUrl()).toBe("https://my-review-service.up.railway.app");
  });
});

describe("fingerprint", () => {
  it("differs for different inputs and is stable for the same input", () => {
    expect(fingerprint("Founded a robotics club")).not.toBe(
      fingerprint("Won an olympiad medal")
    );
    expect(fingerprint("same text")).toBe(fingerprint("same text"));
  });
});

describe("calculateAverageScore", () => {
  it("averages the three sub-scores", () => {
    expect(calculateAverageScore(validReview)).toBe(7);
  });
});

describe("reviewDocument — review service success path", () => {
  it("returns the parsed review, calling only the review service", async () => {
    const calls = mockFetch([reviewScore(JSON.stringify(validReview))]);

    const result = await reviewDocument("Sample CV text", "CV");

    expect(result).toEqual(validReview);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(REVIEW_URL);
  });

  it("sends { documentType, text } and nothing else — no model, no key", async () => {
    const calls = mockFetch([reviewScore(JSON.stringify(validReview))]);

    await reviewDocument("My unique personal statement text", "Statement");

    const call = calls[0]!;
    const body = bodyOf(call);
    expect(body.documentType).toBe("Statement");
    expect(body.text).toContain("My unique personal statement text");
    expect(Object.keys(body).sort()).toEqual(["documentType", "text"]);
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toContain("application/json");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(String(call.init.body)).not.toContain("sk-");
  });

  it("sends two different documents as two different request bodies", async () => {
    const calls = mockFetch([reviewScore(JSON.stringify(validReview))]);

    await reviewDocument("Document A content", "CV");
    await reviewDocument("Document B content", "CV");

    expect(calls).toHaveLength(2);
    const first = bodyOf(calls[0]!);
    const second = bodyOf(calls[1]!);
    expect(first.text).not.toBe(second.text);
    expect(first.text).toContain("Document A content");
    expect(second.text).toContain("Document B content");
  });
});

describe("reviewDocument — configuration", () => {
  it("with no external URL and no provider key, fails as a config error before any request", async () => {
    const calls = mockFetch([reviewScore(JSON.stringify(validReview))]);
    delete process.env.AI_REVIEW_SERVICE_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER_API_KEY;

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      AiConfigError
    );
    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /GROQ_API_KEY|GEMINI_API_KEY/
    );
    expect(calls).toHaveLength(0);
  });

  it("an empty AI_REVIEW_SERVICE_URL falls back to the in-process provider", async () => {
    const calls = mockFetch([
      {
        url: "api.groq.com",
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }),
      },
    ]);
    process.env.AI_REVIEW_SERVICE_URL = "";
    process.env.AI_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-groq-key";

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("api.groq.com");
  });
});

describe("reviewDocument — review service failures are surfaced, never faked", () => {
  it("rejects empty text before contacting the service", async () => {
    const calls = mockFetch([reviewScore(JSON.stringify(validReview))]);
    await expect(reviewDocument("   ", "CV")).rejects.toThrow(
      "contains no extractable text"
    );
    expect(calls).toHaveLength(0);
  });

  it("surfaces a 401 as a config error using the service message", async () => {
    mockFetch([
      { url: REVIEW_URL, status: 401, body: JSON.stringify({ error: "CONFIG", message: "invalid api key" }) },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      AiConfigError
    );
    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      "invalid api key"
    );
  });

  it("surfaces a 403 as a config error", async () => {
    mockFetch([{ url: REVIEW_URL, status: 403, body: "{}" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      AiConfigError
    );
  });

  it("surfaces a 429 as a capacity error", async () => {
    mockFetch([
      {
        url: REVIEW_URL,
        status: 429,
        body: JSON.stringify({ error: "RATE_LIMIT", message: "rate limit reached" }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      AiCapacityError
    );
    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      "rate limit reached"
    );
  });

  it("surfaces a generic HTTP error with the service message", async () => {
    mockFetch([
      {
        url: REVIEW_URL,
        status: 500,
        body: JSON.stringify({ error: "UPSTREAM_ERROR", message: "agentrouter down" }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /agentrouter down/
    );
  });

  it("surfaces a non-JSON error body with the HTTP status", async () => {
    mockFetch([{ url: REVIEW_URL, status: 500, body: "Internal Server Error" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /HTTP 500/
    );
  });

  it("surfaces a non-JSON success body as an error", async () => {
    mockFetch([{ url: REVIEW_URL, status: 200, contentType: "text/html", body: "<html>" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /non-JSON response/
    );
  });

  it("surfaces an unparseable success body as an error", async () => {
    mockFetch([{ url: REVIEW_URL, status: 200, body: "this is not json" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /non-JSON response/
    );
  });

  it("rejects a JSON object missing the required score fields", async () => {
    mockFetch([{ url: REVIEW_URL, body: JSON.stringify({ overallQuality: { score: 8 } }) }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /malformed review/
    );
  });

  it("rejects a JSON object with an out-of-range score", async () => {
    mockFetch([
      {
        url: REVIEW_URL,
        body: JSON.stringify({
          overallQuality: { score: 11 },
          atsCompatibility: { score: 5 },
          competitiveness: { score: 5 },
        }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /malformed review/
    );
  });

  it("rejects a JSON array (not a review object)", async () => {
    mockFetch([{ url: REVIEW_URL, body: "[1,2,3]" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /malformed review/
    );
  });

  it("classifies an upstream WAF block as AGENTROUTER_WAF_BLOCK", async () => {
    mockFetch([
      {
        url: REVIEW_URL,
        status: 503,
        body: JSON.stringify({
          error: "UPSTREAM_WAF_BLOCK",
          message: "the upstream gateway answered with a WAF challenge",
        }),
      },
    ]);

    const err = await reviewDocument("Some CV text", "CV").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiWafBlockError);
    expect((err as { code?: string }).code).toBe(AGENTROUTER_WAF_BLOCK);
    expect((err as { code?: string }).code).toBe("AGENTROUTER_WAF_BLOCK");
    // Client-safe: no challenge internals, no host, no credentials.
    const message = (err as Error).message;
    expect(message).not.toContain("UPSTREAM_WAF_BLOCK");
    expect(message).not.toContain("aliyun_waf_aa");
    expect(message).not.toContain("synthetic-token-a");
    expect(message).not.toContain("my-review-service.up.railway.app");
  });

  it("surfaces a network error as an error", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as typeof fetch;

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /review service is unreachable/
    );
  });

  it("surfaces a timeout as an error", async () => {
    globalThis.fetch = (() =>
      Promise.reject(
        Object.assign(new Error("signal timed out"), { name: "TimeoutError" })
      )) as typeof fetch;

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /timed out/
    );
  });
});

/* ------------------------------------------------------------------ */
/* Path B: in-process provider (no external service).                  */
/* ------------------------------------------------------------------ */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com";

function groqResponse(review: unknown): Route {
  return {
    url: GROQ_URL,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(review) } }] }),
  };
}

function geminiResponse(review: unknown): Route {
  return {
    url: GEMINI_URL,
    body: JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(review) }] }, finishReason: "STOP" }],
    }),
  };
}

/** Switch the test onto the direct-provider path. */
function useGroq() {
  delete process.env.AI_REVIEW_SERVICE_URL;
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-groq-key";
}

function promptOf(call: { init: RequestInit }): string {
  const body = JSON.parse(String(call.init.body)) as {
    messages?: { content: string }[];
    contents?: { parts: { text: string }[] }[];
  };
  return body.messages?.[0]?.content ?? body.contents?.[0]?.parts[0]?.text ?? "";
}

describe("reviewDocument — in-process provider", () => {
  it("calls Groq with the bearer key and returns the validated review", async () => {
    useGroq();
    const calls = mockFetch([groqResponse(validReview)]);

    const result = await reviewDocument("My CV text", "CV");

    expect(result).toEqual(validReview);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(GROQ_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-groq-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("openai/gpt-oss-120b");
  });

  it("puts the document and its type into the prompt", async () => {
    useGroq();
    const calls = mockFetch([groqResponse(validReview)]);

    await reviewDocument("Aramex internship, 2024", "MOTIVATION_LETTER");

    const prompt = promptOf(calls[0]!);
    expect(prompt).toContain("Aramex internship, 2024");
    expect(prompt).toContain("MOTIVATION_LETTER");
    expect(prompt).toContain("signatureCheck");
  });

  it("truncates very long input and tells the model the document was cut", async () => {
    useGroq();
    process.env.AI_MAX_INPUT_CHARS = "1000";
    const calls = mockFetch([groqResponse(validReview)]);

    await reviewDocument("word ".repeat(1000), "CV");

    const prompt = promptOf(calls[0]!);
    expect(prompt).toContain("[document truncated for length]");
    expect(prompt).toContain("was cut off");
  });

  it("does not truncate a document under the limit", async () => {
    useGroq();
    const calls = mockFetch([groqResponse(validReview)]);

    await reviewDocument("short document text", "CV");

    expect(promptOf(calls[0]!)).not.toContain("[document truncated for length]");
  });

  it("parses JSON wrapped in markdown fences", async () => {
    useGroq();
    mockFetch([
      {
        url: GROQ_URL,
        body: JSON.stringify({
          choices: [{ message: { content: "```json\n" + JSON.stringify(validReview) + "\n```" } }],
        }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);
  });

  it("surfaces a 401 from the provider as a config error naming the key", async () => {
    useGroq();
    mockFetch([{ url: GROQ_URL, status: 401, body: '{"error":"invalid api key"}' }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(AiConfigError);
    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/GROQ_API_KEY|API key/);
  });

  it("surfaces a 429 from the provider as a capacity error", async () => {
    useGroq();
    mockFetch([{ url: GROQ_URL, status: 429, body: '{"error":"rate limit"}' }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(AiCapacityError);
  });

  it("rejects a provider answer that is not JSON", async () => {
    useGroq();
    mockFetch([
      { url: GROQ_URL, body: JSON.stringify({ choices: [{ message: { content: "Sure! Here is my review:" } }] }) },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a provider answer with missing score fields", async () => {
    useGroq();
    mockFetch([groqResponse({ overallQuality: { score: 8 } })]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/malformed review/);
  });

  it("records which provider and model actually ran", async () => {
    useGroq();
    mockFetch([groqResponse(validReview)]);

    const { reviewDocumentWithMeta } = await import("@/lib/ai-review");
    const result = await reviewDocumentWithMeta("Some CV text", "CV");

    expect(result.provider).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
  });

  it("calls Gemini with the structured-output schema when selected", async () => {
    delete process.env.AI_REVIEW_SERVICE_URL;
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const calls = mockFetch([geminiResponse(validReview)]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);

    expect(calls[0]!.url).toContain("gemini-3-flash-preview:generateContent");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-gemini-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBeTruthy();
  });

  it("does not fall back when no fallback is configured", async () => {
    useGroq();
    const calls = mockFetch([{ url: GROQ_URL, status: 429, body: "{}" }]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(AiCapacityError);
    expect(calls).toHaveLength(1);
  });

  it("falls back to Gemini on capacity only when explicitly enabled", async () => {
    useGroq();
    process.env.AI_REVIEW_FALLBACK = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const calls = mockFetch([
      { url: GROQ_URL, status: 429, body: "{}" },
      geminiResponse(validReview),
    ]);

    const { reviewDocumentWithMeta } = await import("@/lib/ai-review");
    const result = await reviewDocumentWithMeta("Some CV text", "CV");

    expect(result.provider).toBe("gemini");
    expect(calls.map((c) => c.url)).toEqual([GROQ_URL, expect.stringContaining(GEMINI_URL)]);
  });

  it("never falls back on a malformed answer — that is a bug, not capacity", async () => {
    useGroq();
    process.env.AI_REVIEW_FALLBACK = "gemini";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const calls = mockFetch([
      { url: GROQ_URL, body: JSON.stringify({ choices: [{ message: { content: "not json" } }] }) },
      geminiResponse(validReview),
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/not valid JSON/);
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* AgentRouter: x-api-key auth + client fingerprint headers.           */
/* ------------------------------------------------------------------ */

const AGENTROUTER_URL = "https://agentrouter.org/v1/chat/completions";

function agentRouterResponse(review: unknown): Route {
  return {
    url: AGENTROUTER_URL,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(review) } }] }),
  };
}

function useAgentRouter() {
  delete process.env.AI_REVIEW_SERVICE_URL;
  process.env.AI_PROVIDER = "agentrouter";
  process.env.AGENTROUTER_API_KEY = "test-agentrouter-key";
}

describe("reviewDocument — AgentRouter", () => {
  it("sends x-api-key and the client fingerprint headers, never Bearer", async () => {
    useAgentRouter();
    const calls = mockFetch([agentRouterResponse(validReview)]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);

    expect(calls[0]!.url).toBe(AGENTROUTER_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-agentrouter-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Originator).toBeTruthy();
    expect(headers["User-Agent"]).toBeTruthy();
    expect(headers.Version).toBeTruthy();

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("explains a rejected fingerprint instead of blaming the key", async () => {
    useAgentRouter();
    mockFetch([
      {
        url: AGENTROUTER_URL,
        status: 401,
        body: JSON.stringify({ error: { message: "unauthorized client detected" } }),
      },
    ]);

    const err = await reviewDocument("Some CV text", "CV").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConfigError);
    expect((err as Error).message).toMatch(/fingerprint/i);
    expect((err as Error).message).not.toContain("test-agentrouter-key");
  });

  it("treats a model the group cannot serve as a config error", async () => {
    useAgentRouter();
    mockFetch([
      {
        url: AGENTROUTER_URL,
        status: 400,
        body: JSON.stringify({ error: { message: "模型不支持 /v1/chat/completions 接口" } }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(AiConfigError);
  });

  it("falls back to Groq on an AgentRouter 429 when enabled", async () => {
    useAgentRouter();
    process.env.AI_REVIEW_FALLBACK = "groq";
    process.env.GROQ_API_KEY = "test-groq-key";
    const calls = mockFetch([
      { url: AGENTROUTER_URL, status: 429, body: "{}" },
      groqResponse(validReview),
    ]);

    const { reviewDocumentWithMeta } = await import("@/lib/ai-review");
    const result = await reviewDocumentWithMeta("Some CV text", "CV");

    expect(result.provider).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
    expect(calls).toHaveLength(2);
  });

  /* --- relay mode: production reaches the gateway via Railway --------- */

  const RELAY_URL = "https://agentrouter-relay.up.railway.app/v1/chat/completions";

  function useRelay(token = "relay-secret") {
    delete process.env.AI_REVIEW_SERVICE_URL;
    process.env.AI_PROVIDER = "agentrouter";
    delete process.env.AGENTROUTER_API_KEY; // the relay owns the key
    process.env.AGENTROUTER_RELAY_URL = "https://agentrouter-relay.up.railway.app";
    process.env.AGENTROUTER_RELAY_TOKEN = token;
  }

  it("posts to the relay with the token and no gateway key", async () => {
    useRelay();
    const calls = mockFetch([
      {
        url: RELAY_URL,
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);

    expect(calls[0]!.url).toBe(RELAY_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-relay-token"]).toBe("relay-secret");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it("explains a relay token mismatch instead of blaming the gateway", async () => {
    useRelay("wrong-token");
    mockFetch([
      {
        url: RELAY_URL,
        status: 401,
        body: JSON.stringify({ error: { message: "Invalid or missing x-relay-token." } }),
      },
    ]);

    const err = await reviewDocument("Some CV text", "CV").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiConfigError);
    expect((err as Error).message).toMatch(/AGENTROUTER_RELAY_TOKEN/);
    expect((err as Error).message).not.toContain("wrong-token");
  });

  it("does not require a direct key when the relay is configured", async () => {
    useRelay();
    const calls = mockFetch([
      {
        url: RELAY_URL,
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReview) } }] }),
      },
    ]);

    await reviewDocument("Some CV text", "CV");
    expect(calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Gateway-level failures are upstream, not malformed answers.         */
/*                                                                     */
/* A 2xx whose body is HTML (WAF interstitial) or empty is the gateway */
/* failing before the model runs — retrying on another provider is the */
/* right response. Model prose that is not JSON stays malformed.       */
/* ------------------------------------------------------------------ */

describe("reviewDocument — non-JSON HTTP bodies are upstream failures", () => {
  it("treats a 2xx HTML body as upstream and falls back to Groq by default", async () => {
    useAgentRouter();
    process.env.GROQ_API_KEY = "test-groq-key";
    const calls = mockFetch([
      {
        url: AGENTROUTER_URL,
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge</body></html>",
      },
      groqResponse(validReview),
    ]);

    const { reviewDocumentWithMeta } = await import("@/lib/ai-review");
    const result = await reviewDocumentWithMeta("Some CV text", "CV");

    expect(result.provider).toBe("groq");
    expect(result.review).toEqual(validReview);
    expect(calls).toHaveLength(2);
  });

  it("treats an empty 2xx body as upstream", async () => {
    useAgentRouter();
    process.env.GROQ_API_KEY = "test-groq-key";
    const calls = mockFetch([
      { url: AGENTROUTER_URL, status: 200, body: "" },
      groqResponse(validReview),
    ]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);
    expect(calls).toHaveLength(2);
  });

  it("honours AI_REVIEW_FALLBACK=none even when a Groq key is present", async () => {
    useAgentRouter();
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.AI_REVIEW_FALLBACK = "none";
    const calls = mockFetch([
      { url: AGENTROUTER_URL, status: 200, contentType: "text/html", body: "<html>blocked</html>" },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/non-JSON response/);
    expect(calls).toHaveLength(1);
  });

  it("still does not fall back when the model's own text is not JSON", async () => {
    useAgentRouter();
    process.env.GROQ_API_KEY = "test-groq-key";
    const calls = mockFetch([
      {
        url: AGENTROUTER_URL,
        body: JSON.stringify({ choices: [{ message: { content: "I cannot review this." } }] }),
      },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/not valid JSON/);
    expect(calls).toHaveLength(1);
  });

  it("names the missing fallback key instead of hiding it", async () => {
    useAgentRouter();
    process.env.AI_REVIEW_FALLBACK = "groq";
    mockFetch([
      { url: AGENTROUTER_URL, status: 200, contentType: "text/html", body: "<html>blocked</html>" },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(
      /fallback provider but its API key is missing/
    );
  });
});

/* ------------------------------------------------------------------ */
/* A stale AI_REVIEW_SERVICE_URL must not brick reviews.               */
/*                                                                     */
/* A deleted Railway app answers 404 {"message":"Application not       */
/* found"}. That used to surface as a 502 for every review even though  */
/* the in-process provider was configured and healthy.                 */
/* ------------------------------------------------------------------ */

describe("reviewDocument — configured review service no longer exists", () => {
  it("falls back to the in-process provider on 404 and reports its name", async () => {
    useGroq();
    process.env.AI_REVIEW_SERVICE_URL = "https://my-review-service.up.railway.app";
    const calls = mockFetch([
      {
        url: REVIEW_URL,
        status: 404,
        body: JSON.stringify({ status: "error", code: 404, message: "Application not found" }),
      },
      groqResponse(validReview),
    ]);

    const { reviewDocumentWithMeta } = await import("@/lib/ai-review");
    const result = await reviewDocumentWithMeta("Some CV text", "CV");

    expect(result.review).toEqual(validReview);
    expect(result.provider).toBe("groq");
    expect(result.model).toBe("openai/gpt-oss-120b");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(REVIEW_URL);
    expect(calls[1]!.url).toBe(GROQ_URL);
  });

  it("falls back on a 404 with a non-JSON body too", async () => {
    useGroq();
    process.env.AI_REVIEW_SERVICE_URL = "https://my-review-service.up.railway.app";
    const calls = mockFetch([
      { url: REVIEW_URL, status: 404, contentType: "text/plain", body: "Application not found" },
      groqResponse(validReview),
    ]);

    await expect(reviewDocument("Some CV text", "CV")).resolves.toEqual(validReview);
    expect(calls).toHaveLength(2);
  });

  it("still surfaces a 500 from a live service instead of silently switching", async () => {
    useGroq();
    process.env.AI_REVIEW_SERVICE_URL = "https://my-review-service.up.railway.app";
    const calls = mockFetch([
      { url: REVIEW_URL, status: 500, body: JSON.stringify({ error: "UPSTREAM_ERROR", message: "boom" }) },
    ]);

    await expect(reviewDocument("Some CV text", "CV")).rejects.toThrow(/boom/);
    expect(calls).toHaveLength(1);
  });
});
