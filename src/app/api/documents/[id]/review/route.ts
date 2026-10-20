import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/api-auth";
import { unauthorized, forbidden } from "@/lib/api-utils";
import {
  reviewDocumentWithMeta,
  calculateAverageScore,
  normalizeSignatureCheck,
  AiConfigError,
  AiCapacityError,
} from "@/lib/ai-review";
import type { ReviewScore } from "@/lib/ai-review";
import { deriveCandidateStage, type CandidateStageInfo } from "@/lib/candidate-stage";
import { extractTextFromFile } from "@/lib/text-extract";
import { getVersionChain } from "@/lib/document-versions";
import { DAILY_REVIEW_LIMIT, currentDayKey } from "@/lib/review-quota";
import { documentFileUrl, findDocumentWithOwnership } from "@/lib/document-access";

/**
 * A review is one blocking provider call (2–30s typical). Without this, the
 * platform default can cut the request off mid-review. 60s is the maximum on
 * Vercel's Hobby plan; the provider timeout (AI_REVIEW_TIMEOUT_MS) is set below
 * it so the app fails with a message instead of a platform timeout.
 */
export const maxDuration = 60;


/**
 * Step tracing for the review pipeline.
 *
 * These lines were plain console.log. On Vercel that means every user ID,
 * document ID and storage URL for every review lands in production logs
 * forever — on a product whose documents are students' personal statements and
 * CVs. They're genuinely useful when a review fails, so they're kept but gated.
 *
 * Set AI_DEBUG=true locally to see them. Never in production.
 */
const REVIEW_DEBUG = process.env.AI_DEBUG === "true";
function debugLog(...args: unknown[]) {
  if (REVIEW_DEBUG) console.log(...args);
}


function safeJsonParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function safeArray(raw: string): string[] {
  const parsed = safeJsonParse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function logError(step: string, err: unknown) {
  if (err instanceof Error) {
    console.error(`[${step}] Error:`, err.message);
    console.error(`[${step}] Name:`, err.name);
    console.error(`[${step}] Stack:`, err.stack);
  } else {
    console.error(`[${step}] Unknown error:`, err);
  }
}

/** Standard response when the daily review quota is exhausted. */
function quotaExhaustedResponse() {
  return NextResponse.json(
    {
      success: false,
      error: `You've used all ${DAILY_REVIEW_LIMIT} free AI reviews for today. Your free reviews reset tomorrow.`,
      limitReached: true,
    },
    { status: 429 }
  );
}

/**
 * Gives back a reserved daily review slot. Used whenever a review fails after
 * reservation but before the review row is saved, so an error never consumes
 * one of the user's free reviews.
 */
async function releaseDailySlot(userId: string, day: string): Promise<void> {
  try {
    await prisma.reviewDailyUsage.update({
      where: { userId_day: { userId, day } },
      data: { count: { decrement: 1 } },
    });
  } catch (releaseErr) {
    logError("release daily slot", releaseErr);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  let id: string | undefined;
  try {
    id = params.id;
    debugLog("[POST] Step 1/12: Params parsed, id =", id);
    if (!id) {
      return NextResponse.json({ success: false, error: "Document ID is required" }, { status: 400 });
    }

    debugLog("[POST] Step 2/12: Authenticating user...");
    const user = await getAuthenticatedUser(request);
    if (!user) {
      debugLog("[POST] Auth failed: no user");
      return unauthorized();
    }
    debugLog("[POST] Authenticated as user:", user.id);

    debugLog("[POST] Step 3/12: Finding document by id...");
    const ownership = await findDocumentWithOwnership(id, user.id, { parentDocument: true });
    if (ownership.status === "missing") {
      debugLog("[POST] Document not found:", id);
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    if (ownership.status === "forbidden") {
      debugLog("[POST] Forbidden: user", user.id, "does not own document", id);
      return forbidden();
    }
    const document = ownership.document;
    debugLog("[POST] Document found:", document.id, "type:", document.documentType, "fileUrl:", document.fileUrl?.slice(0, 80) ?? "none");

    debugLog("[POST] Step 4/12: Checking today's review quota...");
    const day = currentDayKey();
    const usage = await prisma.reviewDailyUsage.findUnique({
      where: { userId_day: { userId: user.id, day } },
    });
    if ((usage?.count ?? 0) >= DAILY_REVIEW_LIMIT) {
      debugLog("[POST] Daily quota exhausted for user:", user.id, "count:", usage?.count);
      return quotaExhaustedResponse();
    }
    debugLog("[POST] Reviews used today:", usage?.count ?? 0);

    debugLog("[POST] Step 5/12: Checking for existing review...");
    const existingReview = await prisma.review.findFirst({
      where: { documentId: id },
      orderBy: { createdAt: "desc" },
    });
    if (existingReview) {
      debugLog("[POST] Existing review found, returning cached result");
      const rawScores = safeJsonParse(existingReview.strengths);
      const isOldFormat = Array.isArray(rawScores) && rawScores.length > 0 && typeof rawScores[0] === "string";
      const scores = isOldFormat ? null : (rawScores as ReviewScore | null);
      return NextResponse.json({
        success: true,
        data: {
          id: existingReview.id,
          documentId: existingReview.documentId,
          userId: existingReview.userId,
          score: scores ? calculateAverageScore(scores) : existingReview.score,
          overallQuality: scores?.overallQuality ?? { score: existingReview.score, strengthsSummary: "", weaknessesSummary: "" },
          atsCompatibility: scores?.atsCompatibility ?? { score: existingReview.score, missingKeywords: [], improvements: [] },
          competitiveness: scores?.competitiveness ?? { score: existingReview.score, uniqueStrengths: "", differentiation: "" },
          topImprovements: safeArray(existingReview.suggestions),
          quickWins: safeArray(existingReview.grammarIssues),
          overallAssessment: existingReview.overallFeedback,
          stage: scores?.stage,
          stageConfidence: scores?.stageConfidence,
          stageAssumption: scores?.stageAssumption,
          improvementSeverities: scores?.improvementSeverities,
          criteria: scores?.criteria,
          modelUsed: existingReview.modelUsed,
          createdAt: existingReview.createdAt,
        },
      });
    }

    if (!document.fileUrl) {
      debugLog("[POST] Document fileUrl is missing");
      return NextResponse.json({ success: false, error: "Document file URL is missing" }, { status: 400 });
    }

    debugLog("[POST] Step 6/12: Getting parent score for comparison...");
    let prevScore: number | null = null;
    if (document.parentDocumentId && document.parentDocument) {
      const prevReview = await prisma.review.findFirst({
        where: { documentId: document.parentDocumentId },
        orderBy: { createdAt: "desc" },
      });
      if (prevReview) prevScore = prevReview.score;
    }

    let text: string;
    debugLog("[POST] Step 7/12: Downloading file and extracting text...");
    debugLog("[POST] fileUrl:", document.fileUrl);
    debugLog("[POST] fileType:", document.fileType);
    try {
      text = await extractTextFromFile(document.fileUrl, document.fileType);
      debugLog("[POST] Text extracted, length:", text.length);
    } catch (extractErr) {
      logError("POST extractTextFromFile", extractErr);
      const extractMsg = extractErr instanceof Error ? extractErr.message : "";
      if (extractMsg.toLowerCase().includes("cannot read") || extractMsg.toLowerCase().includes("image")) {
        return NextResponse.json({
          success: false,
          error: "This document appears to be an image-based or scanned file (no selectable text). Please upload a text-based PDF or DOCX file.",
        }, { status: 400 });
      }
      return NextResponse.json({
        success: false,
        error: `Text extraction failed: ${extractMsg}`,
      }, { status: 500 });
    }

    if (!text || text.length < 50) {
      debugLog("[POST] Extracted text too short:", text?.length ?? 0);
      return NextResponse.json({
        success: false,
        error: "The document contains very little extractable text. It may be a scanned image. Please upload a text-based PDF or DOCX.",
      }, { status: 400 });
    }

    // Derive the applicant stage from stored profile data, not from the model.
    // Only the stage object and a coarse age band reach the prompt or the logs —
    // the raw date of birth never leaves this block.
    let stage: CandidateStageInfo;
    try {
      const profile = await prisma.userProfile.findUnique({ where: { userId: user.id } });
      stage = deriveCandidateStage({
        dateOfBirth: profile?.dateOfBirth ?? null,
        educationLevel: profile?.educationLevel,
        targetDegree: profile?.targetDegree,
        cvText: text,
      });
    } catch (profileErr) {
      // A profile read failure must not fail the review. Derive from the document
      // alone and let the low/medium confidence note tell the student why.
      logError("POST load profile for stage", profileErr);
      stage = deriveCandidateStage({ cvText: text });
    }
    debugLog(
      "[POST] Stage derived:",
      stage.stage,
      "confidence:",
      stage.confidence,
      "basis:",
      stage.basis
    );

    // Reserve a daily review slot BEFORE calling the AI, then release it if
    // anything after this point fails. The upsert is atomic on the
    // (userId, day) unique key, so two concurrent requests can't both slip
    // past the cap; the pre-check above is only a cheap early-exit.
    debugLog("[POST] Step 8/12: Reserving a daily review slot...");
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.reviewDailyUsage.upsert({
          where: { userId_day: { userId: user.id, day } },
          create: { userId: user.id, day, count: 1 },
          update: { count: { increment: 1 } },
        });
        if (row.count > DAILY_REVIEW_LIMIT) {
          throw new Error("DAILY_LIMIT_REACHED");
        }
      });
      debugLog("[POST] Daily review slot reserved");
    } catch (reserveErr) {
      if (reserveErr instanceof Error && reserveErr.message === "DAILY_LIMIT_REACHED") {
        debugLog("[POST] Daily limit reached during reservation");
        return quotaExhaustedResponse();
      }
      logError("POST reserve daily slot", reserveErr);
      return NextResponse.json(
        { success: false, error: "We couldn't check your daily review limit. Please try again." },
        { status: 500 }
      );
    }

    debugLog("[POST] Step 9/12: Calling AI review service...");
    let coaching: ReviewScore;
    let modelUsed: string;
    try {
      const result = await reviewDocumentWithMeta(text, document.documentType, stage);
      coaching = result.review;
      // Record what actually ran: provider + model. If a fallback provider
      // answered, its name is stored, not the configured primary's.
      modelUsed = `${result.provider}:${result.model}`;
      debugLog("[POST] AI review complete, overall score:", coaching.overallQuality?.score, "via", modelUsed);
    } catch (aiErr) {
      logError("POST reviewDocument", aiErr);
      // The daily slot was reserved before the call — release it so a failed
      // review never consumes one of the user's free reviews.
      await releaseDailySlot(user.id, day);
      const technical = aiErr instanceof Error ? aiErr.message : String(aiErr);
      let message: string;
      if (aiErr instanceof AiConfigError) {
        // Operator-facing detail, but it names an env var, not a secret, and a
        // student seeing "contact support" is more useful than a silent failure.
        message = `AI review failed. The review provider is not configured: ${technical}`;
      } else if (
        aiErr instanceof AiCapacityError ||
        /quota|rate limit|insufficient|temporarily unavailable|high demand/i.test(technical)
      ) {
        message =
          "AI review failed. Our review service is busy right now. Please try again in a few minutes — you haven't used a review.";
      } else {
        const detail = technical.replace(/^AI review failed:\s*/i, "").slice(0, 300);
        message = `AI review failed. ${detail}`;
      }
      return NextResponse.json(
        {
          success: false,
          error: "AI_REVIEW_FAILED",
          message,
        },
        { status: 502 }
      );
    }

    if (!coaching || typeof coaching.overallQuality?.score !== "number") {
      debugLog("[POST] AI returned invalid response structure");
      await releaseDailySlot(user.id, day);
      return NextResponse.json({ success: false, error: "AI review returned an invalid response" }, { status: 502 });
    }

    const mainScore = coaching.overallQuality.score;
    const improvementScore = prevScore !== null ? mainScore - prevScore : null;

    // Stage + criteria live inside the existing `strengths` JSON so this needs
    // no schema migration, and older reviews simply lack the fields.
    const scoresData = {
      overallQuality: coaching.overallQuality,
      atsCompatibility: coaching.atsCompatibility,
      competitiveness: coaching.competitiveness,
      stage: coaching.stage,
      stageConfidence: coaching.stageConfidence,
      stageAssumption: coaching.stageAssumption,
      improvementSeverities: coaching.improvementSeverities,
      criteria: coaching.criteria,
    };

    const signatureCheck = normalizeSignatureCheck(coaching.signatureCheck);

    // The daily slot is already reserved, so this is a plain insert. If the
    // write fails, release the slot so the user can retry without losing a
    // free review.
    debugLog("[POST] Step 10/12: Saving review...");
    let review;
    try {
      review = await prisma.review.create({
        data: {
          documentId: document.id,
          userId: user.id,
          score: mainScore,
          modelUsed,
          strengths: JSON.stringify(scoresData),
          weaknesses: JSON.stringify([]),
          suggestions: JSON.stringify(coaching.topImprovements ?? []),
          grammarIssues: JSON.stringify(coaching.quickWins ?? []),
          overallFeedback: coaching.overallAssessment ?? "Review completed.",
          signatureRequired: signatureCheck?.required ?? null,
          signatureStatus: signatureCheck?.status ?? null,
          signatureNote: signatureCheck?.note ?? null,
        },
      });
      debugLog("[POST] Review saved, id:", review.id);
    } catch (saveErr) {
      await releaseDailySlot(user.id, day);
      logError("POST save review", saveErr);
      return NextResponse.json(
        {
          success: false,
          error: "We couldn't save your review. Your free review for today is still available — please try again.",
        },
        { status: 500 }
      );
    }

    debugLog("[POST] Step 11/12: Updating improvement score...");
    if (improvementScore !== null) {
      try {
        await prisma.document.update({
          where: { id },
          data: { improvementScore },
        });
        debugLog("[POST] Improvement score updated:", improvementScore);
      } catch (impErr) {
        logError("POST update improvement score", impErr);
      }
    }

    debugLog("[POST] Step 12/12: Building response...");
    const responseData = {
      id: review.id,
      documentId: review.documentId,
      userId: review.userId,
      score: calculateAverageScore(coaching),
      overallQuality: coaching.overallQuality,
      atsCompatibility: coaching.atsCompatibility,
      competitiveness: coaching.competitiveness,
      topImprovements: safeArray(review.suggestions),
      quickWins: safeArray(review.grammarIssues),
      overallAssessment: review.overallFeedback,
      signatureCheck,
      stage: coaching.stage,
      stageConfidence: coaching.stageConfidence,
      stageAssumption: coaching.stageAssumption,
      improvementSeverities: coaching.improvementSeverities,
      criteria: coaching.criteria,
      modelUsed: review.modelUsed || modelUsed,
      createdAt: review.createdAt,
    };

    debugLog("[POST] Complete. Returning success for review:", review.id);
    return NextResponse.json({ success: true, data: responseData }, { status: 201 });
  } catch (err) {
    logError("POST top-level", err);
    return NextResponse.json(
      { success: false, error: "Something went wrong generating your review. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    debugLog("[GET] Step 1/6: Params parsed, id =", id);
    if (!id) {
      return NextResponse.json({ success: false, error: "Document ID is required" }, { status: 400 });
    }

    debugLog("[GET] Step 2/6: Authenticating...");
    const user = await getAuthenticatedUser(request);
    if (!user) {
      debugLog("[GET] Auth failed: no user");
      return unauthorized();
    }
    debugLog("[GET] Authenticated as user:", user.id);

    debugLog("[GET] Step 3/6: Finding document...");
    const ownership = await findDocumentWithOwnership(id, user.id, {
      parentDocument: {
        include: { reviews: { orderBy: { createdAt: "desc" }, take: 1 } },
      },
    });
    if (ownership.status === "missing") {
      debugLog("[GET] Document not found:", id);
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    if (ownership.status === "forbidden") {
      debugLog("[GET] Forbidden: user", user.id, "does not own document", id);
      return forbidden();
    }
    const document = ownership.document;
    debugLog("[GET] Document found:", document.id, "version:", document.version);

    debugLog("[GET] Step 4/6: Finding latest review...");
    const review = await prisma.review.findFirst({
      where: { documentId: id },
      orderBy: { createdAt: "desc" },
    });
    debugLog("[GET] Review found:", review?.id ?? "none");

    const prevReview = document.parentDocument?.reviews?.[0] ?? null;
    debugLog("[GET] Previous review:", prevReview?.id ?? "none");

    debugLog("[GET] Step 5/6: Getting version chain...");
    let versionChain: Awaited<ReturnType<typeof getVersionChain>> = [];
    try {
      versionChain = await getVersionChain(id);
      debugLog("[GET] Version chain length:", versionChain?.length ?? 0);
    } catch (chainErr) {
      logError("GET getVersionChain", chainErr);
      versionChain = [];
    }

    debugLog("[GET] Step 6/6: Building response...");
    const rawScores = review ? safeJsonParse(review.strengths) : null;
    const isOldFormat = Array.isArray(rawScores) && rawScores.length > 0 && typeof rawScores[0] === "string";
    const scores = isOldFormat ? null : (rawScores as ReviewScore | null);

    return NextResponse.json({
      success: true,
      data: review ? {
        id: review.id,
        documentId: review.documentId,
        userId: review.userId,
        score: scores ? calculateAverageScore(scores) : review.score,
        overallQuality: scores?.overallQuality ?? { score: review.score, strengthsSummary: "", weaknessesSummary: "" },
        atsCompatibility: scores?.atsCompatibility ?? { score: review.score, missingKeywords: [], improvements: [] },
        competitiveness: scores?.competitiveness ?? { score: review.score, uniqueStrengths: "", differentiation: "" },
        topImprovements: safeArray(review.suggestions),
        quickWins: safeArray(review.grammarIssues),
        overallAssessment: review.overallFeedback,
        stage: scores?.stage,
        stageConfidence: scores?.stageConfidence,
        stageAssumption: scores?.stageAssumption,
        improvementSeverities: scores?.improvementSeverities,
        criteria: scores?.criteria,
        signatureCheck: review.signatureStatus
          ? {
              required: review.signatureRequired ?? review.signatureStatus !== "NOT_APPLICABLE",
              status: review.signatureStatus,
              note: review.signatureNote ?? "",
            }
          : null,
        modelUsed: review.modelUsed,
        createdAt: review.createdAt,
      } : null,
      document: {
        id: document.id,
        fileName: document.fileName,
        fileUrl: documentFileUrl(document),
        fileType: document.fileType,
        documentType: document.documentType,
        version: document.version ?? 1,
      },
      version: document.version ?? 1,
      improvementScore: document.improvementScore ?? null,
      prevScore: prevReview?.score ?? null,
      versionChain: versionChain ?? [],
    });
  } catch (err) {
    logError("GET top-level", err);
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }, { status: 500 });
  }
}
