/**
 * A closed set of already-verified facts, mirroring the qualification
 * facts pattern (Milestone 4): the model is only ever given these
 * fields, never free text about the prospect, so it structurally cannot
 * invent details ("AI must never invent facts about prospects").
 */
export interface PersonalizationFacts {
  companyName: string;
  contactFirstName: string | null;
  contactTitle: string | null;
  qualificationTier: string;
  qualificationReasoning: string | null;
  pagespeedMobileScore: number | null;
  pagespeedDesktopScore: number | null;
  hasContactForm: boolean | null;
  wordCount: number | null;
  cmsGuess: string | null;
  websitePresent: boolean;
  senderName: string;
  senderCompany: string;
}

export interface PersonalizationResult {
  subject: string;
  body: string;
}

export interface PersonalizationAiClient {
  generate(facts: PersonalizationFacts): Promise<PersonalizationResult>;
}
