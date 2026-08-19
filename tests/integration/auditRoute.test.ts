import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/audit routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/audit/website").send({ companyId: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects a non-UUID companyId", async () => {
    const res = await request(app)
      .post("/audit/website")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown company", async () => {
    const res = await request(app)
      .post("/audit/website")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("audits a real discovered company end-to-end using the mocked crawler + pagespeed clients", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, website, pipeline_stage)
       VALUES ('place-audit-1', 'Audit Me Co', 'https://audit-me.example.com', 'discovered') RETURNING id`,
    );
    const companyId = company.rows[0]!.id;

    const res = await request(app)
      .post("/audit/website")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId });

    expect(res.status).toBe(200);
    expect(["completed", "failed"]).toContain(res.body.status);
    expect(res.body.companyId).toBe(companyId);

    const audit = await pool.query("SELECT * FROM website_audits WHERE company_id = $1", [companyId]);
    expect(audit.rowCount).toBe(1);
  });

  it("GET /audit/pending lists discovered companies awaiting audit", async () => {
    await pool.query(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-pending-1', 'Pending Co', 'discovered')`,
    );
    await pool.query(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-pending-2', 'Already Audited Co', 'audited')`,
    );

    const res = await request(app).get("/audit/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].name).toBe("Pending Co");
  });
});
