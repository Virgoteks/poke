import type { SafeReplyAiClient, SafeReplyFacts, SafeReplyResult } from "./types.js";

/**
 * Deterministic mock: a small template that only ever interpolates given
 * fields, never inventing new claims.
 */
export class MockOpenAiSafeReplyClient implements SafeReplyAiClient {
  async generate(facts: SafeReplyFacts): Promise<SafeReplyResult> {
    const greeting = facts.contactFirstName ? `Hi ${facts.contactFirstName},` : "Hello,";

    const acknowledgement =
      facts.intent === "question"
        ? "Great question -- happy to walk through the specifics on a quick call rather than guess at details over email."
        : "Glad to hear you're interested!";

    const body = `${greeting}\n\n${acknowledgement} Would you have 10-15 minutes this week for a quick call to discuss ${facts.companyName}'s website?\n\nBest,\n${facts.senderName}\n${facts.senderCompany}`;

    return { body };
  }
}
