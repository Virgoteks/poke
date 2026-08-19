import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/send routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/send/message").send({ messageId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown message", async () => {
    const res = await request(app)
      .post("/send/message")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ messageId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("sends a queued, verified message end-to-end via the mocked (dry-run) Instantly client -- never a real send", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-s1', 'Send Route Co') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
       VALUES ($1, 'owner@send-route.example.com', 'owner@send-route.example.com', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );
    const message = await pool.query<{ id: string }>(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, status)
       VALUES ($1, $2, 'initial', 'dedup-route-1', 'Subject', 'Body', 'queued') RETURNING id`,
      [contact.rows[0]!.id, company.rows[0]!.id],
    );

    const res = await request(app)
      .post("/send/message")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ messageId: message.rows[0]!.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");

    const row = await pool.query("SELECT instantly_message_id FROM messages WHERE id = $1", [message.rows[0]!.id]);
    expect(row.rows[0].instantly_message_id).toContain("mock-instantly-"); // proves the dry-run mock path was used
  });

  it("GET /send/pending lists queued messages", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-s2', 'Pending Send Co') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, verification_status) VALUES ($1, 'a@b.com', 'a@b.com', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, status) VALUES ($1, $2, 'initial', 'dedup-route-2', 'queued')`,
      [contact.rows[0]!.id, company.rows[0]!.id],
    );

    const res = await request(app).get("/send/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });
});
