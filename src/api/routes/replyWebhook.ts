import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { requireWebhookSecret } from "../middleware/webhookSecret.js";
import { HttpError } from "../middleware/errorHandler.js";
import { ReplyProcessingService, type IncomingReplyPayload } from "../../domain/replyProcessing/replyProcessingService.js";

export const replyWebhookRouter = Router();

// Instantly's exact reply-webhook payload shape can vary by account/API
// version; this is the minimal shape this pipeline depends on. Extra
// fields are ignored and preserved verbatim in webhook_events.payload /
// replies.raw_payload for later inspection.
const instantlyReplyWebhookSchema = z.object({
  event_id: z.string().min(1),
  lead_email: z.string().min(1),
  reply_text: z.string().default(""),
  timestamp: z.string().datetime().optional(),
});

replyWebhookRouter.post(
  "/webhooks/instantly/reply",
  requireWebhookSecret("x-webhook-secret", env.INSTANTLY_WEBHOOK_SECRET),
  async (req, res, next) => {
    const parsed = instantlyReplyWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      next(new HttpError(400, "Invalid webhook payload", parsed.error.flatten()));
      return;
    }

    const payload: IncomingReplyPayload = {
      externalEventId: parsed.data.event_id,
      leadEmail: parsed.data.lead_email,
      replyText: parsed.data.reply_text,
      receivedAt: parsed.data.timestamp ? new Date(parsed.data.timestamp) : null,
      raw: req.body,
    };

    try {
      const service = new ReplyProcessingService();
      const result = await service.processInstantlyReply(payload);
      // Always 200 for anything that reached the idempotency ledger --
      // Instantly should not retry-storm us for conditions like
      // "unmatched contact" that are not going to change on retry.
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);
