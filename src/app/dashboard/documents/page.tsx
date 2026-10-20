"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UploadDropzone } from "@/components/documents/upload-dropzone";
import { ReviewQuota } from "@/components/documents/review-quota";
import { ReviewProgress } from "@/components/documents/review-progress";
import { DocumentSkeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { calculateAverageScore } from "@/lib/ai-review";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  FileText,
  Upload,
  Trash2,
  Eye,
  Sparkles,
  ArrowRight,
  Star,
} from "lucide-react";

interface Document {
  id: string;
  fileName: string;
  fileUrl: string;
  fileType: string;
  fileSize: number;
  documentType: string;
  version: number;
  improvementScore: number | null;
  parentDocumentId: string | null;
  uploadedAt: string;
}

const TYPE_LABELS: Record<string, { ar: string; en: string }> = {
  PERSONAL_STATEMENT: { ar: "خطاب الدوافع", en: "Personal Statement" },
  CV: { ar: "السيرة الذاتية", en: "CV / Resume" },
  MOTIVATION_LETTER: { ar: "خطاب التحفيز", en: "Motivation Letter" },
  RESEARCH_PROPOSAL: { ar: "المقترح البحثي", en: "Research Proposal" },
  RECOMMENDATION_LETTER: { ar: "خطاب التوصية", en: "Recommendation Letter" },
  TRANSCRIPT: { ar: "كشف الدرجات", en: "Transcripts" },
  OTHER: { ar: "مستند آخر", en: "Other" },
};

