export type ReplyIntent =
  | "unsubscribe"
  | "legal_compliance"
  | "hostile"
  | "auto_reply"
  | "interested"
  | "not_interested"
  | "question"
  | "other";

export interface DeterministicIntentResult {
  intent: ReplyIntent;
  requiresHuman: boolean;
}

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove me\b/i,
  /\bstop (emailing|contacting|messaging)\b/i,
  /\btake me off\b/i,
  /\bdo not (email|contact) me\b/i,
];

const LEGAL_COMPLIANCE_PATTERNS = [
  /\blawyer\b/i,
  /\battorney\b/i,
  /\blegal action\b/i,
  /\bcease and desist\b/i,
  /\bsue\b|\blawsuit\b/i,
  /\bgdpr\b/i,
  /\bcan-?spam\b/i,
  /\bcomplaint\b.*\b(regulator|ftc|attorney general|bbb)\b/i,
  /\bregulatory\b/i,
];

const HOSTILE_PATTERNS = [
  /\bfuck (you|off)\b/i,
  /\bscam\b/i,
  /\bharassment\b/i,
  /\bstalking\b/i,
  /\bpiece of (shit|garbage)\b/i,
  /\bnever (contact|email) me again\b.{0,20}\b(or|else)\b/i,
];

const AUTO_REPLY_PATTERNS = [
  /\bout of (the )?office\b/i,
  /\bauto([\s-])?reply\b/i,
  /\bautomatic reply\b/i,
  /\bon (vacation|leave|pto)\b/i,
  /\bcurrently unavailable\b/i,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Requirement: "Use deterministic rules before AI." Also the mechanism
 * behind requirement #10 ("legal/compliance/hostile replies must never
 * receive an AI-generated sales response") -- these categories are
 * caught here, deterministically, before any AI involvement, and always
 * carry requiresHuman: true so an automated reply can never be generated
 * for them regardless of what an AI classifier might otherwise decide.
 *
 * Returns null when none of the deterministic patterns match, meaning
 * the decision is deferred to AI classification (interested /
 * not_interested / question / other).
 */
export function classifyIntentDeterministic(replyBody: string): DeterministicIntentResult | null {
  // Legal/compliance/hostile checked first: if a message is both hostile
  // AND asking to unsubscribe, treat it as requiring human review rather
  // than silently auto-suppressing and moving on.
  if (matchesAny(LEGAL_COMPLIANCE_PATTERNS, replyBody)) {
    return { intent: "legal_compliance", requiresHuman: true };
  }
  if (matchesAny(HOSTILE_PATTERNS, replyBody)) {
    return { intent: "hostile", requiresHuman: true };
  }
  if (matchesAny(UNSUBSCRIBE_PATTERNS, replyBody)) {
    return { intent: "unsubscribe", requiresHuman: false };
  }
  if (matchesAny(AUTO_REPLY_PATTERNS, replyBody)) {
    return { intent: "auto_reply", requiresHuman: false };
  }
  return null;
}
