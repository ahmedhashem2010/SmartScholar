import { describe, it, expect } from "vitest";
import {
  ageBandFor,
  ageFromDateOfBirth,
  assumptionNote,
  deriveCandidateStage,
  detectGradeFromCv,
  toPromptStage,
} from "@/lib/candidate-stage";
import { buildReviewPrompt } from "@/lib/ai-providers";

/* ------------------------------------------------------------------ */
/* Stage derivation.                                                    */
/*                                                                      */
/* The stage is the bar the review judges against, so these tests pin the */
/* decisions: age maps, explicit data wins, a higher target degree wins,  */
/* and missing data is admitted (low confidence) instead of guessed.     */
/* ------------------------------------------------------------------ */

const NOW = new Date("2026-09-01T12:00:00");

function dobForAge(age: number): Date {
  const dob = new Date(NOW);
  dob.setFullYear(dob.getFullYear() - age);
  dob.setDate(dob.getDate() - 1); // birthday already passed, so age is exact
  return dob;
}

describe("ageFromDateOfBirth", () => {
  it("computes exact age and rejects implausible dates", () => {
    expect(ageFromDateOfBirth(dobForAge(16), NOW)).toBe(16);
    expect(ageFromDateOfBirth(NOW, NOW)).toBeNull();
    expect(ageFromDateOfBirth("not-a-date", NOW)).toBeNull();
    expect(ageFromDateOfBirth(null, NOW)).toBeNull();
  });

  it("bands ages without exposing the exact number", () => {
    expect(ageBandFor(14)).toBe("15_or_under");
    expect(ageBandFor(16)).toBe("16_17");
    expect(ageBandFor(19)).toBe("18_21");
    expect(ageBandFor(24)).toBe("22_25");
    expect(ageBandFor(30)).toBe("26_plus");
    expect(ageBandFor(null)).toBe("unknown");
  });
});

describe("deriveCandidateStage — age mapping", () => {
  const cases: [number, string][] = [
    [14, "high_school_g10"],
    [15, "high_school_g10"],
    [16, "high_school_g11"],
    [17, "high_school_g12"],
  ];

  for (const [age, expected] of cases) {
    it(`maps age ${age} to ${expected} for a high-school profile`, () => {
      const stage = deriveCandidateStage({
        dateOfBirth: dobForAge(age),
        educationLevel: "high-school",
        now: NOW,
      });
      expect(stage.stage).toBe(expected);
      expect(stage.basis).toBe("dob");
      expect(stage.confidence).toBe("medium");
      expect(stage.ageBand).not.toBe("unknown");
    });
  }
});

describe("deriveCandidateStage — precedence", () => {
  it("lets an explicit grade field override the age mapping", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: dobForAge(15),
      grade: "12",
      educationLevel: "high-school",
      now: NOW,
    });
    expect(stage.stage).toBe("high_school_g12");
    expect(stage.basis).toBe("profile_grade");
    expect(stage.confidence).toBe("high");
  });

  it("judges a young applicant targeting a Master's as a Master's applicant", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: dobForAge(16),
      educationLevel: "high-school",
      targetDegree: "master",
      now: NOW,
    });
    expect(stage.stage).toBe("masters");
    expect(stage.basis).toBe("target_degree");
    expect(stage.confidence).toBe("high");
  });

  it("lets a Master's or PhD target override an explicit school grade", () => {
    expect(
      deriveCandidateStage({
        grade: "12",
        educationLevel: "high-school",
        targetDegree: "master",
        now: NOW,
      }).stage
    ).toBe("masters");
    expect(
      deriveCandidateStage({
        grade: "12",
        educationLevel: "high-school",
        targetDegree: "phd",
        now: NOW,
      }).stage
    ).toBe("phd_or_professional");
  });

  it("uses the CV Education section as a tiebreaker against the age hint", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: dobForAge(16),
      educationLevel: "high-school",
      cvText: "Education\nGrade 12 — Al Noor High School, 2024–2026\n",
      now: NOW,
    });
    expect(stage.stage).toBe("high_school_g12");
    expect(stage.basis).toBe("cv_education");
  });

  it("honours degree levels that are already stored", () => {
    expect(
      deriveCandidateStage({ educationLevel: "bachelor", targetDegree: "bachelor", now: NOW }).stage
    ).toBe("undergraduate");
    expect(
      deriveCandidateStage({ educationLevel: "master", targetDegree: "master", now: NOW }).stage
    ).toBe("masters");
    expect(
      deriveCandidateStage({ educationLevel: "phd", targetDegree: "phd", now: NOW }).stage
    ).toBe("phd_or_professional");
  });
});

