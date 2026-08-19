import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, withRetry } from "../../src/lib/retry.js";

describe("computeBackoffDelayMs", () => {
  it("grows exponentially with attempt number, capped at maxDelayMs", () => {
    const alwaysMax = () => 0.999999;
    expect(computeBackoffDelayMs(0, 100, 10_000, alwaysMax)).toBeLessThanOrEqual(100);
    expect(computeBackoffDelayMs(3, 100, 10_000, alwaysMax)).toBeLessThanOrEqual(800);
    expect(computeBackoffDelayMs(10, 100, 10_000, alwaysMax)).toBeLessThanOrEqual(10_000);
  });

  it("is always non-negative and within [0, cappedExp)", () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const delay = computeBackoffDelayMs(attempt, 50, 5000, () => 0.5);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure using exponential backoff and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient failure");
      return "recovered";
    });
    const sleeps: number[] = [];
    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    // Each backoff should be non-decreasing given fixed jitter and doubling base.
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]!);
  });

  it("throws after exhausting maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts immediately when isRetryable returns false", async () => {
    class PermanentError extends Error {}
    const fn = vi.fn().mockRejectedValue(new PermanentError("do not retry me"));
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        sleep: async () => {},
        isRetryable: (err) => !(err instanceof PermanentError),
      }),
    ).rejects.toThrow("do not retry me");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
