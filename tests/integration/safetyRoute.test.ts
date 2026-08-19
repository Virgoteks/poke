import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { closePool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { env } from "../../src/config/env.js";
import { truncateAll } from "../helpers/db.js";

describe("/safety routes", () => {
  const app = createApp();

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("rejects requests without a valid internal API key", async () => {
    const res = await request(app).get("/safety/status");
    expect(res.status).toBe(401);
  });

  it("GET /safety/status starts unpaused", async () => {
    const res = await request(app).get("/safety/status").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.sendingPaused).toBe(false);
  });

  it("POST /safety/pause requires a reason", async () => {
    const res = await request(app).post("/safety/pause").set("x-internal-api-key", env.INTERNAL_API_KEY).send({});
    expect(res.status).toBe(400);
  });

  it("pauses and resumes sending end-to-end", async () => {
    const pauseRes = await request(app)
      .post("/safety/pause")
      .set("x-internal-api-key", env.INTERNAL_API_KEY)
      .send({ reason: "route test pause" });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.changed).toBe(true);

    const statusRes = await request(app).get("/safety/status").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(statusRes.body.sendingPaused).toBe(true);
    expect(statusRes.body.pausedReason).toBe("route test pause");

    const resumeRes = await request(app).post("/safety/resume").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.changed).toBe(true);

    const afterResume = await request(app).get("/safety/status").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(afterResume.body.sendingPaused).toBe(false);
  });

  it("POST /safety/evaluate reports no trigger when suppression volume is normal", async () => {
    const res = await request(app).post("/safety/evaluate").set("x-internal-api-key", env.INTERNAL_API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.triggered).toBe(false);
  });
});