describe("deriveCandidateStage — missing data is admitted, not guessed silently", () => {
  it("defaults to Grade 12 with low confidence and an assumption note", () => {
    const stage = deriveCandidateStage({ now: NOW });
    expect(stage.stage).toBe("high_school_g12");
    expect(stage.confidence).toBe("low");
    expect(stage.basis).toBe("default");
    expect(assumptionNote(stage)).toContain("Assumed Grade 12 applicant");
  });

  it("treats a date of birth defaulted to today as missing", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: NOW,
      educationLevel: "high-school",
      now: NOW,
    });
    expect(stage.stage).toBe("high_school_g12");
    expect(stage.confidence).toBe("low");
  });

  it("does not emit an assumption note when the stage is known", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: dobForAge(17),
      educationLevel: "high-school",
      now: NOW,
    });
    expect(assumptionNote(stage)).toBeNull();
  });
});

describe("detectGradeFromCv", () => {
  it("reads explicit grades and ignores unrelated numbers", () => {
    expect(detectGradeFromCv("Education\nGrade 11 — Al Noor High School")).toBe(11);
    expect(detectGradeFromCv("Education\n11th grade")).toBe(11);
    expect(detectGradeFromCv("Education\nClass 10")).toBe(10);
    expect(detectGradeFromCv("Education\nBSc Computer Science, 2024")).toBeNull();
    expect(detectGradeFromCv("Scored 11/12 in a course")).toBeNull();
  });

  it("prefers the Education section over the rest of the document", () => {
    const text = "Projects\nI mentored Grade 10 students.\n\nEducation\nGrade 12 — Al Noor\n";
    expect(detectGradeFromCv(text)).toBe(12);
  });
});

describe("privacy — the prompt never receives the date of birth", () => {
  it("serializes only the stage object and a coarse age band", () => {
    const dob = new Date("2009-05-04T00:00:00");
    const stage = deriveCandidateStage({ dateOfBirth: dob, educationLevel: "high-school", now: NOW });
    const prompt = buildReviewPrompt("Some CV text", "CV", false, stage);

    expect(stage.stage).toBe("high_school_g12");
    expect(prompt).not.toContain("2009-05-04");
    expect(prompt).not.toContain("2009");
    expect(prompt).toContain("high_school_g12");
    expect(prompt).toContain("Grade 12 high-school student");
    expect(prompt).not.toContain("dateOfBirth");
    expect(prompt).not.toContain("date_of_birth");
  });

  it("exposes no date fields in the object sent to the model", () => {
    const stage = deriveCandidateStage({
      dateOfBirth: dobForAge(16),
      educationLevel: "high-school",
      now: NOW,
    });
    const promptStage = toPromptStage(stage);
    expect(Object.keys(promptStage).sort()).toEqual([
      "age_band",
      "basis",
      "confidence",
      "stage",
      "target_degree",
    ]);
    expect(JSON.stringify(promptStage)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("includes the assumption note when the stage was assumed", () => {
    const stage = deriveCandidateStage({ now: NOW });
    const prompt = buildReviewPrompt("Some CV text", "CV", false, stage);
    expect(prompt).toContain("Assumed Grade 12 applicant");
    expect(prompt).toContain('"confidence": "low"');
  });
});
