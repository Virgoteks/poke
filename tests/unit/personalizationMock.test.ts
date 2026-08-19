import { describe, expect, it } from "vitest";
import { MockOpenAiPersonalizationClient } from "../../src/integrations/openai/personalization/mockClient.js";
import type { PersonalizationFacts } from "../../src/integrations/openai/personalization/types.js";

function facts(overrides: Partial<PersonalizationFacts> = {}): PersonalizationFacts {
  return {
    companyName: "Acme Plumbing",
    contactFirstName: "Alex",
    contactTitle: "Owner",
    qualificationTier: "hot",
    qualificationReasoning: "Mobile PageSpeed score is 32",
    pagespeedMobileScore: 32,
    pagespeedDesktopScore: 40,
    hasContactForm: true,
    wordCount: 500,
    cmsGuess: "wordpress",
    websitePresent: true,
    senderName: "Ron Smith",
    senderCompany: "Smith Consulting SBC",
    ...overrides,
  };
}

describe("MockOpenAiPersonalizationClient", () => {
  it("greets the contact by first name when available", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(facts({ contactFirstName: "Jordan" }));
    expect(result.body).toContain("Hi Jordan,");
  });

  it("uses a generic greeting when no first name is available", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(facts({ contactFirstName: null }));
    expect(result.body).toContain("Hello,");
  });

  it("references the missing website when there is none, without inventing a PageSpeed score", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(
      facts({ websitePresent: false, pagespeedMobileScore: null, pagespeedDesktopScore: null }),
    );
    expect(result.body).toContain("doesn't appear to have a website");
    expect(result.body).not.toMatch(/\d+\/100/);
  });

  it("cites the actual mobile PageSpeed score when it is low", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(facts({ pagespeedMobileScore: 21 }));
    expect(result.body).toContain("21/100");
  });

  it("always signs off with the given sender name and company, never a fabricated one", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(facts({ senderName: "Test Sender", senderCompany: "Test Co" }));
    expect(result.body).toContain("Test Sender");
    expect(result.body).toContain("Test Co");
  });

  it("includes the company name in the subject line", async () => {
    const client = new MockOpenAiPersonalizationClient();
    const result = await client.generate(facts({ companyName: "Unique Corp Name" }));
    expect(result.subject).toContain("Unique Corp Name");
  });
});
