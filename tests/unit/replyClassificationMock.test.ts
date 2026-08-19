import { describe, expect, it } from "vitest";
import { MockOpenAiReplyClassificationClient } from "../../src/integrations/openai/replyClassification/mockClient.js";

describe("MockOpenAiReplyClassificationClient", () => {
  it("classifies positive-sounding replies as interested", async () => {
    const client = new MockOpenAiReplyClassificationClient();
    const result = await client.classify("Sounds good, let's schedule a call.");
    expect(result.intent).toBe("interested");
  });

  it("classifies polite declines as not_interested", async () => {
    const client = new MockOpenAiReplyClassificationClient();
    const result = await client.classify("Thanks but not interested right now.");
    expect(result.intent).toBe("not_interested");
  });

  it("classifies questions as question", async () => {
    const client = new MockOpenAiReplyClassificationClient();
    const result = await client.classify("How much does this cost?");
    expect(result.intent).toBe("question");
  });

  it("classifies unclear replies as other with low confidence", async () => {
    const client = new MockOpenAiReplyClassificationClient();
    const result = await client.classify("ok");
    expect(result.intent).toBe("other");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
