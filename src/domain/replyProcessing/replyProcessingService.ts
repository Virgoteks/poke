import { pool } from "../../db/pool.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { suppress } from "../../lib/suppression.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logger } from "../../logging/logger.js";
import {
  createReplyClassificationAiClient,
  type ReplyClassificationAiClient,
} from "../../integrations/openai/replyClassification/index.js";
import { classifyIntentDeterministic, type ReplyIntent } from "./intentClassificationRules.js";

export interface IncomingReplyPayload {
  externalEventId: string;
  leadEmail: string;
  replyText: string;
  receivedAt: Date | null;
  raw: unknown;
}

export type ProcessReplyStatus = "processed" | "duplicate" | "unmatched_contact";

export interface ProcessReplyOutcome {
  status: ProcessReplyStatus;
  replyId: string | null;
  intent: ReplyIntent | null;
  requiresHuman: boolean;
}

export class ReplyProcessingService {
  constructor(private readonly aiClient: ReplyClassificationAiClient = createReplyClassificationAiClient()) {}

  async processInstantlyReply(payload: IncomingReplyPayload): Promise<ProcessReplyOutcome> {
    // Requirement #12: "Workflows must tolerate duplicate webhook
    // delivery." The webhook_events ledger is the idempotency arbiter --
    // a second delivery of the same external event id is detected here,
    // before any further processing, and short-circuited.
    const ledgerInsert = await pool.query<{ id: string }>(
      `INSERT INTO webhook_events (source, external_event_id, payload)
       VALUES ('instantly', $1, $2)
       ON CONFLICT (source, external_event_id) DO NOTHING
       RETURNING id`,
      [payload.externalEventId, JSON.stringify(payload.raw)],
    );

    if (ledgerInsert.rowCount === 0) {
      const existing = await pool.query<{ id: string; intent: ReplyIntent | null; requires_human: boolean }>(
        `SELECT id, intent, requires_human FROM replies WHERE provider = 'instantly' AND provider_event_id = $1`,
        [payload.externalEventId],
      );
      const row = existing.rows[0];
      logger.info({ externalEventId: payload.externalEventId }, "Duplicate Instantly reply webhook delivery; no-op");
      return {
        status: "duplicate",
        replyId: row?.id ?? null,
        intent: row?.intent ?? null,
        requiresHuman: row?.requires_human ?? false,
      };
    }

    const normalizedEmail = normalizeEmail(payload.leadEmail);
    const contactRes = normalizedEmail
      ? await pool.query<{ id: string; email: string | null }>(
          `SELECT id, email FROM contacts WHERE email_normalized = $1`,
          [normalizedEmail],
        )
      : { rows: [] as Array<{ id: string; email: string | null }> };
    const contact = contactRes.rows[0];

    await pool.query(`UPDATE webhook_events SET processed_at = now() WHERE source = 'instantly' AND external_event_id = $1`, [
      payload.externalEventId,
    ]);

    if (!contact) {
      logger.warn(
        { leadEmail: payload.leadEmail, externalEventId: payload.externalEventId },
        "Instantly reply webhook did not match any known contact; recorded in webhook_events only",
      );
      return { status: "unmatched_contact", replyId: null, intent: null, requiresHuman: false };
    }

    const deterministic = classifyIntentDeterministic(payload.replyText);
    let intent: ReplyIntent;
    let requiresHuman: boolean;
    let confidence: number | null = null;
    let intentRaw: unknown = null;

    if (deterministic) {
      intent = deterministic.intent;
      requiresHuman = deterministic.requiresHuman;
      intentRaw = { source: "deterministic" };
    } else {
      const ai = await this.aiClient.classify(payload.replyText);
      intent = ai.intent;
      confidence = ai.confidence;
      requiresHuman = false;
      intentRaw = { source: "openai", ...ai };
    }

    const messageRes = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE contact_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
      [contact.id],
    );
    const messageId = messageRes.rows[0]?.id ?? null;

    const replyRes = await pool.query<{ id: string }>(
      `INSERT INTO replies (
         message_id, contact_id, provider, provider_event_id, raw_payload, body,
         intent, intent_confidence, intent_raw, requires_human, received_at
       ) VALUES ($1,$2,'instantly',$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        messageId,
        contact.id,
        payload.externalEventId,
        JSON.stringify(payload.raw),
        payload.replyText,
        intent,
        confidence,
        JSON.stringify(intentRaw),
        requiresHuman,
        payload.receivedAt ?? new Date(),
      ],
    );
    const replyId = replyRes.rows[0]?.id ?? null;

    // Requirement #9: "Unsubscribe requests must immediately prevent future outreach."
    if (intent === "unsubscribe" && contact.email) {
      await suppress(contact.email, "unsubscribed", "instantly_reply");
    }

    await transitionEntityStage("contact", contact.id, "process_reply", "replied", { intent, requiresHuman });

    logger.info({ contactId: contact.id, intent, requiresHuman }, "Processed Instantly reply");

    return { status: "processed", replyId, intent, requiresHuman };
  }
}
