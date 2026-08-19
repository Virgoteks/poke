import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { ReplyNotFoundError, SafeReplyService } from "../../src/domain/safeReply/safeReplyService.js";
import { suppress } from "../../src/lib/suppression.js";
import { pauseSending } from "../../src/domain/safety/safetyService.js";
import type { SafeReplyAiClient, SafeReplyFacts, SafeReplyResult } from "../../src/integrations/openai/safeReply/types.js";
import type { InstantlyClient, SendEmailRequest, SendEmailResult, SendReplyRequest, SendReplyResult } from "../../src/integrations/instantly/types.js";
import { truncateAll } from "../helpers/db.js";

class FakeSafeReplyAiClient implements SafeReplyAiClient {
  public callCount = 0;
  public lastFacts: SafeReplyFacts | null = null;
  async generate(facts: SafeReplyFacts): Promise<SafeReplyResult> {
    this.callCount++;
    this.lastFacts = facts;
    return { body: "Generated reply body" };
  }
}

class FakeInstantlyClient implements InstantlyClient {
  public replyCalls: SendReplyRequest[] = [];
  constructor(private readonly behavior: "succeed" | "fail" = "succeed") {}
  async sendEmail(_req: SendEmailRequest): Promise<SendEmailResult> {
    throw new Error("not used in these tests");
  }
  async sendReply(request: SendReplyRequest): Promise<SendReplyResult> {
    this.replyCalls.push(request);
    if (this.behavior === "fail") throw new Error("Instantly reply failed");
    return { instantlyMessageId: `fake-reply-${request.idempotencyKey}`, dryRun: false };
  }
}

async function setupReply(opts: {
  intent?: string | null;
  requiresHuman?: boolean;
  hasMessage?: boolean;
  verificationStatus?: string;
  email?: string | null;
} = {}): Promise<{ replyId: string; contactId: string }> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Safe Reply Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const companyId = company.rows[0]!.id;
  await pool.query(
    `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified, ai_reasoning)
     VALUES ($1, NULL, 'rules_and_ai', true, 'PageSpeed score is 40')`,
    [companyId],
  );

  const email = opts.email === undefined ? "prospect@safereply.example.com" : opts.email;
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, first_name, verification_status)
     VALUES ($1, $2, $3, 'Alex', $4) RETURNING id`,
    [companyId, email, email ? email.toLowerCase() : null, opts.verificationStatus ?? "valid"],
  );
  const contactId = contact.rows[0]!.id;

  let messageId: string | null = null;
  if (opts.hasMessage !== false) {
    const message = await pool.query<{ id: string }>(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, status, instantly_message_id, sent_at)
       VALUES ($1, $2, 'initial', $3, 'Quick note', 'Original body', 'sent', 'orig-msg-id', now()) RETURNING id`,
      [contactId, companyId, `dedup-${Math.random()}`],
    );
    messageId = message.rows[0]!.id;
  }

  const reply = await pool.query<{ id: string }>(
    `INSERT INTO replies (message_id, contact_id, provider, provider_event_id, body, intent, requires_human, received_at)
     VALUES ($1, $2, 'instantly', $3, 'Sounds interesting!', $4, $5, now()) RETURNING id`,
    [
      messageId,
      contactId,
      `evt-${Math.random()}`,
      opts.intent === undefined ? "interested" : opts.intent,
      opts.requiresHuman ?? false,
    ],
  );

  return { replyId: reply.rows[0]!.id, contactId };
}

