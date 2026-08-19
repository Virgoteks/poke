const DECISION_MAKER_TITLE_KEYWORDS = [
  "owner",
  "ceo",
  "chief executive",
  "president",
  "founder",
  "managing director",
  "general manager",
  "principal",
  "partner",
  "proprietor",
];

const DECISION_MAKER_SENIORITIES = new Set(["owner", "founder", "c_suite", "executive"]);

/**
 * Deterministic rule (requirement: "Use deterministic rules before AI") —
 * no AI is involved in identifying a decision maker. Apollo's own
 * `seniority` tag is used as a secondary signal, but the title keyword
 * match is the primary, auditable rule.
 */
export function isDecisionMakerTitle(title: string | null, seniority: string | null): boolean {
  const normalizedTitle = (title ?? "").toLowerCase();
  if (DECISION_MAKER_TITLE_KEYWORDS.some((keyword) => normalizedTitle.includes(keyword))) {
    return true;
  }
  if (seniority && DECISION_MAKER_SENIORITIES.has(seniority.toLowerCase())) {
    return true;
  }
  return false;
}
