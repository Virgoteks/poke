import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/reply/safe-response routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/reply/safe-response").send({ replyId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid body", async () => {
    const res = await request(app)
      .post("/reply/safe-response")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ replyId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown reply", async () => {
    const res = await request(app)
      .post("/reply/safe-response")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ replyId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("generates and sends a safe reply end-to-end via the mocked (dry-run) clients -- never a real send", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-sr1', 'Safe Reply Route Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified, ai_reasoning)
       VALUES ($1, NULL, 'rules_and_ai', true, 'Slow mobile PageSpeed score')`,
      [company.rows[0]!.id],
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, first_name, verification_status)
       VALUES ($1, 'owner@safe-reply-route.example.com', 'owner@safe-reply-route.example.com', 'Jordan', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );
    const message = await pool.query<{ id: string }>(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, status, instantly_message_id, sent_at)
       VALUES ($1, $2, 'initial', 'dedup-sr-1', 'Quick note', 'Original body', 'sent', 'orig-msg-route', now()) RETURNING id`,
      [contact.rows[0]!.id, company.rows[0]!.id],
    );
    const reply = await pool.query<{ id: string }>(
      `INSERT INTO replies (message_id, contact_id, provider, provider_event_id, body, intent, requires_human, received_at)
       VALUES ($1, $2, 'instantly', 'evt-sr-1', 'Sounds great, tell me more', 'interested', false, now()) RETURNING id`,
      [message.rows[0]!.id, contact.rows[0]!.id],
    );

    const res = await request(app)
      .post("/reply/safe-response")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ replyId: reply.rows[0]!.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");

    const row = await pool.query("SELECT auto_reply_sent FROM replies WHERE id = $1", [reply.rows[0]!.id]);
    expect(row.rows[0].auto_reply_sent).toBe(true);
  });

  it("GET /reply/pending-safe-response lists eligible replies", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-sr2', 'Pending Safe Reply Co') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
       VALUES ($1, 'p@psr.example.com', 'p@psr.example.com', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO replies (contact_id, provider, provider_event_id, body, intent, requires_human, received_at)
       VALUES ($1, 'instantly', 'evt-sr-2', 'A question', 'question', false, now())`,
      [contact.rows[0]!.id],
    );

    const res = await request(app).get("/reply/pending-safe-response").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.replies).toHaveLength(1);
  });
});
