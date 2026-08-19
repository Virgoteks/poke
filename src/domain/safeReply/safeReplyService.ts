import { createHash } from "node:crypto";
import { pool } from "../../db/pool.js";
import { logStateTransition } from "../../lib/stateLog.js";
import { isSuppressed } from "../../lib/suppression.js";
import { logger } from "../../logging/logger.js";
import { isContactEmailVerified } from "../verification/verificationService.js";
import { isSendingPaused } from "../safety/safetyService.js";
import { createInstantlyClient, type InstantlyClient } from "../../integrations/instantly/index.js";
import { createSafeReplyAiClient, type SafeReplyAiClient, type SafeReplyFacts } from "../../integrations/openai/safeReply/index.js";

export class ReplyNotFoundError extends Error {
  constructor(public readonly replyId: string) {
    super(`Reply ${replyId} not found`);
    this.name = "ReplyNotFoundError";
  }
}

export type SafeReplyStatus =
  | "sent"
  | "already_sent"
  | "blocked_paused"
  | "blocked_requires_human"
  | "not_eligible"
  | "blocked_unverified"
  | "blocked_suppressed"
  | "blocked_no_original_message"
  | "failed";

export interface SafeReplyOutcome {
  replyId: string;
  status: SafeReplyStatus;
  reason: string | null;
}

const SENDER_NAME = "Ron Smith";
const SENDER_COMPANY = "Smith Consulting SBC";
const ELIGIBLE_INTENTS = new Set(["interested", "question"]);

interface ReplyRow {
  id: string;
  contact_id: string;
  message_id: string | null;
  intent: string | null;
  requires_human: boolean;
  auto_reply_sent: boolean;
  body: string | null;
}

export class SafeReplyService {
  constructor(
    private readonly aiClient: SafeReplyAiClient = createSafeReplyAiClient(),
    private readonly instantlyClient: InstantlyClient = createInstantlyClient(),
  ) {}

  async generateAndSendSafeReply(replyId: string): Promise<SafeReplyOutcome> {
    const replyRes = await pool.query<ReplyRow>(
      `SELECT id, contact_id, message_id, intent, requires_human, auto_reply_sent, body FROM replies WHERE id = $1`,
      [replyId],
    );
    const reply = replyRes.rows[0];
    if (!reply) throw new ReplyNotFoundError(replyId);

    if (reply.auto_reply_sent) {
      return { replyId, status: "already_sent", reason: null };
    }

    // Runtime kill switch (src/domain/safety/safetyService.ts): checked
    // before any other work, same as SendingService.
    if (await isSendingPaused()) {
      return { replyId, status: "blocked_paused", reason: "sending_paused" };
    }

    // Requirement #10, absolute gate: never generate an AI response for a
    // reply flagged as requiring human review (legal/compliance/hostile),
    // regardless of its classified intent.
    if (reply.requires_human) {
      return { replyId, status: "blocked_requires_human", reason: "requires_human" };
    }

    if (!reply.intent || !ELIGIBLE_INTENTS.has(reply.intent)) {
      return { replyId, status: "not_eligible", reason: reply.intent };
    }

    const contactRes = await pool.query<{ id: string; email: string | null; first_name: string | null }>(
      `SELECT id, email, first_name FROM contacts WHERE id = $1`,
      [reply.contact_id],
    );
    const contact = contactRes.rows[0]!;

    // Requirement #7 applies here too: a safe automated reply is still outreach.
    if (!(await isContactEmailVerified(contact.id))) {
      return { replyId, status: "blocked_unverified", reason: "unverified_email" };
    }
    // Requirements #8/#9: global suppression checked immediately before any send.
    if (await isSuppressed(contact.email)) {
      return { replyId, status: "blocked_suppressed", reason: "suppressed" };
    }

    if (!reply.message_id) {
      return { replyId, status: "blocked_no_original_message", reason: "no_original_message" };
    }

    const messageRes = await pool.query<{
      subject: string | null;
      body: string | null;
      instantly_message_id: string | null;
      company_id: string;
    }>(`SELECT subject, body, instantly_message_id, company_id FROM messages WHERE id = $1`, [reply.message_id]);
    const originalMessage = messageRes.rows[0];
    if (!originalMessage) {
      return { replyId, status: "blocked_no_original_message", reason: "no_original_message" };
    }

    const companyRes = await pool.query<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [
      originalMessage.company_id,
    ]);
    const qualRes = await pool.query<{ ai_reasoning: string | null }>(
      `SELECT ai_reasoning FROM qualifications WHERE company_id = $1`,
      [originalMessage.company_id],
    );

    const facts: SafeReplyFacts = {
      companyName: companyRes.rows[0]?.name ?? "your company",
      contactFirstName: contact.first_name,
      originalSubject: originalMessage.subject,
      originalBody: originalMessage.body,
      incomingReplyText: reply.body ?? "",
      intent: reply.intent as "interested" | "question",
      qualificationReasoning: qualRes.rows[0]?.ai_reasoning ?? null,
      senderName: SENDER_NAME,
      senderCompany: SENDER_COMPANY,
    };

    const generated = await this.aiClient.generate(facts);
    const idempotencyKey = createHash("sha256").update(`safe-reply:${replyId}`).digest("hex");

    try {
      const result = await this.instantlyClient.sendReply({
        toEmail: contact.email!,
        toName: null,
        subject: originalMessage.subject ? `Re: ${originalMessage.subject}` : "Re: your message",
        body: generated.body,
        inReplyToInstantlyMessageId: originalMessage.instantly_message_id,
        idempotencyKey,
      });

      await pool.query(
        `UPDATE replies SET auto_reply_sent = true, auto_reply_body = $2 WHERE id = $1`,
        [replyId, generated.body],
      );
      await logStateTransition({
        entityType: "reply",
        entityId: replyId,
        stage: "safe_reply",
        fromState: "pending",
        toState: "auto_replied",
        actor: "ai",
        metadata: { dryRun: result.dryRun, instantlyMessageId: result.instantlyMessageId },
      });

      return { replyId, status: "sent", reason: null };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ replyId, err }, "Failed to send safe automated reply via Instantly");
      return { replyId, status: "failed", reason };
    }
  }
}

export async function getRepliesPendingSafeResponse(
  limit = 20,
): Promise<Array<{ id: string; intent: string | null }>> {
  const res = await pool.query<{ id: string; intent: string | null }>(
    `SELECT id, intent FROM replies
     WHERE requires_human = false AND auto_reply_sent = false AND intent IN ('interested', 'question')
     ORDER BY received_at ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}
