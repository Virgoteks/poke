import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireCalendlySignature } from "../middleware/calendlySignature.js";
import { HttpError } from "../middleware/errorHandler.js";
import { BookingService, type IncomingCalendlyEvent } from "../../domain/booking/bookingService.js";

export const calendlyWebhookRouter = Router();

// Calendly's actual webhook payload shape (v2 organization webhooks).
// Extra fields are ignored and preserved verbatim in webhook_events.payload
// / bookings.raw_payload for later inspection.
const calendlyWebhookSchema = z.object({
  event: z.enum(["invitee.created", "invitee.canceled"]),
  payload: z.object({
    uri: z.string().min(1),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    scheduled_event: z.object({
      uri: z.string().min(1),
      start_time: z.string().nullable().optional(),
    }),
    tracking: z
      .object({
        utm_content: z.string().nullable().optional(),
      })
      .optional(),
  }),
});

calendlyWebhookRouter.post(
  "/webhooks/calendly",
  requireCalendlySignature(env.CALENDLY_WEBHOOK_SECRET),
  async (req, res, next) => {
    const parsed = calendlyWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, "Invalid webhook payload", parsed.error.flatten()));
      return;
    }

    const { event, payload } = parsed.data;
    const incoming: IncomingCalendlyEvent = {
      eventType: event,
      inviteeUri: payload.uri,
      scheduledEventUri: payload.scheduled_event.uri,
      inviteeEmail: payload.email ?? null,
      inviteeName: payload.name ?? null,
      utmContent: payload.tracking?.utm_content ?? null,
      scheduledAt: payload.scheduled_event.start_time ? new Date(payload.scheduled_event.start_time) : null,
      raw: req.body,
    };

    try {
      const service = new BookingService();
      const result = await service.processCalendlyEvent(incoming);
      // Always 200 for anything that reached the idempotency ledger --
      // Calendly should not retry-storm us for conditions like
      // "unmatched contact" that are not going to change on retry.
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
