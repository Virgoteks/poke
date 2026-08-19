import type { CalendlyClient, SchedulingLinkResult } from "./types.js";

/**
 * Deterministic mock -- same contactId always yields the same URL, no
 * network access, so tests can assert on the exact link produced.
 */
export class MockCalendlyClient implements CalendlyClient {
  async createSchedulingLink(contactId: string): Promise<SchedulingLinkResult> {
    const bookingUrl = `https://calendly.com/mock/smith-consulting-sbc/discovery-call?utm_content=${contactId}`;
    return { bookingUrl, raw: { mock: true, contactId, bookingUrl } };
  }
}
