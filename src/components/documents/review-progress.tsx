"use client";

import { StageProgress, type ProgressStage } from "@/components/ui/stage-progress";

/**
 * Full-screen progress indicator for an AI review.
 *
 * The review is one blocking provider call (10–30s typical, 40s timeout), and
 * the old UI only swapped a button label to "Reviewing…", which looks frozen on
 * a slow review. The shared overlay keeps a ring moving and names the stage the
 * pipeline is in.
 */

const STAGES: readonly ProgressStage[] = [
  { at: 0, ar: "قراءة مستندك واستخراج النص", en: "Reading your document" },
  { at: 5_000, ar: "تحليل المحتوى والبنية", en: "Analysing content and structure" },
  { at: 11_000, ar: "تقييم الجودة والتوافق مع ATS", en: "Scoring quality and ATS fit" },
  { at: 19_000, ar: "كتابة ملاحظات قابلة للتنفيذ", en: "Writing actionable feedback" },
];

interface ReviewProgressProps {
  open: boolean;
  /** Shown under the title so the student knows which file is being reviewed. */
  fileName?: string;
}

export function ReviewProgress({ open, fileName }: ReviewProgressProps) {
  return (
    <StageProgress
      open={open}
      fileName={fileName}
      gradientId="review-progress-gradient"
      title={{ ar: "الذكاء الاصطناعي يراجع مستندك", en: "AI is reviewing your document" }}
      badge={{ ar: "جارٍ التحليل", en: "Analysing" }}
      stages={STAGES}
      hint={{
        ar: "قد يستغرق هذا حتى ٤٠ ثانية. أبقِ هذه الصفحة مفتوحة.",
        en: "This can take up to 40 seconds. Please keep this page open.",
      }}
    />
  );
}
