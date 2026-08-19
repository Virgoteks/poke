import { Router } from "express";
import { pool } from "../../db/pool.js";
import { redis } from "../../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/readyz", async (_req, res) => {
  const checks: Record<string, boolean> = { database: false, redis: false };
  try {
    await pool.query("SELECT 1");
    checks.database = true;
  } catch {
    checks.database = false;
  }
  try {
    await redis.ping();
    checks.redis = true;
  } catch {
    checks.redis = false;
  }
  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
});
