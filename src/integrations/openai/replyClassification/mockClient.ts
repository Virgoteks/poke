import type { ReplyClassificationAiClient, ReplyClassificationResult } from "./types.js";

const INTERESTED_KEYWORDS = ["interested", "sounds good", "let's talk", "schedule", "call me", "yes please", "tell me more"];
const NOT_INTERESTED_KEYWORDS = ["not interested", "no thanks", "not right now", "we're good", "pass"];
const QUESTION_KEYWORDS = ["how much", "what is the cost", "?"];

/**
 * Deterministic mock: simple keyword matching over the literal reply
 * text, mirroring the "classify only what's given" contract.
 */
export class MockOpenAiReplyClassificationClient implements ReplyClassificationAiClient {
  async classify(replyBody: string): Promise<ReplyClassificationResult> {
    const lower = replyBody.toLowerCase();
    // Checked before the "interested" keyword list since phrases like
    // "not interested" would otherwise match "interested" as a substring.
    if (NOT_INTERESTED_KEYWORDS.some((k) => lower.includes(k))) {
      return { intent: "not_interested", confidence: 0.8 };
    }
    if (INTERESTED_KEYWORDS.some((k) => lower.includes(k))) {
      return { intent: "interested", confidence: 0.85 };
    }
    if (QUESTION_KEYWORDS.some((k) => lower.includes(k))) {
      return { intent: "question", confidence: 0.6 };
    }
    return { intent: "other", confidence: 0.3 };
  }
}
