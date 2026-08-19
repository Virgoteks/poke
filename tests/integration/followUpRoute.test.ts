import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/followup routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).get("/followup/pending?fromStage=initial&toStage=followup_1");
    expect(res.status).toBe(401);
  });

  it("returns 400 when required query params are missing", async () => {
    const res = await request(app).get("/followup/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(400);
  });

  it("lists contacts due for follow-up", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-fu1', 'Followup Route Co') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, verification_status)
       VALUES ($1, 'due@followup-route.example.com', 'due@followup-route.example.com', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, status, sent_at)
       VALUES ($1, $2, 'initial', 'dedup-fu-1', 'sent', now() - interval '72 hours')`,
      [contact.rows[0]!.id, company.rows[0]!.id],
    );

    const res = await request(app)
      .get("/followup/pending?fromStage=initial&toStage=followup_1&hoursSince=48")
      .set("x-internal-api-key", env.INTERNAL_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].id).toBe(contact.rows[0]!.id);
  });
});
