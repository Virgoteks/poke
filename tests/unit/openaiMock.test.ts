import { describe, expect, it } from "vitest";
import { MockOpenAiQualificationClient } from "../../src/integrations/openai/mockClient.js";
import type { QualificationFacts } from "../../src/integrations/openai/types.js";

function facts(overrides: Partial<QualificationFacts> = {}): QualificationFacts {
  return {
    companyName: "Acme",
    categories: ["plumber"],
    googleRating: 4.5,
    googleRatingCount: 20,
    websitePresent: true,
    auditStatus: "completed",
    auditError: null,
    pagespeedMobileScore: 60,
    pagespeedDesktopScore: 60,
    wordCount: 400,
    hasContactForm: true,
    hasMobileViewportMeta: true,
    cmsGuess: "wordpress",
    ...overrides,
  };
}

describe("MockOpenAiQualificationClient", () => {
  it("classifies low scores as hot and qualified", async () => {
    const client = new MockOpenAiQualificationClient();
    const result = await client.classify(facts({ pagespeedMobileScore: 20, pagespeedDesktopScore: 20 }));
    expect(result.tier).toBe("hot");
    expect(result.qualified).toBe(true);
    expect(result.reasoning).toContain("20");
  });

  it("classifies high scores as cold and disqualified", async () => {
    const client = new MockOpenAiQualificationClient();
    const result = await client.classify(facts({ pagespeedMobileScore: 92, pagespeedDesktopScore: 95 }));
    expect(result.tier).toBe("cold");
    expect(result.qualified).toBe(false);
  });

  it("classifies mid-range scores as warm", async () => {
    const client = new MockOpenAiQualificationClient();
    const result = await client.classify(facts({ pagespeedMobileScore: 60, pagespeedDesktopScore: 65 }));
    expect(result.tier).toBe("warm");
    expect(result.qualified).toBe(true);
  });

  it("only cites fields present in the input within its reasoning (no fabricated facts)", async () => {
    const client = new MockOpenAiQualificationClient();
    const result = await client.classify(facts({ pagespeedMobileScore: 10, pagespeedDesktopScore: 10 }));
    // The mock's reasoning is generated purely from the numeric scores; it
    // should never reference unset fields like employee count / revenue.
    expect(result.reasoning.toLowerCase()).not.toContain("employee");
    expect(result.reasoning.toLowerCase()).not.toContain("revenue");
  });

  it("returns a low-confidence warm default when no PageSpeed scores are available", async () => {
    const client = new MockOpenAiQualificationClient();
    const result = await client.classify(facts({ pagespeedMobileScore: null, pagespeedDesktopScore: null }));
    expect(result.tier).toBe("warm");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
