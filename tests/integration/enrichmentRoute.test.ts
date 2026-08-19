import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/enrich routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/enrich/contacts").send({ companyId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 409 when the company has not been qualified", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-er1', 'Unqualified Co', 'audited') RETURNING id`,
    );
    const res = await request(app)
      .post("/enrich/contacts")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId: company.rows[0]!.id });
    expect(res.status).toBe(409);
  });

  it("enriches a qualified company end-to-end using the mocked Apollo client", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, normalized_domain, pipeline_stage)
       VALUES ('place-er2', 'Enrich Route Co', 'enrich-route.example.com', 'qualified') RETURNING id`,
    );
    const companyId = company.rows[0]!.id;
    await pool.query(
      `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified) VALUES ($1, true, 'rules_only', true)`,
      [companyId],
    );

    const res = await request(app)
      .post("/enrich/contacts")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId });

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(res.body.contactsFound).toBeGreaterThan(0);
  });

  it("GET /enrich/pending lists qualified companies", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-er3', 'Pending Enrich Co', 'qualified') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified) VALUES ($1, true, 'rules_only', true)`,
      [company.rows[0]!.id],
    );

    const res = await request(app).get("/enrich/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].name).toBe("Pending Enrich Co");
  });
});