const TYPE_ICONS: Record<string, string> = {
  PERSONAL_STATEMENT: "bg-blue-100 text-blue-600",
  CV: "bg-emerald-100 text-emerald-600",
  MOTIVATION_LETTER: "bg-purple-100 text-purple-600",
  RESEARCH_PROPOSAL: "bg-amber-100 text-amber-600",
  RECOMMENDATION_LETTER: "bg-rose-100 text-rose-600",
  TRANSCRIPT: "bg-cyan-100 text-cyan-600",
  OTHER: "bg-muted text-muted-foreground",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string, isRTL: boolean): string {
  return new Date(dateStr).toLocaleDateString(isRTL ? "ar-EG" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function DocumentsPage() {
  const { pick, num, isRTL } = useLanguage();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [reviews, setReviews] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [quotaFailed, setQuotaFailed] = useState(false);
  const router = useRouter();
  const { addToast } = useToast();

  const fetchQuota = useCallback(async () => {
    try {
      const res = await fetch("/api/user/review-quota");
      const json = await res.json();
      if (json.success && json.data) {
        setQuota({ used: json.data.used, limit: json.data.limit });
        setQuotaFailed(false);
      } else {
        setQuotaFailed(true);
      }
    } catch {
      setQuotaFailed(true);
    }
  }, []);

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const json = await res.json();
      if (json.success) {
        setDocuments(json.data);

        const reviewMap: Record<string, any> = {};
        for (const doc of json.data as Document[]) {
          try {
            const reviewRes = await fetch(`/api/documents/${doc.id}/review`);
            if (!reviewRes.headers.get("content-type")?.includes("application/json")) continue;
            const reviewJson = await reviewRes.json();
            if (reviewJson.success && reviewJson.data) {
              reviewMap[doc.id] = reviewJson.data;
            }
          } catch {
            // individual check failed, skip
          }
        }
        setReviews(reviewMap);
      } else {
        if (res.status === 401) { router.push("/auth/login"); return; }
        setError(json.error);
      }
    } catch {
      setError(pick("تعذّر تحميل المستندات", "Failed to load documents"));
    } finally {
      setLoading(false);
    }
  }, [router, pick]);

  useEffect(() => {
    fetchDocuments();
    fetchQuota();
  }, [fetchDocuments, fetchQuota]);

  async function handleDelete(id: string) {
    if (!confirm(pick("حذف هذا المستند؟", "Delete this document?"))) return;
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (json.success) {
        setDocuments((prev) => prev.filter((d) => d.id !== id));
        addToast("success", pick("تم حذف المستند بنجاح", "Document deleted successfully"));
      } else {
        addToast("error", json.error ?? pick("فشل الحذف", "Delete failed"));
      }
    } catch {
      addToast("error", pick("فشل الحذف. حاول مرة أخرى.", "Delete failed. Please try again."));
    }
  }

  async function handleReview(docId: string) {
    setReviewingId(docId);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${docId}/review`, { method: "POST" });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        console.error("Non-JSON response from review POST:", text.slice(0, 200));
        setError(pick("فشلت مراجعة الذكاء الاصطناعي. استجابة غير متوقعة من الخادم.", "AI review failed. Server returned an unexpected response."));
        addToast("error", pick("فشلت مراجعة الذكاء الاصطناعي. خطأ في الخادم.", "AI review failed. Server error."));
        setReviewingId(null);
        fetchQuota();
        return;
      }
      const json = await res.json();
      if (json.success && json.data) {
        setReviews((prev) => ({ ...prev, [docId]: json.data }));
        addToast("success", pick(`اكتملت مراجعة الذكاء الاصطناعي. الدرجة: ${num(json.data.score)}/10`, `AI review completed. Score: ${json.data.score}/10`));
        router.push(`/dashboard/reviews/${docId}`);
      } else if (json.limitReached) {
        setError(json.message ?? json.error ?? pick("لقد وصلت إلى الحد اليومي للمراجعات المجانية", "You've reached your daily review limit"));
        addToast("error", json.message ?? json.error ?? pick("لقد وصلت إلى الحد اليومي للمراجعات المجانية", "You've reached your daily review limit"));
      } else {
        setError(json.message ?? json.error ?? pick("فشلت مراجعة الذكاء الاصطناعي", "AI review failed"));
        addToast("error", json.message ?? json.error ?? pick("فشلت مراجعة الذكاء الاصطناعي", "AI review failed"));
      }
    } catch {
      setError(pick("فشلت مراجعة الذكاء الاصطناعي. حاول مرة أخرى.", "AI review failed. Please try again."));
      addToast("error", pick("فشلت مراجعة الذكاء الاصطناعي. حاول مرة أخرى.", "AI review failed. Please try again."));
    } finally {
      setReviewingId(null);
      fetchQuota();
    }
  }

  const handleUploadComplete = () => {
    setShowUpload(false);
    addToast("success", pick("تم رفع المستند بنجاح", "Document uploaded successfully"));
    fetchDocuments();
  };

  if (loading) return <DocumentSkeleton />;

  return (
    <div className="page-container py-6 sm:py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-h3 font-bold">{pick("مستنداتي", "My Documents")}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {pick("ارفع مستنداتك وادِرها بسهولة", "Upload and manage your scholarship documents")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {quotaFailed ? null : quota ? (
            <ReviewQuota used={quota.used} limit={quota.limit} />
          ) : (
            <div className="h-7 w-48 animate-pulse rounded-full bg-muted" aria-hidden />
          )}
          <Link href="/dashboard">
            <Button variant="ghost" size="sm">
              <ArrowRight className="h-3.5 w-3.5 rotate-180 rtl:rotate-0" />
              {pick("لوحتي", "Dashboard")}
            </Button>
          </Link>
          {!showUpload && (
            <Button onClick={() => setShowUpload(true)} className="gap-1.5 shadow-sm">
              <Upload className="h-4 w-4" />
              {pick("ارفع مستنداً", "Upload Document")}
            </Button>
          )}
        </div>
      </div>

      {/* Upload Section */}
      {showUpload && (
        <div className="animate-fade-in rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-sm">{pick("رفع جديد", "New Upload")}</h2>
            </div>
            <button
              onClick={() => setShowUpload(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {pick("إلغاء", "Cancel")}
            </button>
          </div>
          <UploadDropzone onUploadComplete={handleUploadComplete} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && documents.length === 0 && (
        <div className="animate-fade-in rounded-2xl border-2 border-dashed border-border dark:border-slate-700 bg-card p-12 text-center">
          <div className="mx-auto max-w-sm">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
              <FileText className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {pick("لم ترفع أي مستند", "No documents yet")}
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {pick(
                "ارفع مستندك الأول لتحصل على تقييم بالذكاء الاصطناعي وتحسّن فرصك.",
                "Upload your first scholarship document to get AI-powered feedback and improve your chances."
              )}
            </p>
            <Button onClick={() => setShowUpload(true)} className="gap-1.5">
              <Upload className="h-4 w-4" />
              {pick("ارفع مستندك الأول", "Upload Your First Document")}
            </Button>
          </div>
        </div>
      )}

      {/* Document List */}
      {documents.length > 0 && (
        <div className="space-y-3">
          {documents.map((doc) => {
            const review = reviews[doc.id];
            const scoreValue = review ? calculateAverageScore(review) : 0;
            const scoreColor = scoreValue >= 8 ? "success" : scoreValue >= 6 ? "warning" : "danger";

            return (
              <div
                key={doc.id}
                className="group animate-fade-in rounded-xl border bg-card p-4 sm:p-5 transition-all hover:-translate-y-0.5 hover:shadow-md hover:border-primary-200 dark:hover:border-primary-700"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                      TYPE_ICONS[doc.documentType] ?? "bg-muted text-muted-foreground"
                    )}>
                      <FileText className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm text-foreground truncate">
                          {doc.fileName}
                        </p>
                        <StatusBadge status={`v${doc.version}`} className="shrink-0" showIcon={false} />
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                        <Badge variant="outline" className="text-[11px]">
                          {(() => {
                            const label = TYPE_LABELS[doc.documentType];
                            return label ? pick(label.ar, label.en) : doc.documentType;
                          })()}
                        </Badge>
                        <span className="text-muted-foreground">&middot;</span>
                        <span>{formatSize(doc.fileSize)}</span>
                        <span className="text-muted-foreground">&middot;</span>
                        <span>{formatDate(doc.uploadedAt, isRTL)}</span>
                      </div>
                      {review && (
                        <div className="mt-2 flex items-center gap-3">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1 max-w-[200px]">
                            <Star className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                            <ProgressBar value={scoreValue * 10} size="sm" color={scoreColor} className="flex-1" />
                            <span className="text-xs font-semibold tabular-nums shrink-0">
                              {num(scoreValue)}/10
                            </span>
                          </div>
                          {doc.improvementScore !== null && doc.improvementScore > 0 && (
                            <Badge variant="green" className="gap-1 text-[11px]">
                              <Sparkles className="h-3 w-3" />
                              {pick(`+${num(doc.improvementScore)} عن النسخة السابقة`, `+${doc.improvementScore} since last`)}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <a
                      href={`/api/documents/${doc.id}/file`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                    {review ? (
                      <Link href={`/dashboard/reviews/${doc.id}`}>
                        <Button size="sm" variant="outline" className="gap-1.5">
                          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                          {pick("المراجعة", "Review")}
                        </Button>
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReview(doc.id)}
                        disabled={reviewingId !== null}
                        className="gap-1.5"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {reviewingId === doc.id
                          ? pick("جارٍ المراجعة…", "Reviewing...")
                          : pick("مراجعة بالذكاء الاصطناعي", "AI Review")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleDelete(doc.id)}
                      className="text-muted-foreground hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ReviewProgress
        open={reviewingId !== null}
        fileName={documents.find((d) => d.id === reviewingId)?.fileName}
      />
    </div>
  );
}
