"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

/**
 * Full-screen progress indicator for an AI review.
 *
 * The review is one blocking provider call (10–30s typical, 40s timeout), and
 * the old UI only swapped a button label to "Reviewing…", which looks frozen on
 * a slow review. This shows a ring that keeps moving and names the stage the
 * pipeline is in.
 *
 * The percentage is time-based, not real progress — there is no streaming or
 * job API behind the route, so claiming exact progress would be a lie. It eases
 * toward 94% and stops there until the request resolves, which is honest about
 * "still working, not done" while never appearing stuck.
 */

const STAGES = [
  { at: 0, ar: "قراءة مستندك واستخراج النص", en: "Reading your document" },
  { at: 5_000, ar: "تحليل المحتوى والبنية", en: "Analysing content and structure" },
  { at: 11_000, ar: "تقييم الجودة والتوافق مع ATS", en: "Scoring quality and ATS fit" },
  { at: 19_000, ar: "كتابة ملاحظات قابلة للتنفيذ", en: "Writing actionable feedback" },
] as const;

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Approaches 94% without ever claiming completion. ~34% at 5s, ~80% at 20s. */
function progressFor(elapsedMs: number): number {
  return Math.min(94, 94 * (1 - Math.exp(-elapsedMs / 12_000)));
}

interface ReviewProgressProps {
  open: boolean;
  /** Shown under the title so the student knows which file is being reviewed. */
  fileName?: string;
}

export function ReviewProgress({ open, fileName }: ReviewProgressProps) {
  const { pick } = useLanguage();
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!open) {
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAt.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [open]);

  if (!open) return null;

  const percent = progressFor(elapsed);
  const stageIndex = STAGES.reduce((acc, stage, i) => (elapsed >= stage.at ? i : acc), 0);
  const activeStage = STAGES[stageIndex] ?? STAGES[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm motion-safe:animate-fade-in"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <div className="relative flex h-36 w-36 items-center justify-center">
            {/* Soft halo: makes the ring feel alive even between ticks. */}
            <div
              className="absolute inset-4 rounded-full bg-primary/15 blur-xl motion-safe:animate-pulse motion-reduce:hidden"
              aria-hidden
            />
            <svg viewBox="0 0 120 120" className="h-36 w-36 -rotate-90" aria-hidden>
              <circle
                cx="60"
                cy="60"
                r={RADIUS}
                fill="none"
                stroke="rgb(var(--muted))"
                strokeWidth="8"
              />
              <circle
                cx="60"
                cy="60"
                r={RADIUS}
                fill="none"
                stroke="url(#review-progress-gradient)"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
                className="transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
              />
              <defs>
                <linearGradient id="review-progress-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--primary-500))" />
                  <stop offset="100%" stopColor="rgb(var(--primary-300))" />
                </linearGradient>
              </defs>
            </svg>
            <div className="absolute flex flex-col items-center">
              <span className="text-2xl font-bold tabular-nums">{Math.round(percent)}%</span>
              <span className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {pick("جارٍ التحليل", "Analysing")}
              </span>
            </div>
          </div>

          <h2 className="mt-4 text-base font-semibold text-foreground">
            {pick("الذكاء الاصطناعي يراجع مستندك", "AI is reviewing your document")}
          </h2>
          {fileName && (
            <p className="mt-1 max-w-[16rem] truncate text-xs text-muted-foreground" title={fileName}>
              {fileName}
            </p>
          )}
        </div>

        <ul className="mt-5 space-y-2.5">
          {STAGES.map((stage, index) => {
            const done = index < stageIndex;
            const active = index === stageIndex;
            return (
              <li
                key={stage.en}
                className={cn(
                  "flex items-center gap-2.5 text-xs transition-colors",
                  done && "text-muted-foreground",
                  active && "font-medium text-foreground",
                  !done && !active && "text-muted-foreground/60"
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                    done && "border-success-500 bg-success-500 text-white",
                    active && "border-primary-500 text-primary-500",
                    !done && !active && "border-border"
                  )}
                  aria-hidden
                >
                  {done ? (
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                  ) : active ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-500 motion-safe:animate-pulse" />
                  ) : null}
                </span>
                <span className="text-start">{pick(stage.ar, stage.en)}</span>
              </li>
            );
          })}
        </ul>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-muted-foreground">
          {pick(
            "قد يستغرق هذا حتى ٤٠ ثانية. أبقِ هذه الصفحة مفتوحة.",
            "This can take up to 40 seconds. Please keep this page open."
          )}
        </p>
        <span className="sr-only">{pick(activeStage.ar, activeStage.en)}</span>
      </div>
    </div>
  );
}
