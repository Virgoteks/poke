import { pool } from "../../db/pool.js";
import { logStateTransition } from "../../lib/stateLog.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { isSuppressed } from "../../lib/suppression.js";
import { logger } from "../../logging/logger.js";
import { isContactEmailVerified } from "../verification/verificationService.js";
import { isSendingPaused } from "../safety/safetyService.js";
import { createInstantlyClient, type InstantlyClient } from "../../integrations/instantly/index.js";

export class MessageNotFoundError extends Error {
  constructor(public readonly messageId: string) {
    super(`Message ${messageId} not found`);
    this.name = "MessageNotFoundError";
  }
}

interface MessageRow {
  id: string;
  contact_id: string;
  company_id: string;
  stage: string;
  subject: string | null;
  body: string | null;
  status: string;
  dedup_key: string;
}

interface ContactRow {
  id: string;
  email: string | null;
  full_name: string | null;
}

export type SendOutcomeStatus = "sent" | "skipped_unverified" | "skipped_suppressed" | "skipped_paused" | "failed";

export interface SendOutcome {
  messageId: string;
  status: SendOutcomeStatus;
  reason: string | null;
  alreadySent: boolean;
}

export class SendingService {
  constructor(private readonly instantlyClient: InstantlyClient = createInstantlyClient()) {}

  async sendMessage(messageId: string): Promise<SendOutcome> {
    const messageRes = await pool.query<MessageRow>(
      `SELECT id, contact_id, company_id, stage, subject, body, status, dedup_key FROM messages WHERE id = $1`,
      [messageId],
    );
    const message = messageRes.rows[0];
    if (!message) throw new MessageNotFoundError(messageId);

    // Idempotency + "no duplicate outbound messages": a message that has
    // already gone out is never sent again, regardless of how many times
    // this is called (retried webhook delivery, re-run workflow, etc.).
    if (message.status === "sent") {
      return { messageId, status: "sent", reason: null, alreadySent: true };
    }

    // Runtime kill switch (src/domain/safety/safetyService.ts): checked
    // before any other work so an operator- or auto-triggered pause takes
    // effect immediately for every message still in flight.
    if (await isSendingPaused()) {
      await this.markSkipped(message, "skipped_paused", "sending_paused");
      return { messageId, status: "skipped_paused", reason: "sending_paused", alreadySent: false };
    }

    const contactRes = await pool.query<ContactRow>(`SELECT id, email, full_name FROM contacts WHERE id = $1`, [
      message.contact_id,
    ]);
    const contact = contactRes.rows[0]!;

    // Requirement #7: unverified email addresses must never receive outreach.
    const verified = await isContactEmailVerified(contact.id);
    if (!verified) {
      await this.markSkipped(message, "skipped_unverified", "unverified_email");
      return { messageId, status: "skipped_unverified", reason: "unverified_email", alreadySent: false };
    }

    // Requirements #8/#9: global suppression, checked immediately before every send.
    if (await isSuppressed(contact.email)) {
      await this.markSkipped(message, "skipped_suppressed", "suppressed");
      return { messageId, status: "skipped_suppressed", reason: "suppressed", alreadySent: false };
    }

    try {
      const result = await this.instantlyClient.sendEmail({
        toEmail: contact.email!,
        toName: contact.full_name,
        subject: message.subject ?? "",
        body: message.body ?? "",
        idempotencyKey: message.dedup_key,
      });

      await pool.query(
        `UPDATE messages SET status = 'sent', sent_at = now(), instantly_message_id = $2, updated_at = now() WHERE id = $1`,
        [messageId, result.instantlyMessageId],
      );
      await logStateTransition({
        entityType: "message",
        entityId: messageId,
        stage: "send",
        fromState: message.status,
        toState: "sent",
        actor: "system",
        metadata: { dryRun: result.dryRun, instantlyMessageId: result.instantlyMessageId },
      });
      await transitionEntityStage("contact", contact.id, "send", "contacted", {
        messageId,
        dryRun: result.dryRun,
      });

      return { messageId, status: "sent", reason: null, alreadySent: false };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ messageId, err }, "Failed to send message via Instantly");
      await pool.query(
        `UPDATE messages SET status = 'failed', skip_reason = $2, updated_at = now() WHERE id = $1`,
        [messageId, reason],
      );
      await logStateTransition({
        entityType: "message",
        entityId: messageId,
        stage: "send",
        fromState: message.status,
        toState: "failed",
        actor: "system",
        metadata: { error: reason },
      });
      return { messageId, status: "failed", reason, alreadySent: false };
    }
  }

  private async markSkipped(
    message: MessageRow,
    status: "skipped_unverified" | "skipped_suppressed" | "skipped_paused",
    reason: string,
  ): Promise<void> {
    await pool.query(`UPDATE messages SET status = $2, skip_reason = $3, updated_at = now() WHERE id = $1`, [
      message.id,
      status,
      reason,
    ]);
    await logStateTransition({
      entityType: "message",
      entityId: message.id,
      stage: "send",
      fromState: message.status,
      toState: status,
      actor: "system",
      metadata: { reason },
    });
  }
}

export async function getMessagesPendingSend(limit = 20): Promise<Array<{ id: string; contactId: string }>> {
  const res = await pool.query<{ id: string; contact_id: string }>(
    `SELECT id, contact_id FROM messages WHERE status = 'queued' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, contactId: r.contact_id }));
}
