/**
 * Candidate stage — derived on the server, never by the model.
 *
 * Why this exists: the review used to judge every CV against the same implicit
 * bar, which is an elite graduate applicant's. A 16-year-old with a school
 * robotics project and one olympiad was scored as if the absence of internships
 * and publications were a failure, when at that stage neither is expected.
 *
 * The stage comes from stored profile data (date of birth, education level,
 * target degree) plus, only as a tiebreaker, the Education section of the CV.
 * It is computed here — not asked of the LLM — because a model that can infer a
 * stage from prose can also hallucinate one, and the same CV should not be
 * judged differently on two runs.
 *
 * Privacy: the raw date of birth never leaves this module. Callers get a stage
 * and a coarse age band; the prompt only ever sees `toPromptStage()`.
 */

export type CandidateStage =
  | "high_school_g10"
  | "high_school_g11"
  | "high_school_g12"
  | "undergraduate"
  | "masters"
  | "phd_or_professional";

export type StageConfidence = "high" | "medium" | "low";

/**
 * Where the stage came from.
 *   profile_grade — explicit grade or education level on the profile
 *   dob           — derived from date of birth (a soft hint)
 *   cv_education  — the CV's own Education section, used as a tiebreaker
 *   target_degree — the stored target degree overrides the current level
 *                   (applying to a Master's is judged as a Master's applicant)
 *   default       — no usable data; assumed the most common stage
 */
export type StageBasis =
  | "profile_grade"
  | "dob"
  | "cv_education"
  | "target_degree"
  | "default";

export type AgeBand = "15_or_under" | "16_17" | "18_21" | "22_25" | "26_plus" | "unknown";

export interface CandidateStageInfo {
  stage: CandidateStage;
  /** Null when the profile has no target degree stored. */
  targetDegree: string | null;
  confidence: StageConfidence;
  basis: StageBasis;
  /** Coarse band only — safe to send to a model or write to a log. */
  ageBand: AgeBand;
}

export interface StageInput {
  dateOfBirth?: Date | string | null;
  /** Explicit grade, when a future profile field stores it ("10" | "11" | "12"). */
  grade?: string | number | null;
  /** Fallback when no date of birth is stored. */
  age?: number | null;
  educationLevel?: string | null;
  targetDegree?: string | null;
  /** Raw document text; only the Education section is inspected. */
  cvText?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

type Level = "high_school" | "bachelor" | "master" | "phd";
type Target = "bachelor" | "master" | "phd" | "exchange" | "summer";

function norm(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseEducationLevel(value: string | null | undefined): Level | null {
  const v = norm(value);
  if (!v) return null;
  if (/(highschool|secondary|secondaryschool|grade1[012]|schoolstudent)/.test(v)) return "high_school";
  if (/(phd|doctor|doctoral|doctorate)/.test(v)) return "phd";
  if (/(master|msc|masters|postgraduate|graduate)/.test(v)) return "master";
  if (/(bachelor|undergrad|bsc|ba|bs|licence|licentiate)/.test(v)) return "bachelor";
  return null;
}

export function parseTargetDegree(value: string | null | undefined): Target | null {
  const v = norm(value);
  if (!v) return null;
  if (/(phd|doctor|doctoral|doctorate)/.test(v)) return "phd";
  if (/(master|msc|masters|postgraduate)/.test(v)) return "master";
  if (/(exchange|visiting|summer)/.test(v)) return "exchange";
  if (/(bachelor|undergrad|bsc|ba|bs)/.test(v)) return "bachelor";
  return null;
}

/* ------------------------------------------------------------------ */
/* Age                                                                 */
/* ------------------------------------------------------------------ */

export function ageFromDateOfBirth(dob: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!dob) return null;
  const date = dob instanceof Date ? dob : new Date(dob);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() < 1900 || date > now) return null;

  let age = now.getFullYear() - date.getFullYear();
  const month = now.getMonth() - date.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < date.getDate())) age -= 1;

  // The profile API writes `new Date()` when dateOfBirth is absent, which looks
  // like a newborn. Treat anything implausible as missing rather than mapping a
  // data-entry bug to "Grade 10".
  return age >= 5 && age <= 100 ? age : null;
}

function plausibleAge(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 5 && value <= 100 ? Math.round(value) : null;
}

