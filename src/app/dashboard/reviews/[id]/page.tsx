"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowUpRight, Award, CheckCircle2, ExternalLink, FileText, GraduationCap,
  HelpCircle, Lightbulb, PenLine, Sparkles, TrendingUp, Upload, Zap, AlertCircle,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { ConfettiTrigger } from "@/components/scholarship/confetti-trigger";
/**
 * Review results.
 *
 * The previous version of this page fetched a rich payload and then displayed
 * about a third of it. `versionChain`, `prevScore`, `improvementScore`,
 * `quickWins` and `overallAssessment` were all returned by the API and dropped
 * on the floor — which meant the single most motivating fact we have ("your
 * statement went from 5.8 to 7.4 after you rewrote it") was never shown to the
 * student who paid for it.
 *
 * It also showed the "upload your first document" empty state when a document
 * existed but hadn't been reviewed yet, telling users to redo work they'd
 * already done instead of pointing at the button they actually needed.
 */

interface ScoreBlock {
  overallQuality: { score: number; strengthsSummary: string; weaknessesSummary: string };
  atsCompatibility: { score: number; missingKeywords: string[]; improvements: string[] };
  competitiveness: { score: number; uniqueStrengths: string; differentiation: string };
}

interface SignatureCheckData {
  required: boolean;
  status: "SIGNED" | "NOT_SIGNED" | "UNCERTAIN" | "NOT_APPLICABLE";
  note: string;
}

type ImprovementSeverity = "high" | "medium" | "polish";

interface ReviewData extends ScoreBlock {
  id: string;
  score: number;
  topImprovements: string[];
  quickWins: string[];
  overallAssessment: string;
  signatureCheck: SignatureCheckData | null;
  /** Absent on reviews produced before stage-aware reviews existed. */
  stage?: string;
  stageConfidence?: "high" | "medium" | "low";
  stageAssumption?: string;
  improvementSeverities?: ImprovementSeverity[];
  createdAt: string;
}

/** Applicant-stage labels for the "reviewing as" chip. */
const STAGE_LABELS: Record<string, { ar: string; en: string }> = {
  high_school_g10: { ar: "طالب في الصف العاشر", en: "Grade 10 student" },
  high_school_g11: { ar: "طالب في الصف الحادي عشر", en: "Grade 11 student" },
  high_school_g12: { ar: "طالب في الصف الثاني عشر", en: "Grade 12 student" },
  undergraduate: { ar: "طالب بكالوريوس", en: "Undergraduate" },
  masters: { ar: "متقدّم للماجستير", en: "Master's applicant" },
  phd_or_professional: { ar: "متقدّم للدكتوراه أو مهني", en: "PhD / professional applicant" },
};

interface DocumentData {
  id: string;
  fileName: string;
  fileUrl: string | null;
  documentType: string | null;
  version: number;
}

interface VersionLink {
  id: string;
  version: number;
  score: number | null;
  isCurrent: boolean;
}

interface Payload {
  data: ReviewData | null;
  document: DocumentData | null;
  prevScore: number | null;
  versionChain: VersionLink[];
}

const DOC_TYPE_LABELS: Record<string, { ar: string; en: string }> = {
  CV: { ar: "السيرة الذاتية", en: "CV" },
  MOTIVATION_LETTER: { ar: "خطاب الدوافع", en: "Motivation letter" },
  PERSONAL_STATEMENT: { ar: "البيان الشخصي", en: "Personal statement" },
  RECOMMENDATION_LETTER: { ar: "خطاب توصية", en: "Recommendation letter" },
  RESEARCH_PROPOSAL: { ar: "المقترح البحثي", en: "Research proposal" },
  ESSAY: { ar: "مقال", en: "Essay" },
};

/** Scores are out of 10. Teal is the brand; amber and red carry real meaning. */
function toneFor(score: number) {
  if (score >= 8) return { text: "text-[rgb(var(--success))]", bg: "bg-[rgb(var(--success))]" };
  if (score >= 6) return { text: "text-primary", bg: "bg-primary" };
  if (score >= 4) return { text: "text-[rgb(var(--accent-warm))]", bg: "bg-[rgb(var(--accent-warm))]" };
  return { text: "text-destructive", bg: "bg-destructive" };
}

