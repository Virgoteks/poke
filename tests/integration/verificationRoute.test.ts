import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/verify routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/verify/email").send({ contactId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown contact", async () => {
    const res = await request(app)
      .post("/verify/email")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ contactId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("verifies a contact end-to-end using the mocked verification client", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-v1', 'Verify Route Co') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized, is_decision_maker)
       VALUES ($1, 'owner@verify-route.example.com', 'owner@verify-route.example.com', true) RETURNING id`,
      [company.rows[0]!.id],
    );

    const res = await request(app)
      .post("/verify/email")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ contactId: contact.rows[0]!.id });

    expect(res.status).toBe(200);
    expect(["valid", "invalid", "risky", "unknown"]).toContain(res.body.result);
  });

  it("GET /verify/pending lists contacts with an email awaiting verification", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-v2', 'Pending Verify Co') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized, is_decision_maker) VALUES ($1, 'a@b.com', 'a@b.com', true)`,
      [company.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized, is_decision_maker) VALUES ($1, NULL, NULL, false)`,
      [company.rows[0]!.id],
    );

    const res = await request(app).get("/verify/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].email).toBe("a@b.com");
  });
});
