import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";

describe("health endpoints", () => {
  const app = createApp();

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("GET /healthz returns ok without touching the database", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz reports database and redis connectivity", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.checks).toEqual({ database: true, redis: true });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
