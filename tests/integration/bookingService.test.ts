import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { BookingService, type IncomingCalendlyEvent } from "../../src/domain/booking/bookingService.js";
import { truncateAll } from "../helpers/db.js";

async function makeContact(email: string): Promise<string> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Booking Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
     VALUES ($1, $2, $3, 'valid') RETURNING id`,
    [company.rows[0]!.id, email, email.toLowerCase()],
  );
  return contact.rows[0]!.id;
}

function createdEvent(overrides: Partial<IncomingCalendlyEvent> = {}): IncomingCalendlyEvent {
  const uid = Math.random().toString(36).slice(2);
  return {
    eventType: "invitee.created",
    inviteeUri: `https://api.calendly.com/scheduled_events/evt-${uid}/invitees/inv-${uid}`,
    scheduledEventUri: `https://api.calendly.com/scheduled_events/evt-${uid}`,
    inviteeEmail: "booker@booking.example.com",
    inviteeName: "Booker Person",
    utmContent: null,
    scheduledAt: new Date("2026-09-01T15:00:00Z"),
    raw: { mock: true },
    ...overrides,
  };
}

describe("BookingService.processCalendlyEvent", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("matches a contact by the utm_content contactId and creates a booking", async () => {
    const contactId = await makeContact("someone-else@booking.example.com");
    const event = createdEvent({ utmContent: contactId, inviteeEmail: "someone-else@booking.example.com" });
    const service = new BookingService();

    const result = await service.processCalendlyEvent(event);
    expect(result.status).toBe("processed");
    expect(result.contactId).toBe(contactId);

    const row = await pool.query("SELECT status, calendly_event_uri FROM bookings WHERE id = $1", [
      result.bookingId,
    ]);
    expect(row.rows[0].status).toBe("scheduled");
    expect(row.rows[0].calendly_event_uri).toBe(event.scheduledEventUri);

    const contact = await pool.query("SELECT pipeline_stage FROM contacts WHERE id = $1", [contactId]);
    expect(contact.rows[0].pipeline_stage).toBe("booked");
  });

  it("falls back to matching by invitee email when utm_content is missing", async () => {
    const contactId = await makeContact("email-match@booking.example.com");
    const event = createdEvent({ utmContent: null, inviteeEmail: "email-match@booking.example.com" });
    const service = new BookingService();

    const result = await service.processCalendlyEvent(event);
    expect(result.status).toBe("processed");
    expect(result.contactId).toBe(contactId);
  });

  it("falls back to email matching when utm_content does not resolve to a known contact", async () => {
    const contactId = await makeContact("fallback@booking.example.com");
    const event = createdEvent({
      utmContent: "99999999-9999-9999-9999-999999999999",
      inviteeEmail: "fallback@booking.example.com",
    });
    const service = new BookingService();

    const result = await service.processCalendlyEvent(event);
    expect(result.status).toBe("processed");
    expect(result.contactId).toBe(contactId);
  });

  it("records an unmatched_contact outcome without creating a booking when no contact matches", async () => {
    const event = createdEvent({ utmContent: null, inviteeEmail: "nobody-on-file@booking.example.com" });
    const service = new BookingService();

    const result = await service.processCalendlyEvent(event);
    expect(result.status).toBe("unmatched_contact");
    expect(result.bookingId).toBeNull();

    const bookings = await pool.query("SELECT count(*)::int AS count FROM bookings");
    expect(bookings.rows[0].count).toBe(0);
  });

  it("is idempotent: redelivering the same invitee.created event does not create a second booking", async () => {
    const contactId = await makeContact("dup-booking@booking.example.com");
    const event = createdEvent({ utmContent: contactId });
    const service = new BookingService();

    const first = await service.processCalendlyEvent(event);
    const second = await service.processCalendlyEvent(event);

    expect(second.status).toBe("duplicate");
    expect(second.bookingId).toBe(first.bookingId);

    const bookings = await pool.query("SELECT count(*)::int AS count FROM bookings WHERE contact_id = $1", [
      contactId,
    ]);
    expect(bookings.rows[0].count).toBe(1);
  });

  it("cancels an existing booking on invitee.canceled and does not duplicate the cancellation", async () => {
    const contactId = await makeContact("cancel-me@booking.example.com");
    const created = createdEvent({ utmContent: contactId });
    const service = new BookingService();
    const createdResult = await service.processCalendlyEvent(created);

    const canceled: IncomingCalendlyEvent = {
      ...created,
      eventType: "invitee.canceled",
      raw: { mock: true, canceled: true },
    };
    const result = await service.processCalendlyEvent(canceled);
    expect(result.status).toBe("processed");
    expect(result.bookingId).toBe(createdResult.bookingId);

    const row = await pool.query("SELECT status FROM bookings WHERE id = $1", [result.bookingId]);
    expect(row.rows[0].status).toBe("canceled");

    const transitions = await pool.query(
      `SELECT to_state FROM state_transitions WHERE entity_type = 'booking' AND entity_id = $1 ORDER BY created_at ASC`,
      [result.bookingId],
    );
    expect(transitions.rows.map((r) => r.to_state)).toEqual(["scheduled", "canceled"]);

    // Redelivering the same cancellation event is a distinct external_event_id
    // from the creation event, but re-processing it must not write a second
    // "canceled" transition (booking.status is already 'canceled').
    await service.processCalendlyEvent(canceled);
    const transitionsAfter = await pool.query(
      `SELECT count(*)::int AS count FROM state_transitions WHERE entity_type = 'booking' AND entity_id = $1 AND to_state = 'canceled'`,
      [result.bookingId],
    );
    expect(transitionsAfter.rows[0].count).toBe(1);
  });

  it("records an unmatched_booking outcome for a cancellation of a booking we never recorded", async () => {
    const event: IncomingCalendlyEvent = { ...createdEvent(), eventType: "invitee.canceled" };
    const service = new BookingService();

    const result = await service.processCalendlyEvent(event);
    expect(result.status).toBe("unmatched_booking");
    expect(result.bookingId).toBeNull();
  });
});
