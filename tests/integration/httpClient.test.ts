import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { callExternalApi, ExternalApiError } from "../../src/integrations/httpClient.js";
import { getCircuitBreaker } from "../../src/lib/circuitBreaker.js";
import { truncateAll } from "../helpers/db.js";

describe("callExternalApi (retry + circuit breaker + api_call_log composition)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("logs one api_call_log row per attempt and succeeds after transient failures", async () => {
    let attempts = 0;
    const result = await callExternalApi(
      "test_provider_retry",
      "do_thing",
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new ExternalApiError("temporary failure", 503);
        }
        return "ok";
      },
      { baseDelayMs: 1, maxDelayMs: 5, sleep: async () => {} },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);

    const rows = await pool.query(
      `SELECT outcome, attempt, http_status FROM api_call_log WHERE provider = 'test_provider_retry' ORDER BY attempt`,
    );
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.map((r) => r.outcome)).toEqual(["failure", "failure", "success"]);
    expect(rows.rows[0].http_status).toBe(503);
  });

  it("does not retry a non-retryable (4xx, non-429) failure", async () => {
    let attempts = 0;
    await expect(
      callExternalApi(
        "test_provider_no_retry",
        "do_thing",
        async () => {
          attempts++;
          throw new ExternalApiError("bad request", 400);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  it("opens the circuit breaker after repeated failures and short-circuits further calls", async () => {
    const provider = "test_provider_breaker";
    getCircuitBreaker(provider, { failureThreshold: 2, resetTimeoutMs: 60_000 }).reset();

    for (let i = 0; i < 2; i++) {
      await expect(
        callExternalApi(
          provider,
          "do_thing",
          async () => {
            throw new ExternalApiError("down", 500);
          },
          { maxAttempts: 1, sleep: async () => {} },
        ),
      ).rejects.toThrow();
    }

    let calledAfterOpen = false;
    await expect(
      callExternalApi(provider, "do_thing", async () => {
        calledAfterOpen = true;
        return "should not run";
      }),
    ).rejects.toThrow(/Circuit breaker is open/);
    expect(calledAfterOpen).toBe(false);
  });
});
