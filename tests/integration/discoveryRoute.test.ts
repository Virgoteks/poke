import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("POST /discover/places", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).post("/discover/places").send({ query: "coffee shops" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body", async () => {
    const res = await request(app)
      .post("/discover/places")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it("discovers and persists businesses using the mocked Google Places client", async () => {
    const res = await request(app)
      .post("/discover/places")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ query: "coffee shops in orlando", maxResults: 4 });

    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(4);
    expect(res.body.created).toBe(4);
    expect(res.body.companies).toHaveLength(4);

    const rows = await pool.query("SELECT count(*) FROM companies");
    expect(Number(rows.rows[0].count)).toBe(4);
  });
});
