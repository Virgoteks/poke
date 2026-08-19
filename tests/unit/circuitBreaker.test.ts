import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/lib/circuitBreaker.js";

describe("CircuitBreaker", () => {
  it("stays closed while calls succeed", async () => {
    const cb = new CircuitBreaker("test-provider", { failureThreshold: 3 });
    await cb.exec(async () => "ok");
    await cb.exec(async () => "ok");
    expect(cb.getState()).toBe("closed");
  });

  it("opens after reaching the failure threshold and rejects further calls", async () => {
    const cb = new CircuitBreaker("test-provider-2", { failureThreshold: 2 });
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    expect(cb.getState()).toBe("open");
    await expect(cb.exec(async () => "should not run")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("moves to half-open after resetTimeoutMs and closes again on success", async () => {
    let now = 0;
    const cb = new CircuitBreaker("test-provider-3", {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: () => now,
    });
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow();
    expect(cb.getState()).toBe("open");

    now += 500;
    expect(cb.getState()).toBe("open"); // not enough time elapsed yet

    now += 600;
    expect(cb.getState()).toBe("half_open");

    const result = await cb.exec(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens immediately on a failed half-open probe", async () => {
    let now = 0;
    const cb = new CircuitBreaker("test-provider-4", {
      failureThreshold: 1,
      resetTimeoutMs: 100,
      now: () => now,
    });
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow();
    now += 200;
    expect(cb.getState()).toBe("half_open");
    await expect(cb.exec(async () => { throw new Error("still failing"); })).rejects.toThrow();
    expect(cb.getState()).toBe("open");
  });
});
