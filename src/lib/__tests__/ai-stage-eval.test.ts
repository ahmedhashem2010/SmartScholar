import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { calculateAverageScore, reviewDocument, type ReviewScore } from "@/lib/ai-review";
import { deriveCandidateStage } from "@/lib/candidate-stage";
import {
  MEDIUM_GRADE_12_CV,
  STRONG_GRADE_12_CV,
  WEAK_GRADE_12_CV,
} from "@/lib/__tests__/fixtures/stage-cvs";

/**
 * Live stage-calibration eval. Skipped unless AI_EVAL=true.
 *
 *   AI_EVAL=true npx vitest run src/lib/__tests__/ai-stage-eval.test.ts
 *
 * It calls the configured provider (AgentRouter locally) 12 times: three runs
 * for each Grade 12 CV, plus three runs of the strong CV with a Master's target.
 * Asserting a real model's output is inherently slower and non-hermetic, which
 * is why it is opt-in; the deterministic unit tests cover the maths on every run.
 *
 * The score bands below are an answer key for the eval. They are deliberately
 * *not* imported by production code and never appear in the review prompt.
 */

const LIVE = process.env.AI_EVAL === "true";
const liveDescribe = LIVE ? describe : describe.skip;

/** Minimal .env loader: vitest does not run Next's env bootstrap. */
function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      const value = match[2]!.replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env: rely on the shell environment.
  }
}

const RUNS = Number(process.env.AI_EVAL_RUNS || 3);

const GRADE_12 = () =>
  deriveCandidateStage({ grade: "12", educationLevel: "high-school", targetDegree: "bachelor" });
const MASTERS = () =>
  deriveCandidateStage({ grade: "12", educationLevel: "high-school", targetDegree: "master" });

/**
 * One review, retried once on an infrastructure failure (the reasoning model
 * occasionally spends its whole output budget). A retry is not a different
 * measurement of the prompt; it is the same request after a capacity error.
 */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnce(cv: string, stage: ReturnType<typeof GRADE_12>): Promise<ReviewScore> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const review = await reviewDocument(cv, "CV", stage);
      console.error("[stage-eval] run", stage.stage, calculateAverageScore(review));
      return review;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        /capacity|budget|rate limit|busy|reasoning|not valid JSON|malformed|timed out|unreachable|fetch failed|non-JSON/i.test(
          message
        );
      if (!transient || attempt === 2) throw error;
      await wait(2_000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function runThree(cv: string, stage: ReturnType<typeof GRADE_12>): Promise<ReviewScore[]> {
  const reviews: ReviewScore[] = [];
  for (let i = 0; i < RUNS; i++) {
    reviews.push(await runOnce(cv, stage));
    if (i < RUNS - 1) await wait(1_000);
  }
  return reviews;
}

function average(review: ReviewScore): number {
  return calculateAverageScore(review);
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function feedbackText(review: ReviewScore): string {
  return [
    review.overallAssessment,
    review.overallQuality.weaknessesSummary,
    ...review.topImprovements,
    ...review.atsCompatibility.improvements,
  ].join(" ");
}

liveDescribe("live stage calibration — Grade 12", () => {
  beforeAll(() => {
    if (!LIVE) return;
    loadDotEnv();
    // Measure one model. A fallback would swap providers mid-eval and make the
    // spread assertion meaningless; production sets this to none too.
    process.env.AI_REVIEW_FALLBACK = "none";
    // The richer answer takes longer to generate. Production's route budget is
    // 60s, so allow the call to use it rather than timing out at the old 40s.
    process.env.AI_REVIEW_TIMEOUT_MS = "55000";
  });

  it(
    "scores strong / medium / weak inside their bands, at least 2 points apart, with a spread under 1",
    async () => {
      const strong = await runThree(STRONG_GRADE_12_CV, GRADE_12());
      const medium = await runThree(MEDIUM_GRADE_12_CV, GRADE_12());
      const weak = await runThree(WEAK_GRADE_12_CV, GRADE_12());

      const strongScores = strong.map(average);
      const mediumScores = medium.map(average);
      const weakScores = weak.map(average);

      console.error("[stage-eval] strong:", strongScores, "medium:", mediumScores, "weak:", weakScores);

      for (const score of strongScores) {
        expect(score).toBeGreaterThanOrEqual(8);
        expect(score).toBeLessThanOrEqual(9);
      }
      for (const score of mediumScores) {
        expect(score).toBeGreaterThanOrEqual(5);
        expect(score).toBeLessThanOrEqual(6);
      }
      for (const score of weakScores) {
        expect(score).toBeGreaterThanOrEqual(2);
        expect(score).toBeLessThanOrEqual(4);
      }

      expect(Math.max(...mediumScores)).toBeLessThanOrEqual(Math.min(...strongScores) - 2);
      expect(Math.max(...weakScores)).toBeLessThanOrEqual(Math.min(...mediumScores) - 2);

      expect(spread(strongScores)).toBeLessThan(1);
      expect(spread(mediumScores)).toBeLessThan(1);
      expect(spread(weakScores)).toBeLessThan(1);

      console.error(
        "[stage-eval] strong criteria:",
        JSON.stringify(
          Object.fromEntries(
            Object.entries(strong[0]!.criteria ?? {}).map(([key, value]) => [key, value.rating])
          )
        )
      );

      const strongFeedback = feedbackText(strong[0]!);
      expect(strongFeedback).not.toMatch(/\b(publication|internship|work experience)\b/i);
      expect(strong[0]!.stage).toBe("high_school_g12");
      expect(strong[0]!.stageConfidence).toBe("high");
    },
    900_000
  );

  it(
    "judges the same strong CV as a Master's applicant, scores it lower and asks for research/internship evidence",
    async () => {
      const masters = await runThree(STRONG_GRADE_12_CV, MASTERS());
      const grade12 = await runThree(STRONG_GRADE_12_CV, GRADE_12());

      const mastersScores = masters.map(average);
      const grade12Scores = grade12.map(average);
      console.error("[stage-eval] masters:", mastersScores, "grade12:", grade12Scores);

      expect(Math.min(...mastersScores)).toBeLessThanOrEqual(Math.max(...grade12Scores) - 1);
      expect(spread(mastersScores)).toBeLessThan(1);

      const feedback = feedbackText(masters[0]!);
      expect(feedback).toMatch(/\b(research|internship|publication|thesis|degree-level)\b/i);
      expect(masters[0]!.stage).toBe("masters");
    },
    900_000
  );
});
