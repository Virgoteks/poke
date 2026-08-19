import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/personalize routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/personalize/message").send({ contactId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 409 for an unverified contact", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-p1', 'Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified) VALUES ($1, true, 'rules_only', true)`,
      [company.rows[0]!.id],
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, verification_status) VALUES ($1, 'a@b.com', 'a@b.com', 'unverified') RETURNING id`,
      [company.rows[0]!.id],
    );

    const res = await request(app)
      .post("/personalize/message")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ contactId: contact.rows[0]!.id });
    expect(res.status).toBe(409);
  });

  it("personalizes a verified, qualified contact end-to-end using the mocked AI client", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-p2', 'Personalize Route Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified) VALUES ($1, true, 'rules_only', true)`,
      [company.rows[0]!.id],
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, first_name, verification_status)
       VALUES ($1, 'owner@route.example.com', 'owner@route.example.com', 'Sam', 'valid') RETURNING id`,
      [company.rows[0]!.id],
    );

    const res = await request(app)
      .post("/personalize/message")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ contactId: contact.rows[0]!.id });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");

    const row = await pool.query("SELECT * FROM messages WHERE id = $1", [res.body.messageId]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].subject).toContain("Personalize Route Co");
  });
});