describe("SafeReplyService.generateAndSendSafeReply", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws ReplyNotFoundError for an unknown reply", async () => {
    const service = new SafeReplyService(new FakeSafeReplyAiClient(), new FakeInstantlyClient());
    await expect(service.generateAndSendSafeReply("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      ReplyNotFoundError,
    );
  });

  it("refuses to generate or send while the global safety kill switch is paused", async () => {
    const { replyId } = await setupReply({ intent: "interested" });
    await pauseSending("test pause", "human");
    const ai = new FakeSafeReplyAiClient();
    const instantly = new FakeInstantlyClient();
    const service = new SafeReplyService(ai, instantly);

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("blocked_paused");
    expect(ai.callCount).toBe(0);
    expect(instantly.replyCalls).toHaveLength(0);
  });

  it("REQUIREMENT #10: never generates or sends a reply when requires_human is true, regardless of intent", async () => {
    const { replyId } = await setupReply({ intent: "interested", requiresHuman: true });
    const ai = new FakeSafeReplyAiClient();
    const instantly = new FakeInstantlyClient();
    const service = new SafeReplyService(ai, instantly);

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("blocked_requires_human");
    expect(ai.callCount).toBe(0);
    expect(instantly.replyCalls).toHaveLength(0);

    const row = await pool.query("SELECT auto_reply_sent FROM replies WHERE id = $1", [replyId]);
    expect(row.rows[0].auto_reply_sent).toBe(false);
  });

  it.each(["not_interested", "auto_reply", "other", null])(
    "does not send an automated reply for a non-eligible intent (%s)",
    async (intent) => {
      const { replyId } = await setupReply({ intent, requiresHuman: false });
      const ai = new FakeSafeReplyAiClient();
      const instantly = new FakeInstantlyClient();
      const service = new SafeReplyService(ai, instantly);

      const result = await service.generateAndSendSafeReply(replyId);
      expect(result.status).toBe("not_eligible");
      expect(ai.callCount).toBe(0);
      expect(instantly.replyCalls).toHaveLength(0);
    },
  );

  it("blocks an unverified contact and never calls the AI or Instantly", async () => {
    const { replyId } = await setupReply({ verificationStatus: "unverified" });
    const ai = new FakeSafeReplyAiClient();
    const instantly = new FakeInstantlyClient();
    const service = new SafeReplyService(ai, instantly);

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("blocked_unverified");
    expect(ai.callCount).toBe(0);
  });

  it("blocks a suppressed contact and never calls the AI or Instantly", async () => {
    const { replyId } = await setupReply({ email: "suppressed@safereply.example.com" });
    await suppress("suppressed@safereply.example.com", "unsubscribed");
    const ai = new FakeSafeReplyAiClient();
    const instantly = new FakeInstantlyClient();
    const service = new SafeReplyService(ai, instantly);

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("blocked_suppressed");
    expect(ai.callCount).toBe(0);
  });

  it("blocks when there is no original sent message to reply to", async () => {
    const { replyId } = await setupReply({ hasMessage: false });
    const service = new SafeReplyService(new FakeSafeReplyAiClient(), new FakeInstantlyClient());
    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("blocked_no_original_message");
  });

  it("generates and sends a safe reply for an eligible, verified, non-suppressed contact", async () => {
    const { replyId } = await setupReply({ intent: "question" });
    const ai = new FakeSafeReplyAiClient();
    const instantly = new FakeInstantlyClient("succeed");
    const service = new SafeReplyService(ai, instantly);

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("sent");
    expect(ai.callCount).toBe(1);
    expect(ai.lastFacts?.intent).toBe("question");
    expect(ai.lastFacts?.qualificationReasoning).toBe("PageSpeed score is 40");
    expect(instantly.replyCalls).toHaveLength(1);
    expect(instantly.replyCalls[0]!.inReplyToInstantlyMessageId).toBe("orig-msg-id");

    const row = await pool.query("SELECT auto_reply_sent, auto_reply_body FROM replies WHERE id = $1", [replyId]);
    expect(row.rows[0].auto_reply_sent).toBe(true);
    expect(row.rows[0].auto_reply_body).toBe("Generated reply body");

    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'reply' AND entity_id = $1`,
      [replyId],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("auto_replied");
  });

  it("is idempotent: never sends a second automated reply for the same reply row", async () => {
    const { replyId } = await setupReply({ intent: "interested" });
    const instantly = new FakeInstantlyClient("succeed");
    const service = new SafeReplyService(new FakeSafeReplyAiClient(), instantly);

    await service.generateAndSendSafeReply(replyId);
    const second = await service.generateAndSendSafeReply(replyId);

    expect(second.status).toBe("already_sent");
    expect(instantly.replyCalls).toHaveLength(1);
  });

  it("records a failure without throwing when Instantly errors, and does not mark auto_reply_sent", async () => {
    const { replyId } = await setupReply({ intent: "interested" });
    const service = new SafeReplyService(new FakeSafeReplyAiClient(), new FakeInstantlyClient("fail"));

    const result = await service.generateAndSendSafeReply(replyId);
    expect(result.status).toBe("failed");

    const row = await pool.query("SELECT auto_reply_sent FROM replies WHERE id = $1", [replyId]);
    expect(row.rows[0].auto_reply_sent).toBe(false);
  });
});