export default function ReviewResultsPage() {
  const params = useParams();
  const documentId = typeof params.id === "string" ? params.id : "";
  const { pick, num, isRTL } = useLanguage();

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confetti, setConfetti] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/documents/${documentId}/review`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        setError(pick("تعذّر تحميل المراجعة.", "Couldn't load this review."));
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error ?? pick("تعذّر تحميل المراجعة.", "Couldn't load this review."));
        return;
      }
      setPayload({
        data: json.data ?? null,
        document: json.document ?? null,
        prevScore: json.prevScore ?? null,
        versionChain: Array.isArray(json.versionChain) ? json.versionChain : [],
      });
      // Celebrate a genuinely strong result, not every result.
      if (json.data?.overallQuality?.score >= 8) setTimeout(() => setConfetti(true), 400);
    } catch {
      setError(pick("تعذّر الاتصال بالخادم.", "Couldn't reach the server."));
    } finally {
      setLoading(false);
    }
  }, [documentId, pick]);

  useEffect(() => {
    if (documentId) void load();
  }, [documentId, load]);

  if (loading) return <ReviewSkeleton />;

  if (error || !payload?.document) {
    return (
      <>
        <main className="page-container py-20 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-base font-medium text-foreground">
            {error ?? pick("لم نعثر على هذا المستند", "We couldn't find that document")}
          </p>
          <Link
            href="/dashboard/documents"
            className="mt-4 inline-block text-sm text-primary hover:underline"
          >
            {pick("العودة إلى مستنداتي", "Back to my documents")}
          </Link>
        </main>
      </>
    );
  }

  const { data: review, document: doc, prevScore, versionChain } = payload;
  const typeLabel = doc.documentType ? DOC_TYPE_LABELS[doc.documentType] ?? null : null;

  // A document with no review is NOT an empty account. The old page sent these
  // users back to re-upload a file they'd already uploaded successfully.
  if (!review) {
    return (
      <>
        <main className="page-container py-6 sm:py-8">
          <DocHeader doc={doc} typeLabel={typeLabel} />
          <div className="card-raised mt-8 p-8 text-center">
            <Sparkles className="mx-auto h-9 w-9 text-primary" />
            <h2 className="font-display mt-4 text-xl font-bold text-foreground">
              {pick("هذا المستند لم يُراجَع بعد", "This document hasn't been reviewed yet")}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {pick(
                "رفعك للملف تم بنجاح. لم يتبقَّ سوى تشغيل المراجعة — تستغرق أقل من دقيقة.",
                "Your upload worked fine. All that's left is running the review — it takes under a minute."
              )}
            </p>
            <Link href="/dashboard/documents">
              <button className="mt-6 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90">
                <Sparkles className="h-4 w-4" />
                {pick("تشغيل المراجعة", "Run the review")}
              </button>
            </Link>
          </div>
        </main>
      </>
    );
  }

  const overall = review.score;
  const delta = prevScore !== null ? Number((overall - prevScore).toFixed(1)) : null;
  const stageLabel = review.stage ? STAGE_LABELS[review.stage] : undefined;

  return (
    <>
      <ConfettiTrigger trigger={confetti} />
      <main className="page-container py-6 sm:py-8">
        <DocHeader doc={doc} typeLabel={typeLabel} />

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {/* Headline score ----------------------------------------- */}
            <div className="card-raised overflow-hidden">
              <div className="brand-band px-6 py-7 text-center text-white">
                <p className="text-xs font-medium uppercase tracking-wide text-white/70">
                  {pick("التقييم العام", "Overall score")}
                </p>
                <p className="font-display mt-1 text-5xl font-bold" dir="ltr">
                  {num(overall)}
                  <span className="text-2xl font-medium text-white/60">/{num(10)}</span>
                </p>

                {delta !== null && (
                  <p
                    className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                      delta > 0 ? "bg-white/20 text-white" : "bg-white/10 text-white/80"
                    }`}
                  >
                    <TrendingUp className={`h-3.5 w-3.5 ${delta < 0 ? "rotate-180" : ""}`} />
                    {delta > 0
                      ? pick(
                          `تحسّن ${num(Math.abs(delta))} نقطة عن النسخة السابقة`,
                          `Up ${Math.abs(delta)} points from your last version`
                        )
                      : delta < 0
                        ? pick(
                            `انخفاض ${num(Math.abs(delta))} نقطة عن النسخة السابقة`,
                            `Down ${Math.abs(delta)} points from your last version`
                          )
                        : pick("نفس تقييم النسخة السابقة", "Same as your last version")}
                  </p>
                )}

                {stageLabel && (
                  <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white">
                    <GraduationCap className="h-3.5 w-3.5" />
                    {pick(`تُراجَع كـ: ${stageLabel.ar}`, `Reviewing as: ${stageLabel.en}`)}
                  </p>
                )}
              </div>

              {review.stageConfidence === "low" && stageLabel && (
                <div className="flex items-start gap-2 border-b border-border bg-[rgb(var(--accent-warm))]/10 px-5 py-3">
                  <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--accent-warm))]" />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {pick(
                      `افترضنا أن مستواك: ${stageLabel.ar}. حدّث ملفك الشخصي للحصول على مراجعة أدق.`,
                      `Assumed ${stageLabel.en}; update your profile for a more accurate review.`
                    )}
                  </p>
                </div>
              )}

              <div className="grid gap-px bg-border sm:grid-cols-3">
                <SubScore
                  icon={<Award className="h-4 w-4" />}
                  label={pick("جودة المحتوى", "Content quality")}
                  score={review.overallQuality.score}
                />
                <SubScore
                  icon={<FileText className="h-4 w-4" />}
                  label={pick("التوافق مع أنظمة الفرز", "ATS compatibility")}
                  score={review.atsCompatibility.score}
                />
                <SubScore
                  icon={<TrendingUp className="h-4 w-4" />}
                  label={pick("القدرة التنافسية", "Competitiveness")}
                  score={review.competitiveness.score}
                />
              </div>
            </div>

            {/* Signature check ---------------------------------------- */}
            {review.signatureCheck && review.signatureCheck.status !== "NOT_APPLICABLE" && (
              <SignaturePanel check={review.signatureCheck} />
            )}

            {/* Strengths / weaknesses --------------------------------- */}
            <div className="grid gap-4 sm:grid-cols-2">
              {review.overallQuality.strengthsSummary && (
                <Panel
                  tone="good"
                  title={pick("نقاط القوة", "What's working")}
                  body={review.overallQuality.strengthsSummary}
                />
              )}
              {review.overallQuality.weaknessesSummary && (
                <Panel
                  tone="warn"
                  title={pick("ما يحتاج إلى عمل", "What needs work")}
                  body={review.overallQuality.weaknessesSummary}
                />
              )}
            </div>

            {/* Top improvements --------------------------------------- */}
            {review.topImprovements.length > 0 && (
              <Section
                icon={<Lightbulb className="h-4 w-4 text-primary" />}
                title={pick("أهم التحسينات", "Top improvements")}
                subtitle={pick(
                  "مرتّبة حسب الأثر — ابدأ بالأولى.",
                  "Ordered by impact — start with the first."
                )}
              >
                <ol className="space-y-3">
                  {review.topImprovements.map((item, i) => {
                    const severity = review.improvementSeverities?.[i];
                    return (
                      <li key={i} className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-bold text-primary">
                          {num(i + 1)}
                        </span>
                        <div>
                          {severity && (
                            <span
                              className={`mb-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                severity === "high"
                                  ? "bg-destructive/10 text-destructive"
                                  : severity === "medium"
                                    ? "bg-[rgb(var(--accent-warm))]/15 text-[rgb(var(--accent-warm))]"
                                    : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {severity === "high"
                                ? pick("أولوية عالية", "High priority")
                                : severity === "medium"
                                  ? pick("أولوية متوسطة", "Medium priority")
                                  : pick("تحسين", "Polish")}
                            </span>
                          )}
                          <p className="text-sm leading-relaxed text-muted-foreground">{item}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </Section>
            )}

            {/* Quick wins --------------------------------------------- */}
            {review.quickWins.length > 0 && (
              <Section
                icon={<Zap className="h-4 w-4 text-[rgb(var(--accent-warm))]" />}
                title={pick("إصلاحات سريعة", "Quick wins")}
                subtitle={pick("دقائق معدودة لكل واحدة.", "A couple of minutes each.")}
              >
                <ul className="space-y-2">
                  {review.quickWins.map((item, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2.5 rounded-lg bg-[rgb(var(--accent-warm))]/10 p-3"
                    >
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--accent-warm))]" />
                      <span className="text-sm text-muted-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* Missing keywords --------------------------------------- */}
            {review.atsCompatibility.missingKeywords.length > 0 && (
              <Section
                icon={<FileText className="h-4 w-4 text-primary" />}
                title={pick("كلمات مفتاحية ناقصة", "Missing keywords")}
                subtitle={pick(
                  "أنظمة الفرز الآلي تبحث عن هذه المصطلحات.",
                  "Automated screening systems look for these terms."
                )}
              >
                <div className="flex flex-wrap gap-2">
                  {review.atsCompatibility.missingKeywords.map((k, i) => (
                    <span
                      key={i}
                      className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {review.overallAssessment && (
              <div className="rounded-xl border-s-4 border-primary bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">
                  {pick("الخلاصة", "Overall assessment")}
                </h3>
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                  {review.overallAssessment}
                </p>
              </div>
            )}
          </div>

          {/* Sidebar ------------------------------------------------- */}
          <aside className="space-y-4">
            <div className="card-raised p-5">
              <h2 className="text-sm font-semibold text-foreground">
                {pick("الخطوة التالية", "Next step")}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {pick(
                  "طبّق التحسينات أعلاه ثم ارفع نسخة جديدة — سنقارن التقييمين لك.",
                  "Apply the improvements above, then upload a new version — we'll compare the scores for you."
                )}
              </p>
              <Link href="/dashboard/documents">
                <button className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90">
                  <Upload className="h-4 w-4" />
                  {pick("رفع نسخة محسّنة", "Upload improved version")}
                </button>
              </Link>
            </div>

            {/* Version history — the reason to come back. */}
            {versionChain.length > 1 && (
              <div className="card-raised p-5">
                <h2 className="text-sm font-semibold text-foreground">
                  {pick("سجلّ النسخ", "Version history")}
                </h2>
                <ol className="mt-3 space-y-2">
                  {versionChain.map((v) => (
                    <li key={v.id}>
                      <Link
                        href={`/dashboard/reviews/${v.id}`}
                        className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                          v.isCurrent
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <span>{pick(`النسخة ${num(v.version)}`, `Version ${v.version}`)}</span>
                        <span dir="ltr" className="tabular-nums">
                          {v.score !== null ? `${num(v.score)}/10` : "—"}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* The old page reserved 40% of the layout for a PDF viewer that
                rendered "temporarily disabled". A link that works beats a
                placeholder that doesn't. */}
            {doc.fileUrl && (
              <a
                href={`/api/documents/${doc.id}/file`}
                target="_blank"
                rel="noopener noreferrer"
                className="card-raised flex items-center gap-3 p-4 transition-colors hover:bg-muted"
              >
                <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {doc.fileName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pick("فتح الملف الأصلي", "Open the original file")}
                  </span>
                </span>
                <ExternalLink
                  className={`h-4 w-4 shrink-0 text-muted-foreground ${isRTL ? "scale-x-[-1]" : ""}`}
                />
              </a>
            )}
          </aside>
        </div>
      </main>
    </>
  );
}

/* ------------------------------------------------------------------ */

function DocHeader({
  doc,
  typeLabel,
}: {
  doc: DocumentData;
  typeLabel: { ar: string; en: string } | null;
}) {
  const { pick, num } = useLanguage();
  return (
    <>
      <Link
        href="/dashboard/documents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowUpRight className="h-4 w-4 rotate-180" />
        {pick("مستنداتي", "My documents")}
      </Link>
      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          {typeLabel && (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {pick(typeLabel.ar, typeLabel.en)}
            </span>
          )}
          <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
            {pick(`النسخة ${num(doc.version)}`, `Version ${doc.version}`)}
          </span>
        </div>
        <h1 className="font-display mt-3 truncate text-2xl font-bold text-foreground sm:text-3xl">
          {doc.fileName}
        </h1>
      </header>
    </>
  );
}

function SubScore({
  icon,
  label,
  score,
}: {
  icon: React.ReactNode;
  label: string;
  score: number;
}) {
  const { num } = useLanguage();
  const tone = toneFor(score);
  return (
    <div className="bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className={`mt-2 text-2xl font-bold ${tone.text}`} dir="ltr">
        {num(score)}
        <span className="text-sm font-medium text-muted-foreground">/{num(10)}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone.bg}`} style={{ width: `${score * 10}%` }} />
      </div>
    </div>
  );
}

function Panel({ tone, title, body }: { tone: "good" | "warn"; title: string; body: string }) {
  const colour =
    tone === "good"
      ? "border-[rgb(var(--success))]/25 bg-[rgb(var(--success))]/10"
      : "border-[rgb(var(--accent-warm))]/25 bg-[rgb(var(--accent-warm))]/10";
  return (
    <div className={`rounded-xl border p-4 ${colour}`}>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * Signature verdict from the review service. `NOT_APPLICABLE` is the common
 * case (CVs, personal statements) and renders nothing; the other three
 * statuses carry a message worth showing the student.
 */
function SignaturePanel({ check }: { check: SignatureCheckData }) {
  const { pick } = useLanguage();

  const copy: Record<
    Exclude<SignatureCheckData["status"], "NOT_APPLICABLE">,
    { tone: "good" | "warn" | "muted"; title: string; body: string }
  > = {
    SIGNED: {
      tone: "good",
      title: pick("تم العثور على توقيع", "Signature detected"),
      body: pick(
        "يبدو أن هذا المستند يتضمّن توقيعاً، لذا يمكنك تقديمه كما هو.",
        "This document appears to include a signature, so it's ready to submit as-is."
      ),
    },
    NOT_SIGNED: {
      tone: "warn",
      title: pick("يحتاج إلى توقيع", "Needs your signature"),
      body: pick(
        "هذا النوع من المستندات يُوقَّع عادةً، ولم نعثر على توقيع في النص. أضف توقيعك ثم ارفع نسخة جديدة.",
        "This kind of document is normally signed, but we couldn't find a signature in the text. Add yours, then upload a new version."
      ),
    },
    UNCERTAIN: {
      tone: "muted",
      title: pick("تعذّر التأكد من التوقيع", "Couldn't confirm the signature"),
      body: pick(
        "لم نتمكن من الجزم مما إذا كان هذا المستند يتطلب توقيعاً. راجع شروط المنحة قبل التقديم.",
        "We couldn't tell whether this document needs a signature. Check the scholarship's requirements before you submit."
      ),
    },
  };

  const cfg = copy[check.status as Exclude<SignatureCheckData["status"], "NOT_APPLICABLE">];
  const icon =
    cfg.tone === "good" ? (
      <CheckCircle2 className="h-4 w-4 text-[rgb(var(--success))]" />
    ) : cfg.tone === "warn" ? (
      <PenLine className="h-4 w-4 text-[rgb(var(--accent-warm))]" />
    ) : (
      <HelpCircle className="h-4 w-4 text-muted-foreground" />
    );
  const border =
    cfg.tone === "good"
      ? "border-[rgb(var(--success))]/25 bg-[rgb(var(--success))]/10"
      : cfg.tone === "warn"
        ? "border-[rgb(var(--accent-warm))]/25 bg-[rgb(var(--accent-warm))]/10"
        : "border-border bg-card";

  return (
    <div className={`rounded-xl border p-4 ${border}`}>
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{cfg.title}</h3>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{cfg.body}</p>
      {check.note && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground/80">{check.note}</p>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card-raised p-5">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </div>
  );
}

function ReviewSkeleton() {
  return (
    <>
      <main className="page-container animate-pulse py-8">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="mt-4 h-8 w-2/3 rounded bg-muted" />
        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="h-56 rounded-2xl bg-muted" />
            <div className="h-32 rounded-2xl bg-muted" />
            <div className="h-40 rounded-2xl bg-muted" />
          </div>
          <div className="h-48 rounded-2xl bg-muted" />
        </div>
      </main>
    </>
  );
}
