import { pool } from "../../db/pool.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logStateTransition } from "../../lib/stateLog.js";
import { logger } from "../../logging/logger.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CalendlyEventType = "invitee.created" | "invitee.canceled";

export interface IncomingCalendlyEvent {
  eventType: CalendlyEventType;
  inviteeUri: string; // Calendly's unique id for this invitee record
  scheduledEventUri: string; // the parent booking -- what bookings.calendly_event_uri stores
  inviteeEmail: string | null;
  inviteeName: string | null;
  utmContent: string | null; // carries a contactId when the booking link was ours (see calendly/mockClient.ts)
  scheduledAt: Date | null;
  raw: unknown;
}

export type ProcessCalendlyStatus =
  | "processed"
  | "duplicate"
  | "unmatched_contact"
  | "unmatched_booking";

export interface ProcessCalendlyOutcome {
  status: ProcessCalendlyStatus;
  bookingId: string | null;
  contactId: string | null;
  eventType: CalendlyEventType;
}

export class BookingService {
  async processCalendlyEvent(event: IncomingCalendlyEvent): Promise<ProcessCalendlyOutcome> {
    // Requirement #12: tolerate duplicate webhook delivery. invitee.created
    // and invitee.canceled for the same invitee are two distinct,
    // legitimate deliveries, so the external event id is scoped by event
    // type as well as the invitee uri.
    const externalEventId = `${event.eventType}:${event.inviteeUri}`;
    const ledgerInsert = await pool.query<{ id: string }>(
      `INSERT INTO webhook_events (source, external_event_id, payload)
       VALUES ('calendly', $1, $2)
       ON CONFLICT (source, external_event_id) DO NOTHING
       RETURNING id`,
      [externalEventId, JSON.stringify(event.raw)],
    );

    if (ledgerInsert.rowCount === 0) {
      const existing = await pool.query<{ id: string; contact_id: string }>(
        `SELECT id, contact_id FROM bookings WHERE calendly_event_uri = $1`,
        [event.scheduledEventUri],
      );
      logger.info({ externalEventId }, "Duplicate Calendly webhook delivery; no-op");
      return {
        status: "duplicate",
        bookingId: existing.rows[0]?.id ?? null,
        contactId: existing.rows[0]?.contact_id ?? null,
        eventType: event.eventType,
      };
    }

    await pool.query(`UPDATE webhook_events SET processed_at = now() WHERE source = 'calendly' AND external_event_id = $1`, [
      externalEventId,
    ]);

    if (event.eventType === "invitee.canceled") {
      return this.handleCanceled(event);
    }
    return this.handleCreated(event);
  }

  private async resolveContactId(event: IncomingCalendlyEvent): Promise<string | null> {
    // Primary correlation: our own scheduling link embeds the contactId as
    // utm_content, so a valid, known contact id is the strongest signal.
    if (event.utmContent && UUID_RE.test(event.utmContent)) {
      const byId = await pool.query<{ id: string }>(`SELECT id FROM contacts WHERE id = $1`, [event.utmContent]);
      if (byId.rows[0]) return byId.rows[0]!.id;
    }
    // Fallback: match the email the invitee entered at booking time.
    const normalizedEmail = normalizeEmail(event.inviteeEmail);
    if (!normalizedEmail) return null;
    const byEmail = await pool.query<{ id: string }>(`SELECT id FROM contacts WHERE email_normalized = $1`, [
      normalizedEmail,
    ]);
    return byEmail.rows[0]?.id ?? null;
  }

  private async handleCreated(event: IncomingCalendlyEvent): Promise<ProcessCalendlyOutcome> {
    const contactId = await this.resolveContactId(event);
    if (!contactId) {
      logger.warn(
        { inviteeEmail: event.inviteeEmail, utmContent: event.utmContent },
        "Calendly invitee.created did not match any known contact; recorded in webhook_events only",
      );
      return { status: "unmatched_contact", bookingId: null, contactId: null, eventType: event.eventType };
    }

    // `calendly_event_uri` is UNIQUE, so re-delivery of the same booking
    // (or a webhook arriving after we already recorded it some other way)
    // upserts in place rather than creating a duplicate `bookings` row.
    const upserted = await pool.query<{ id: string }>(
      `INSERT INTO bookings (contact_id, calendly_event_uri, status, scheduled_at, raw_payload)
       VALUES ($1, $2, 'scheduled', $3, $4)
       ON CONFLICT (calendly_event_uri)
       DO UPDATE SET status = 'scheduled', scheduled_at = EXCLUDED.scheduled_at,
         raw_payload = EXCLUDED.raw_payload, updated_at = now()
       RETURNING id`,
      [contactId, event.scheduledEventUri, event.scheduledAt, JSON.stringify(event.raw)],
    );
    const bookingId = upserted.rows[0]!.id;

    await logStateTransition({
      entityType: "booking",
      entityId: bookingId,
      stage: "book",
      fromState: null,
      toState: "scheduled",
      actor: "webhook",
      metadata: { contactId, scheduledAt: event.scheduledAt },
    });
    await transitionEntityStage("contact", contactId, "book", "booked", { bookingId });

    logger.info({ bookingId, contactId }, "Calendly booking scheduled");
    return { status: "processed", bookingId, contactId, eventType: event.eventType };
  }

  private async handleCanceled(event: IncomingCalendlyEvent): Promise<ProcessCalendlyOutcome> {
    const existing = await pool.query<{ id: string; contact_id: string; status: string }>(
      `SELECT id, contact_id, status FROM bookings WHERE calendly_event_uri = $1`,
      [event.scheduledEventUri],
    );
    const booking = existing.rows[0];
    if (!booking) {
      logger.warn(
        { scheduledEventUri: event.scheduledEventUri },
        "Calendly invitee.canceled referenced a booking we never recorded; recorded in webhook_events only",
      );
      return { status: "unmatched_booking", bookingId: null, contactId: null, eventType: event.eventType };
    }

    if (booking.status !== "canceled") {
      await pool.query(`UPDATE bookings SET status = 'canceled', updated_at = now() WHERE id = $1`, [booking.id]);
      await logStateTransition({
        entityType: "booking",
        entityId: booking.id,
        stage: "book",
        fromState: booking.status,
        toState: "canceled",
        actor: "webhook",
        metadata: { contactId: booking.contact_id },
      });
      await transitionEntityStage("contact", booking.contact_id, "book", "booking_canceled", {
        bookingId: booking.id,
      });
    }

    logger.info({ bookingId: booking.id, contactId: booking.contact_id }, "Calendly booking canceled");
    return { status: "processed", bookingId: booking.id, contactId: booking.contact_id, eventType: event.eventType };
  }
}
