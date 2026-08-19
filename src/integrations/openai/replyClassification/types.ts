export const AI_REPLY_INTENTS = ["interested", "not_interested", "question", "other"] as const;
export type AiReplyIntent = (typeof AI_REPLY_INTENTS)[number];

export interface ReplyClassificationResult {
  intent: AiReplyIntent;
  confidence: number; // 0..1
}

export interface ReplyClassificationAiClient {
  /**
   * The reply's own literal text is the only input -- classifying what
   * someone actually wrote is not "inventing a fact about the prospect".
   * Deterministic rules (intentClassificationRules.ts) already remove
   * unsubscribe/legal/hostile/auto-reply cases before this is ever
   * called, so the model only ever has to pick among these four.
   */
  classify(replyBody: string): Promise<ReplyClassificationResult>;
}
