import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { redis } from "./redis.js";
import { logger } from "../logging/logger.js";

const LOCK_TTL_MS = 30_000;

export class IdempotencyLockError extends Error {
  constructor(key: string) {
    super(`Could not acquire idempotency lock for key "${key}" (another execution is in flight)`);
    this.name = "IdempotencyLockError";
  }
}

/**
 * Requirement: "Every workflow must be idempotent" + "Workflows must
 * tolerate duplicate webhook delivery."
 *
 * Combines a short-lived Redis lock (guards against concurrent duplicate
 * executions racing each other, e.g. n8n retrying a webhook while the first
 * delivery is still in flight) with a durable Postgres ledger (guards
 * against duplicate executions arriving minutes/hours apart). Database
 * UNIQUE constraints remain the ultimate source of truth for dedup; this
 * helper exists to avoid redundant external API calls / side effects.
 */
export async function withIdempotency<T>(
  key: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const existing = await query<{ result: unknown }>(
    `SELECT result FROM idempotency_keys WHERE key = $1`,
    [key],
  );
  if (existing.rowCount && existing.rowCount > 0) {
    logger.info({ key, operation }, "Idempotent replay: returning cached result");
    return { result: existing.rows[0]!.result as T, replayed: true };
  }

  const lockToken = randomUUID();
  const lockKey = `lock:${operation}:${key}`;
  const acquired = await redis.set(lockKey, lockToken, "PX", LOCK_TTL_MS, "NX");
  if (acquired !== "OK") {
    throw new IdempotencyLockError(key);
  }

  try {
    // Re-check after acquiring the lock in case another process just finished.
    const recheck = await query<{ result: unknown }>(
      `SELECT result FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    if (recheck.rowCount && recheck.rowCount > 0) {
      return { result: recheck.rows[0]!.result as T, replayed: true };
    }

    const result = await fn();
    await query(
      `INSERT INTO idempotency_keys (key, operation, result)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, operation, JSON.stringify(result ?? null)],
    );
    return { result, replayed: false };
  } finally {
    const currentToken = await redis.get(lockKey);
    if (currentToken === lockToken) {
      await redis.del(lockKey);
    }
  }
}
