import { describe, expect, it } from "vitest";
import { MockOpenAiSafeReplyClient } from "../../src/integrations/openai/safeReply/mockClient.js";
import type { SafeReplyFacts } from "../../src/integrations/openai/safeReply/types.js";

function facts(overrides: Partial<SafeReplyFacts> = {}): SafeReplyFacts {
  return {
    companyName: "Acme Plumbing",
    contactFirstName: "Alex",
    originalSubject: "Quick note",
    originalBody: "Hi, I noticed...",
    incomingReplyText: "Sounds interesting, tell me more!",
    intent: "interested",
    qualificationReasoning: "PageSpeed score is 40",
    senderName: "Ron Smith",
    senderCompany: "Smith Consulting SBC",
    ...overrides,
  };
}

describe("MockOpenAiSafeReplyClient", () => {
  it("greets by first name and proposes a call", async () => {
    const client = new MockOpenAiSafeReplyClient();
    const result = await client.generate(facts());
    expect(result.body).toContain("Hi Alex,");
    expect(result.body.toLowerCase()).toContain("call");
  });

  it("acknowledges a question differently from a general interest reply", async () => {
    const client = new MockOpenAiSafeReplyClient();
    const questionReply = await client.generate(facts({ intent: "question" }));
    const interestedReply = await client.generate(facts({ intent: "interested" }));
    expect(questionReply.body).not.toBe(interestedReply.body);
  });

  it("always signs off with the given sender name and company", async () => {
    const client = new MockOpenAiSafeReplyClient();
    const result = await client.generate(facts({ senderName: "Test Sender", senderCompany: "Test Co" }));
    expect(result.body).toContain("Test Sender");
    expect(result.body).toContain("Test Co");
  });

  it("never mentions a specific price or guarantee", async () => {
    const client = new MockOpenAiSafeReplyClient();
    const result = await client.generate(facts());
    expect(result.body.toLowerCase()).not.toMatch(/\$\d|guarantee/);
  });
});
