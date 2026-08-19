import type { PersonalizationAiClient, PersonalizationFacts, PersonalizationResult } from "./types.js";

/**
 * Deterministic mock: builds the email from a small template that only
 * ever interpolates fields present in `facts`, mirroring the "cite only
 * given facts" contract the real client's system prompt enforces.
 */
export class MockOpenAiPersonalizationClient implements PersonalizationAiClient {
  async generate(facts: PersonalizationFacts): Promise<PersonalizationResult> {
    const greeting = facts.contactFirstName ? `Hi ${facts.contactFirstName},` : "Hello,";

    let observation: string;
    if (!facts.websitePresent) {
      observation = `I noticed ${facts.companyName} doesn't appear to have a website live yet.`;
    } else if (facts.pagespeedMobileScore !== null && facts.pagespeedMobileScore < 50) {
      observation = `I ran a quick check and ${facts.companyName}'s site scores ${facts.pagespeedMobileScore}/100 on mobile PageSpeed, which is likely costing you visitors.`;
    } else if (facts.hasContactForm === false) {
      observation = `I noticed ${facts.companyName}'s site doesn't have a visible contact form, which can cost you leads.`;
    } else {
      observation = `I took a look at ${facts.companyName}'s website and see a few quick wins worth a conversation.`;
    }

    const body = `${greeting}\n\n${observation} We help businesses like yours fix exactly this kind of issue.\n\nWould you be open to a quick 10-minute call this week?\n\nBest,\n${facts.senderName}\n${facts.senderCompany}`;

    return {
      subject: `Quick note about ${facts.companyName}'s website`,
      body,
    };
  }
}
