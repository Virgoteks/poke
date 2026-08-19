import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { ReplyProcessingService, type IncomingReplyPayload } from "../../src/domain/replyProcessing/replyProcessingService.js";
import { isSuppressed } from "../../src/lib/suppression.js";
import type { ReplyClassificationAiClient, ReplyClassificationResult } from "../../src/integrations/openai/replyClassification/types.js";
import { truncateAll } from "../helpers/db.js";

class FakeReplyAiClient implements ReplyClassificationAiClient {
  public callCount = 0;
  constructor(private readonly result: ReplyClassificationResult) {}
  async classify(): Promise<ReplyClassificationResult> {
    this.callCount++;
    return this.result;
  }
}

function payload(overrides: Partial<IncomingReplyPayload> = {}): IncomingReplyPayload {
  return {
    externalEventId: `evt-${Math.random()}`,
    leadEmail: "contact@replyco.example.com",
    replyText: "Thanks for reaching out.",
    receivedAt: null,
    raw: { ok: true },
    ...overrides,
  };
}

async function insertContact(email = "contact@replyco.example.com"): Promise<{ companyId: string; contactId: string }> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Reply Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, $2, $3) RETURNING id`,
    [company.rows[0]!.id, email, email.toLowerCase()],
  );
  return { companyId: company.rows[0]!.id, contactId: contact.rows[0]!.id };
}

describe("ReplyProcessingService.processInstantlyReply", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("records unmatched_contact and does not create a replies row when no contact matches", async () => {
    const ai = new FakeReplyAiClient({ intent: "other", confidence: 0.3 });
    const service = new ReplyProcessingService(ai);
    const result = await service.processInstantlyReply(payload({ leadEmail: "nobody@unknown.example.com" }));

    expect(result.status).toBe("unmatched_contact");
    expect(result.replyId).toBeNull();

    const replies = await pool.query("SELECT count(*) FROM replies");
    expect(Number(replies.rows[0].count)).toBe(0);

    const events = await pool.query("SELECT processed_at FROM webhook_events WHERE source = 'instantly'");
    expect(events.rows[0].processed_at).not.toBeNull();
  });

  it("tolerates duplicate webhook delivery: processes once, replays the result thereafter", async () => {
    const { contactId } = await insertContact();
    const ai = new FakeReplyAiClient({ intent: "interested", confidence: 0.9 });
    const service = new ReplyProcessingService(ai);
    const p = payload({ replyText: "Sounds interesting, tell me more." });

    const first = await service.processInstantlyReply(p);
    const second = await service.processInstantlyReply(p); // exact same externalEventId

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(second.replyId).toBe(first.replyId);
    expect(ai.callCount).toBe(1); // never re-classified

    const replies = await pool.query("SELECT count(*) FROM replies WHERE contact_id = $1", [contactId]);
    expect(Number(replies.rows[0].count)).toBe(1);
  });

  it("classifies an unsubscribe request deterministically and immediately suppresses the contact", async () => {
    await insertContact();
    const ai = new FakeReplyAiClient({ intent: "interested", confidence: 0.9 });
    const service = new ReplyProcessingService(ai);

    const result = await service.processInstantlyReply(payload({ replyText: "Please unsubscribe me." }));

    expect(result.intent).toBe("unsubscribe");
    expect(result.requiresHuman).toBe(false);
    expect(ai.callCount).toBe(0); // deterministic rule handled it, no AI call
    expect(await isSuppressed("contact@replyco.example.com")).toBe(true);
  });

  it("classifies a legal/compliance reply deterministically, flags requiresHuman, and does not call AI", async () => {
    await insertContact();
    const ai = new FakeReplyAiClient({ intent: "interested", confidence: 0.9 });
    const service = new ReplyProcessingService(ai);

    const result = await service.processInstantlyReply(
      payload({ replyText: "I've forwarded this to my attorney." }),
    );

    expect(result.intent).toBe("legal_compliance");
    expect(result.requiresHuman).toBe(true);
    expect(ai.callCount).toBe(0);
    // Legal replies are not auto-suppressed -- a human decides.
    expect(await isSuppressed("contact@replyco.example.com")).toBe(false);
  });

  it("defers to AI for an ambiguous reply and persists the AI's confidence", async () => {
    await insertContact();
    const ai = new FakeReplyAiClient({ intent: "question", confidence: 0.65 });
    const service = new ReplyProcessingService(ai);

    const result = await service.processInstantlyReply(payload({ replyText: "What's the pricing like?" }));

    expect(result.intent).toBe("question");
    expect(ai.callCount).toBe(1);

    const reply = await pool.query("SELECT intent_confidence FROM replies WHERE id = $1", [result.replyId]);
    expect(Number(reply.rows[0].intent_confidence)).toBeCloseTo(0.65);
  });

  it("links the reply to the contact's most recently sent message, when one exists", async () => {
    const { contactId, companyId } = await insertContact();
    const message = await pool.query<{ id: string }>(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, status, sent_at)
       VALUES ($1, $2, 'initial', 'dedup-reply-link', 'sent', now()) RETURNING id`,
      [contactId, companyId],
    );
    const ai = new FakeReplyAiClient({ intent: "interested", confidence: 0.9 });
    const service = new ReplyProcessingService(ai);

    const result = await service.processInstantlyReply(payload({ replyText: "Yes let's schedule a call!" }));
    const reply = await pool.query("SELECT message_id FROM replies WHERE id = $1", [result.replyId]);
    expect(reply.rows[0].message_id).toBe(message.rows[0]!.id);
  });

  it("logs a state transition marking the contact as replied", async () => {
    const { contactId } = await insertContact();
    const ai = new FakeReplyAiClient({ intent: "interested", confidence: 0.9 });
    const service = new ReplyProcessingService(ai);
    await service.processInstantlyReply(payload({ replyText: "Yes let's schedule a call!" }));

    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'contact' AND entity_id = $1 AND stage = 'process_reply'`,
      [contactId],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("replied");
  });
});
