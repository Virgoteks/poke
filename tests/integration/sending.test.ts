import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { MessageNotFoundError, SendingService } from "../../src/domain/sending/sendingService.js";
import { suppress } from "../../src/lib/suppression.js";
import { pauseSending } from "../../src/domain/safety/safetyService.js";
import type { InstantlyClient, SendEmailRequest, SendEmailResult } from "../../src/integrations/instantly/types.js";
import { truncateAll } from "../helpers/db.js";

class FakeInstantlyClient implements InstantlyClient {
  public calls: SendEmailRequest[] = [];
  constructor(private readonly behavior: "succeed" | "fail" = "succeed") {}
  async sendEmail(request: SendEmailRequest): Promise<SendEmailResult> {
    this.calls.push(request);
    if (this.behavior === "fail") throw new Error("Instantly is down");
    return { instantlyMessageId: `fake-${request.idempotencyKey}`, dryRun: false };
  }
}

async function insertMessage(opts: {
  email?: string | null;
  verificationStatus?: string;
} = {}): Promise<{ messageId: string; contactId: string }> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Send Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const email = opts.email === undefined ? "recipient@send.example.com" : opts.email;
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [company.rows[0]!.id, email, email ? email.toLowerCase() : null, opts.verificationStatus ?? "valid"],
  );
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, status)
     VALUES ($1, $2, 'initial', $3, 'Subject', 'Body', 'queued') RETURNING id`,
    [contact.rows[0]!.id, company.rows[0]!.id, `dedup-${Math.random()}`],
  );
  return { messageId: message.rows[0]!.id, contactId: contact.rows[0]!.id };
}

describe("SendingService.sendMessage", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws MessageNotFoundError for an unknown message", async () => {
    const service = new SendingService(new FakeInstantlyClient());
    await expect(service.sendMessage("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it("refuses to send to an unverified contact and never calls Instantly", async () => {
    const { messageId } = await insertMessage({ verificationStatus: "unverified" });
    const instantly = new FakeInstantlyClient();
    const service = new SendingService(instantly);

    const result = await service.sendMessage(messageId);
    expect(result.status).toBe("skipped_unverified");
    expect(instantly.calls).toHaveLength(0);

    const row = await pool.query("SELECT status, skip_reason FROM messages WHERE id = $1", [messageId]);
    expect(row.rows[0].status).toBe("skipped_unverified");
  });

  it("refuses to send to a suppressed contact and never calls Instantly", async () => {
    const { messageId } = await insertMessage();
    await suppress("recipient@send.example.com", "unsubscribed");
    const instantly = new FakeInstantlyClient();
    const service = new SendingService(instantly);

    const result = await service.sendMessage(messageId);
    expect(result.status).toBe("skipped_suppressed");
    expect(instantly.calls).toHaveLength(0);
  });

  it("sends successfully, records the Instantly message id, and logs state transitions", async () => {
    const { messageId, contactId } = await insertMessage();
    const instantly = new FakeInstantlyClient("succeed");
    const service = new SendingService(instantly);

    const result = await service.sendMessage(messageId);
    expect(result.status).toBe("sent");
    expect(instantly.calls).toHaveLength(1);
    expect(instantly.calls[0]!.toEmail).toBe("recipient@send.example.com");

    const row = await pool.query("SELECT status, instantly_message_id, sent_at FROM messages WHERE id = $1", [
      messageId,
    ]);
    expect(row.rows[0].status).toBe("sent");
    expect(row.rows[0].instantly_message_id).toContain("fake-");
    expect(row.rows[0].sent_at).not.toBeNull();

    const contact = await pool.query("SELECT pipeline_stage FROM contacts WHERE id = $1", [contactId]);
    expect(contact.rows[0].pipeline_stage).toBe("contacted");

    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'message' AND entity_id = $1`,
      [messageId],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("sent");
  });

  it("is idempotent: never sends the same message twice", async () => {
    const { messageId } = await insertMessage();
    const instantly = new FakeInstantlyClient("succeed");
    const service = new SendingService(instantly);

    await service.sendMessage(messageId);
    const second = await service.sendMessage(messageId);

    expect(second.alreadySent).toBe(true);
    expect(instantly.calls).toHaveLength(1); // not called a second time
  });

  it("refuses to send while the global safety kill switch is paused, and never calls Instantly", async () => {
    const { messageId } = await insertMessage();
    await pauseSending("test pause", "human");
    const instantly = new FakeInstantlyClient();
    const service = new SendingService(instantly);

    const result = await service.sendMessage(messageId);
    expect(result.status).toBe("skipped_paused");
    expect(instantly.calls).toHaveLength(0);

    const row = await pool.query("SELECT status, skip_reason FROM messages WHERE id = $1", [messageId]);
    expect(row.rows[0].status).toBe("skipped_paused");
    expect(row.rows[0].skip_reason).toBe("sending_paused");
  });

  it("records a failure without throwing when Instantly errors, and does not mark the message sent", async () => {
    const { messageId } = await insertMessage();
    const instantly = new FakeInstantlyClient("fail");
    const service = new SendingService(instantly);

    const result = await service.sendMessage(messageId);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Instantly is down");

    const row = await pool.query("SELECT status, skip_reason FROM messages WHERE id = $1", [messageId]);
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].skip_reason).toContain("Instantly is down");
  });
});