export function ageBandFor(age: number | null): AgeBand {
  if (age === null) return "unknown";
  if (age <= 15) return "15_or_under";
  if (age <= 17) return "16_17";
  if (age <= 21) return "18_21";
  if (age <= 25) return "22_25";
  return "26_plus";
}

/* ------------------------------------------------------------------ */
/* CV Education section (tiebreaker only)                              */
/* ------------------------------------------------------------------ */

const EPSILON = 1_200;

/** The first Education-like block, or a short prefix when no heading is found. */
function educationSection(text: string): string {
  const heading = /(?:^|\n)[^\S\n]*(?:education|academic background|academic qualifications|التعليم|المؤهلات العلمية|الخلفية الأكاديمية)[^\S\n]*:?[^\S\n]*\n/i;
  const match = heading.exec(text);
  if (!match) return text.slice(0, EPSILON);
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextHeading = /\n[^\S\n]*(?:experience|work experience|employment|projects|skills|languages|certifications|awards|الخبرة|المشاريع|المهارات|اللغات|الشهادات|الجوائز)[^\S\n]*:?[^\S\n]*\n/i;
  const end = nextHeading.exec(rest);
  return (end ? rest.slice(0, end.index) : rest.slice(0, EPSILON)).trim();
}

/**
 * Grade stated in the CV itself, e.g. "Grade 11", "11th grade", "Class 10".
 * Deliberately narrow: a CV that mentions "Grade A" or a university course code
 * must not be read as a school year.
 */
export function detectGradeFromCv(text: string | null | undefined): 10 | 11 | 12 | null {
  if (!text) return null;
  const section = educationSection(text);
  const patterns: RegExp[] = [
    /\bgrade\s*(10|11|12)\b/i,
    /\b(10|11|12)\s*(?:st|nd|rd|th)?\s*grade\b/i,
    /\bclass\s*(10|11|12)\b/i,
    /\b(10|11|12)\s*(?:st|nd|rd|th)\s*(?:year|standard)\b/i,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(section);
    if (m) {
      const n = Number(m[1]);
      if (n === 10 || n === 11 || n === 12) return n;
    }
  }
  if (/\b(?:high school|secondary school)\s+senior\b/i.test(section)) return 12;
  if (/\bfinal year of (?:high school|secondary school)\b/i.test(section)) return 12;
  return null;
}

