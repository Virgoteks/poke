export interface SchedulingLinkResult {
  bookingUrl: string;
  raw: unknown;
}

export interface CalendlyClient {
  /**
   * Returns a booking URL to hand a specific contact. The contact's id is
   * carried through Calendly's own UTM tracking (`utm_content`) so the
   * inbound webhook can correlate a completed booking back to the exact
   * contact who booked it without relying solely on email matching.
   */
  createSchedulingLink(contactId: string): Promise<SchedulingLinkResult>;
}
