import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "../../src/db/pool.js";
import { closeRedis, redis } from "../../src/lib/redis.js";
import { withIdempotency } from "../../src/lib/idempotency.js";
import { truncateAll } from "../helpers/db.js";

describe("withIdempotency", () => {
  beforeEach(async () => {
    await truncateAll();
    await redis.flushdb();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("runs the operation exactly once and replays the cached result on subsequent calls", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { value: 42 };
    };

    const first = await withIdempotency("key-1", "test-op", fn);
    expect(first.replayed).toBe(false);
    expect(first.result).toEqual({ value: 42 });

    const second = await withIdempotency("key-1", "test-op", fn);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual({ value: 42 });

    expect(calls).toBe(1);
  });

  it("tolerates duplicate webhook-style delivery for different keys independently", async () => {
    const results: number[] = [];
    for (const key of ["a", "b", "a", "b", "a"]) {
      const { result } = await withIdempotency(key, "webhook-op", async () => {
        results.push(results.length);
        return results.length;
      });
      void result;
    }
    // Only 2 unique keys, so the underlying operation should have run twice.
    expect(results).toHaveLength(2);
  });

  it("propagates errors and does not persist a result for a failed operation", async () => {
    await expect(
      withIdempotency("key-fail", "test-op", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A retry after a failure should re-run the operation, not replay a phantom result.
    const retry = await withIdempotency("key-fail", "test-op", async () => "recovered");
    expect(retry.replayed).toBe(false);
    expect(retry.result).toBe("recovered");
  });
});
