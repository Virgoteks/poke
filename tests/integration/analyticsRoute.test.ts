import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/analytics routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).get("/analytics/funnel");
    expect(res.status).toBe(401);
  });

  it("GET /analytics/funnel returns the pipeline shape", async () => {
    await pool.query(`INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-ar1', 'Route Co', 'discovered')`);

    const res = await request(app).get("/analytics/funnel").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.companies.find((c: { stage: string }) => c.stage === "discovered").count).toBe(1);
    expect(res.body).toHaveProperty("contacts");
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("replies");
    expect(res.body).toHaveProperty("bookings");
  });

  it("GET /analytics/api-health returns provider stats and circuit breaker snapshot", async () => {
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status) VALUES ('instantly', 'send', 'success', 200)`,
    );

    const res = await request(app)
      .get("/analytics/api-health?hours=24")
      .set("x-internal-api-key", env.INTERNAL_API_KEY);

    expect(res.status).toBe(200);
    expect(res.body.providers.find((p: { provider: string }) => p.provider === "instantly").successCalls).toBe(1);
    expect(Array.isArray(res.body.circuitBreakers)).toBe(true);
  });

  it("GET /analytics/api-health rejects an invalid hours parameter", async () => {
    const res = await request(app)
      .get("/analytics/api-health?hours=not-a-number")
      .set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(400);
  });
});
