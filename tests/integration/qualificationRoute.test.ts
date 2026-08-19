import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/qualify routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/qualify").send({ companyId: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 409 when the company has not been audited yet", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-q1', 'No Audit Co', 'discovered') RETURNING id`,
    );
    const res = await request(app)
      .post("/qualify")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ companyId: company.rows[0]!.id });
    expect(res.status).toBe(409);
  });

  it("qualifies an audited company end-to-end using the mocked AI client", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, website, pipeline_stage)
       VALUES ('place-q2', 'Qualify Me Co', 'https://qualify-me.example.com', 'audited') RETURNING id`,
    );
    const companyId = company.rows[0]!.id;
    await pool.query(
      `INSERT INTO website_audits (company_id, url, status, pagespeed_mobile_score, pagespeed_desktop_score, crawled_at)
       VALUES ($1, 'https://qualify-me.example.com', 'completed', 55, 60, now())`,
      [companyId],
    );

    const res = await request(app).post("/qualify").set("x-internal-api-key", env.INTERNAL_API_KEY).send({ companyId });
    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe(companyId);
    expect(["hot", "warm", "cold", "disqualified"]).toContain(res.body.tier);

    const row = await pool.query("SELECT * FROM qualifications WHERE company_id = $1", [companyId]);
    expect(row.rowCount).toBe(1);
  });

  it("GET /qualify/pending lists audited companies", async () => {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-q3', 'Pending Qual Co', 'audited') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO website_audits (company_id, url, status, crawled_at) VALUES ($1, 'https://x.com', 'completed', now())`,
      [c.rows[0]!.id],
    );

    const res = await request(app).get("/qualify/pending").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(1);
    expect(res.body.companies[0].name).toBe("Pending Qual Co");
  });
});
