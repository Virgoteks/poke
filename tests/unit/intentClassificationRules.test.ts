import { describe, expect, it } from "vitest";
import { classifyIntentDeterministic } from "../../src/domain/replyProcessing/intentClassificationRules.js";

describe("classifyIntentDeterministic", () => {
  it.each([
    "Please unsubscribe me from this list.",
    "Take me off your mailing list immediately.",
    "Stop emailing me please.",
    "I want to opt out.",
  ])("classifies '%s' as unsubscribe (no human review required)", (text) => {
    expect(classifyIntentDeterministic(text)).toEqual({ intent: "unsubscribe", requiresHuman: false });
  });

  it.each([
    "I've forwarded this to my attorney.",
    "This may violate GDPR, please respond.",
    "Cease and desist all communication immediately.",
  ])("classifies '%s' as legal_compliance and requires human review", (text) => {
    const result = classifyIntentDeterministic(text);
    expect(result?.intent).toBe("legal_compliance");
    expect(result?.requiresHuman).toBe(true);
  });

  it("classifies a hostile message and requires human review", () => {
    const result = classifyIntentDeterministic("This is a scam, fuck off and never contact me again.");
    expect(result?.intent).toBe("hostile");
    expect(result?.requiresHuman).toBe(true);
  });

  it.each([
    "I am currently out of the office and will respond when I return.",
    "This is an automatic reply -- I'm on vacation until next week.",
  ])("classifies '%s' as auto_reply (no human review required)", (text) => {
    expect(classifyIntentDeterministic(text)).toEqual({ intent: "auto_reply", requiresHuman: false });
  });

  it("returns null (defer to AI) for an ordinary reply with no matching pattern", () => {
    expect(classifyIntentDeterministic("Thanks for reaching out, tell me more about pricing.")).toBeNull();
    expect(classifyIntentDeterministic("Not interested at this time.")).toBeNull();
  });

  it("prioritizes legal/hostile classification over an unsubscribe request in the same message", () => {
    const result = classifyIntentDeterministic("Unsubscribe me now or I will contact my attorney.");
    expect(result?.intent).toBe("legal_compliance");
    expect(result?.requiresHuman).toBe(true);
  });
});
