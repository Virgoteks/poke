export const QUALIFICATION_TIERS = ["hot", "warm", "cold", "disqualified"] as const;
export type QualificationTier = (typeof QUALIFICATION_TIERS)[number];

/**
 * Only verified, structured facts ever go into the prompt — never free
 * text about the business that wasn't captured deterministically upstream
 * (AUDIT stage). This is the concrete mechanism behind "AI must never
 * invent facts about prospects": the model is not given room to invent,
 * because it is only shown a closed set of fields and told explicitly not
 * to assume anything beyond them.
 */
export interface QualificationFacts {
  companyName: string;
  categories: string[];
  googleRating: number | null;
  googleRatingCount: number | null;
  websitePresent: boolean;
  auditStatus: "completed" | "failed";
  auditError: string | null;
  pagespeedMobileScore: number | null;
  pagespeedDesktopScore: number | null;
  wordCount: number | null;
  hasContactForm: boolean | null;
  hasMobileViewportMeta: boolean | null;
  cmsGuess: string | null;
}

export interface QualificationAiResult {
  qualified: boolean;
  tier: QualificationTier;
  reasoning: string;
  confidence: number; // 0..1
}

export interface QualificationAiClient {
  classify(facts: QualificationFacts): Promise<QualificationAiResult>;
}
