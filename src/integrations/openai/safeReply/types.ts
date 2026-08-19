/**
 * Closed fact set for drafting a safe automated reply. Only ever built
 * from data already on file (the original outreach we sent, the
 * prospect's own reply text, and already-verified qualification facts) --
 * never invented. This client is only ever invoked for replies the
 * deterministic classifier marked eligible (intent is "interested" or
 * "question" AND requiresHuman is false); legal/compliance/hostile/
 * unsubscribe replies never reach this code path at all.
 */
export interface SafeReplyFacts {
  companyName: string;
  contactFirstName: string | null;
  originalSubject: string | null;
  originalBody: string | null;
  incomingReplyText: string;
  intent: "interested" | "question";
  qualificationReasoning: string | null;
  senderName: string;
  senderCompany: string;
}

export interface SafeReplyResult {
  body: string;
}

export interface SafeReplyAiClient {
  generate(facts: SafeReplyFacts): Promise<SafeReplyResult>;
}