function detectLevelFromCv(text: string | null | undefined): Level | null {
  if (!text) return null;
  const section = educationSection(text);
  if (/\b(ph\.?d|doctoral|doctorate)\b/i.test(section)) return "phd";
  if (/\b(master'?s?|msc|m\.?sc)\b/i.test(section)) return "master";
  if (/\b(bachelor'?s?|bsc|b\.?sc|undergraduate|university|college)\b/i.test(section)) return "bachelor";
  if (/\b(high school|secondary school)\b/i.test(section)) return "high_school";
  return null;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

function highSchoolStage(grade: 10 | 11 | 12): CandidateStage {
  return grade === 10 ? "high_school_g10" : grade === 11 ? "high_school_g11" : "high_school_g12";
}

function gradeFromKeyword(value: string | number | null | undefined): 10 | 11 | 12 | null {
  if (value === null || value === undefined) return null;
  const m = /(10|11|12)/.exec(String(value));
  if (!m) return null;
  const n = Number(m[1]);
  return n === 10 || n === 11 || n === 12 ? n : null;
}

export function deriveCandidateStage(input: StageInput): CandidateStageInfo {
  const now = input.now ?? new Date();
  const age = ageFromDateOfBirth(input.dateOfBirth, now) ?? plausibleAge(input.age);
  const ageBand = ageBandFor(age);
  const level = parseEducationLevel(input.educationLevel);
  const target = parseTargetDegree(input.targetDegree);
  const cvGrade = detectGradeFromCv(input.cvText);
  const cvLevel = detectLevelFromCv(input.cvText);
  const targetDegree = (input.targetDegree || "").trim() || null;

  const make = (
    stage: CandidateStage,
    confidence: StageConfidence,
    basis: StageBasis
  ): CandidateStageInfo => ({ stage, targetDegree, confidence, basis, ageBand });

  /* 1. A higher target degree overrides the current level — including an
   *    explicit school grade. Applying to a Master's is judged as a Master's
   *    applicant even if the profile says Grade 12: that is the standard the
   *    application will actually be read against. A Bachelor's target does not
   *    override, because that is the normal next step for a high-schooler. */
  if (target === "phd") return make("phd_or_professional", "high", "target_degree");
  if (target === "master") {
    // Someone already at PhD level applying to a Master's is still a PhD-level
    // applicant; otherwise the target is the bar.
    if (level === "phd") return make("phd_or_professional", "high", "target_degree");
    return make("masters", level || input.grade ? "high" : "medium", "target_degree");
  }

  /* 2. An explicit grade field wins for school-level applicants. */
  const explicitGrade = gradeFromKeyword(input.grade);
  if (explicitGrade) return make(highSchoolStage(explicitGrade), "high", "profile_grade");

  /* 3. Current education level. */
  if (level === "phd") return make("phd_or_professional", "high", "profile_grade");
  if (level === "master") return make("masters", "high", "profile_grade");
  if (level === "bachelor") return make("undergraduate", "high", "profile_grade");

  /* 4. High school: grade is not stored, so CV first (tiebreaker), then age. */
  if (level === "high_school") {
    if (cvGrade) return make(highSchoolStage(cvGrade), "medium", "cv_education");
    if (age !== null) {
      if (age <= 15) return make("high_school_g10", "medium", "dob");
      if (age === 16) return make("high_school_g11", "medium", "dob");
      return make("high_school_g12", "medium", "dob");
    }
    // No grade, no usable age: most high-school users of this product are in
    // their final year, so assume Grade 12 and say so in the review.
    return make("high_school_g12", "low", "default");
  }

  /* 5. No education level stored: use the CV, then age, then assume. */
  if (cvGrade) return make(highSchoolStage(cvGrade), "medium", "cv_education");
  if (cvLevel === "phd") return make("phd_or_professional", "medium", "cv_education");
  if (cvLevel === "master") return make("masters", "medium", "cv_education");
  if (cvLevel === "bachelor") return make("undergraduate", "medium", "cv_education");
  if (age !== null) {
    if (age <= 15) return make("high_school_g10", "medium", "dob");
    if (age === 16) return make("high_school_g11", "medium", "dob");
    if (age <= 17) return make("high_school_g12", "medium", "dob");
    if (age <= 21) return make("undergraduate", "medium", "dob");
    return make("masters", "low", "dob");
  }

  return make("high_school_g12", "low", "default");
}

/* ------------------------------------------------------------------ */
/* Presentation / prompt helpers                                       */
/* ------------------------------------------------------------------ */

const STAGE_LABELS: Record<CandidateStage, string> = {
  high_school_g10: "Grade 10 high-school student",
  high_school_g11: "Grade 11 high-school student",
  high_school_g12: "Grade 12 high-school student",
  undergraduate: "undergraduate student",
  masters: "Master's applicant",
  phd_or_professional: "PhD / professional applicant",
};

export function stageLabel(stage: CandidateStage): string {
  return STAGE_LABELS[stage];
}

/** The only shape that may be sent to a model. No DOB, no names, no ids. */
export function toPromptStage(info: CandidateStageInfo): {
  stage: CandidateStage;
  target_degree: string | null;
  confidence: StageConfidence;
  basis: StageBasis;
  age_band: AgeBand;
  assumption?: string;
} {
  const assumption = assumptionNote(info);
  return {
    stage: info.stage,
    target_degree: info.targetDegree,
    confidence: info.confidence,
    basis: info.basis,
    age_band: info.ageBand,
    ...(assumption ? { assumption } : {}),
  };
}

/** Short noun phrase for the assumption note, e.g. "Grade 12 applicant". */
const ASSUMPTION_LABELS: Record<CandidateStage, string> = {
  high_school_g10: "Grade 10 applicant",
  high_school_g11: "Grade 11 applicant",
  high_school_g12: "Grade 12 applicant",
  undergraduate: "undergraduate applicant",
  masters: "Master's applicant",
  phd_or_professional: "PhD / professional applicant",
};

/**
 * Shown in the review when the stage was assumed rather than known. Short, and
 * points at the fix (the profile), not at the student's document.
 */
export function assumptionNote(info: CandidateStageInfo): string | null {
  if (info.confidence !== "low") return null;
  return `Assumed ${ASSUMPTION_LABELS[info.stage]}; update your profile for a more accurate review.`;
}
