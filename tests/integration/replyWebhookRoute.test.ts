import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("POST /webhooks/instantly/reply", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without the correct webhook secret", async () => {
    const res = await request(app)
      .post("/webhooks/instantly/reply")
      .send({ event_id: "evt-1", lead_email: "a@b.com", reply_text: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid payload", async () => {
    const res = await request(app)
      .post("/webhooks/instantly/reply")
      .set("x-webhook-secret", env.INSTANTLY_WEBHOOK_SECRET)
      .send({ lead_email: "a@b.com" }); // missing event_id
    expect(res.status).toBe(400);
  });

  it("processes a valid webhook and tolerates duplicate delivery (both return 200)", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-rw1', 'Reply Webhook Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'lead@reply-webhook.example.com', 'lead@reply-webhook.example.com')`,
      [company.rows[0]!.id],
    );

    const body = { event_id: "evt-route-1", lead_email: "lead@reply-webhook.example.com", reply_text: "Interested, let's talk!" };

    const first = await request(app)
      .post("/webhooks/instantly/reply")
      .set("x-webhook-secret", env.INSTANTLY_WEBHOOK_SECRET)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("processed");

    const second = await request(app)
      .post("/webhooks/instantly/reply")
      .set("x-webhook-secret", env.INSTANTLY_WEBHOOK_SECRET)
      .send(body); // Instantly re-delivers the same event
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");

    const replies = await pool.query("SELECT count(*) FROM replies");
    expect(Number(replies.rows[0].count)).toBe(1);
  });

  it("immediately suppresses a contact who replies asking to unsubscribe", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-rw2', 'Unsub Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'unsub@reply-webhook.example.com', 'unsub@reply-webhook.example.com')`,
      [company.rows[0]!.id],
    );

    const res = await request(app)
      .post("/webhooks/instantly/reply")
      .set("x-webhook-secret", env.INSTANTLY_WEBHOOK_SECRET)
      .send({ event_id: "evt-route-2", lead_email: "unsub@reply-webhook.example.com", reply_text: "Please unsubscribe me from this." });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe("unsubscribe");

    const suppression = await pool.query("SELECT * FROM suppressions WHERE email_normalized = 'unsub@reply-webhook.example.com'");
    expect(suppression.rowCount).toBe(1);
  });
});
