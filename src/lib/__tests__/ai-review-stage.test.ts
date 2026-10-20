import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeScoresFromCriteria,
  reviewDocument,
  SCORE_WEIGHTS,
  type ReviewCriteria,
  type ReviewScore,
} from "@/lib/ai-review";
import { deriveCandidateStage } from "@/lib/candidate-stage";

/* ------------------------------------------------------------------ */
/* Criteria -> scores, end to end through the provider path.            */
/*                                                                      */
/* The model now returns eight ratings; the three headline scores are    */
/* computed here with fixed weights. These tests pin the maths and the   */
/* stage plumbing without calling a real model.                          */
/* ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  "AI_REVIEW_SERVICE_URL",
  "AI_PROVIDER",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "AGENTROUTER_API_KEY",
  "AI_PROVIDER_API_KEY",
  "AI_REVIEW_MODEL",
  "AI_REVIEW_FALLBACK",
] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

const RATINGS: Record<keyof ReviewCriteria, number> = {
  objectiveFocus: 9,
  evidenceOutcomes: 8,
  relevanceToTarget: 9,
  depthAndContribution: 7,
  leadershipInitiative: 6,
  skillsEvidence: 8,
  writingClarity: 7,
  atsReadability: 9,
};

function criteria(rating: Partial<Record<keyof ReviewCriteria, number>> = {}): ReviewCriteria {
  return Object.fromEntries(
    Object.entries({ ...RATINGS, ...rating }).map(([key, value]) => [
      key,
      { rating: value, justification: `The line "${key}" is quoted here.` },
    ])
  ) as ReviewCriteria;
}

function payload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    criteria: criteria(),
    ats: { missingKeywords: ["robotics"], improvements: ["Use a single column"] },
    overallQuality: { strengthsSummary: "Names a measured robot result", weaknessesSummary: "Vague club role" },
    competitiveness: { uniqueStrengths: "Built the sensor himself", differentiation: "Regional finalist" },
    topImprovements: [
      { severity: "high", text: "Quantify the robot's accuracy." },
      { severity: "medium", text: "Name your role in the club." },
      { severity: "polish", text: "Tighten the objective." },
    ],
    quickWins: ["Add graduation year"],
    overallAssessment: "Promising Grade 11 CV.",
    signatureCheck: { required: false, status: "NOT_APPLICABLE", note: "CVs do not need a signature." },
    ...overrides,
  };
}

function mockGroq(content: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as typeof fetch;
  return calls;
}

function promptOf(init: RequestInit): string {
  const body = JSON.parse(String(init.body)) as { messages: { content: string }[] };
  return body.messages[0]?.content ?? "";
}

beforeEach(() => {
  process.env.AI_REVIEW_SERVICE_URL = "";
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.AI_REVIEW_FALLBACK = "none";
  delete process.env.AI_REVIEW_MODEL;
  delete process.env.AI_PROVIDER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AGENTROUTER_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("computeScoresFromCriteria", () => {
  it("applies the fixed weights and rounds once", () => {
    const scores = computeScoresFromCriteria(criteria());
    // objective 9, evidence 8, relevance 9, depth 7, leadership 6, skills 8, writing 7
    expect(scores.overallQuality).toBe(8);
    // ats 9 * .6 + relevance 9 * .2 + objective 9 * .1 + skills 8 * .1
    expect(scores.atsCompatibility).toBe(9);
    // evidence 8 * .25 + depth 7 * .2 + leadership 6 * .2 + relevance 9 * .2 + objective 9 * .15
    expect(scores.competitiveness).toBe(8);
  });

  it("has weights that sum to 1.0 for each score", () => {
    for (const weights of Object.values(SCORE_WEIGHTS)) {
      const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("is deterministic for the same ratings", () => {
    const first = computeScoresFromCriteria(criteria());
    const second = computeScoresFromCriteria(criteria());
    expect(first).toEqual(second);
  });

  it("clamps out-of-range aggregate output to 1-10", () => {
    expect(computeScoresFromCriteria(criteria({ objectiveFocus: 1 })).overallQuality).toBeGreaterThanOrEqual(1);
    expect(computeScoresFromCriteria(criteria({ objectiveFocus: 10 })).overallQuality).toBeLessThanOrEqual(10);
  });
});

describe("reviewDocument — criteria path", () => {
  it("computes the headline scores instead of trusting model scores", async () => {
    mockGroq(JSON.stringify(payload()));
    const review = await reviewDocument("Some Grade 11 CV", "CV");

    expect(review.overallQuality.score).toBe(8);
    expect(review.atsCompatibility.score).toBe(9);
    expect(review.competitiveness.score).toBe(8);
    expect(review.topImprovements).toHaveLength(3);
    expect(review.improvementSeverities).toEqual(["high", "medium", "polish"]);
    expect(review.criteria?.objectiveFocus.justification).toContain("objectiveFocus");
  });

  it("produces identical scores on a rerun with the same ratings", async () => {
    mockGroq(JSON.stringify(payload()));
    const first = await reviewDocument("Some Grade 11 CV", "CV");
    const second = await reviewDocument("Some Grade 11 CV", "CV");

    expect(first.overallQuality.score).toBe(second.overallQuality.score);
    expect(first.atsCompatibility.score).toBe(second.atsCompatibility.score);
    expect(first.competitiveness.score).toBe(second.competitiveness.score);
  });

  it("caps the improvement list at five", async () => {
    mockGroq(
      JSON.stringify(
        payload({
          topImprovements: Array.from({ length: 7 }, (_, i) => ({
            severity: "medium",
            text: `Improvement ${i + 1}`,
          })),
        })
      )
    );
    const review = await reviewDocument("Some CV", "CV");
    expect(review.topImprovements).toHaveLength(5);
  });

  it("rejects a rating with no quoted justification", async () => {
    const bad = payload();
    (bad.criteria as ReviewCriteria).objectiveFocus.justification = " ";
    mockGroq(JSON.stringify(bad));

    await expect(reviewDocument("Some CV", "CV")).rejects.toThrow(/malformed/i);
  });

  it("still accepts the legacy three-score shape (external service compatibility)", async () => {
    const legacy: ReviewScore = {
      overallQuality: { score: 7, strengthsSummary: "A", weaknessesSummary: "B" },
      atsCompatibility: { score: 6, missingKeywords: [], improvements: [] },
      competitiveness: { score: 5, uniqueStrengths: "C", differentiation: "D" },
      topImprovements: ["One"],
      quickWins: ["Two"],
      overallAssessment: "Three",
    };
    mockGroq(JSON.stringify(legacy));
    const review = await reviewDocument("Some CV", "CV");
    expect(review.overallQuality.score).toBe(7);
    expect(review.atsCompatibility.score).toBe(6);
  });
});

describe("reviewDocument — stage plumbing", () => {
  it("sends the stage and rubric, and never the date of birth", async () => {
    const calls = mockGroq(JSON.stringify(payload()));
    const stage = deriveCandidateStage({ age: 16, educationLevel: "high-school" });

    await reviewDocument("Some Grade 11 CV", "CV", stage);

    const prompt = promptOf(calls[0]!.init);
    expect(prompt).toContain("APPLICANT STAGE");
    expect(prompt).toContain('"stage": "high_school_g11"');
    expect(prompt).toContain('"age_band": "16_17"');
    expect(prompt).toContain("Rate eight criteria");
    expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toContain("dateOfBirth");
  });

  it("attaches stage, confidence and the assumption note to the review", async () => {
    mockGroq(JSON.stringify(payload()));
    const low = deriveCandidateStage({});
    const review = await reviewDocument("Some CV", "CV", low);

    expect(review.stage).toBe("high_school_g12");
    expect(review.stageConfidence).toBe("low");
    expect(review.stageAssumption).toContain("Assumed Grade 12 applicant");
  });

  it("keeps the stage when the legacy shape comes back", async () => {
    mockGroq(
      JSON.stringify({
        overallQuality: { score: 7, strengthsSummary: "", weaknessesSummary: "" },
        atsCompatibility: { score: 7, missingKeywords: [], improvements: [] },
        competitiveness: { score: 7, uniqueStrengths: "", differentiation: "" },
        topImprovements: [],
        quickWins: [],
        overallAssessment: "",
      })
    );
    const stage = deriveCandidateStage({ age: 17, educationLevel: "high-school" });
    const review = await reviewDocument("Some CV", "CV", stage);
    expect(review.stage).toBe("high_school_g12");
    expect(review.stageConfidence).toBe("medium");
  });
});
