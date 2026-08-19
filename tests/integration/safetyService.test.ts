import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import {
  evaluateSuppressionRate,
  getSafetyState,
  isSendingPaused,
  pauseSending,
  resumeSending,
} from "../../src/domain/safety/safetyService.js";
import { suppress } from "../../src/lib/suppression.js";
import { truncateAll } from "../helpers/db.js";

describe("safetyService", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("starts unpaused by default", async () => {
    const state = await getSafetyState();
    expect(state.sendingPaused).toBe(false);
    expect(await isSendingPaused()).toBe(false);
  });

  it("pauseSending pauses and logs a single state transition", async () => {
    const result = await pauseSending("manual test pause", "human");
    expect(result.changed).toBe(true);
    expect(await isSendingPaused()).toBe(true);

    const state = await getSafetyState();
    expect(state.pausedReason).toBe("manual test pause");
    expect(state.pausedAt).not.toBeNull();

    const transitions = await pool.query(
      `SELECT to_state FROM state_transitions WHERE entity_type = 'system' ORDER BY created_at ASC`,
    );
    expect(transitions.rows.map((r) => r.to_state)).toEqual(["paused"]);
  });

  it("pauseSending is idempotent: calling it twice only writes one transition", async () => {
    await pauseSending("first", "human");
    const second = await pauseSending("second", "human");
    expect(second.changed).toBe(false);

    const transitions = await pool.query(
      `SELECT count(*)::int AS count FROM state_transitions WHERE entity_type = 'system' AND to_state = 'paused'`,
    );
    expect(transitions.rows[0].count).toBe(1);
  });

  it("resumeSending un-pauses and logs a transition; is a no-op if not paused", async () => {
    await pauseSending("pause first", "human");
    const result = await resumeSending("human");
    expect(result.changed).toBe(true);
    expect(await isSendingPaused()).toBe(false);

    const second = await resumeSending("human");
    expect(second.changed).toBe(false);
  });

  it("evaluateSuppressionRate does not trigger when under the threshold", async () => {
    const result = await evaluateSuppressionRate(24, 10);
    expect(result.triggered).toBe(false);
    expect(await isSendingPaused()).toBe(false);
  });

  it("evaluateSuppressionRate auto-pauses sending when the threshold is exceeded", async () => {
    for (let i = 0; i < 5; i++) {
      await suppress(`spike-${i}@safety.example.com`, "unsubscribed");
    }

    const result = await evaluateSuppressionRate(24, 3);
    expect(result.triggered).toBe(true);
    expect(result.count).toBe(5);
    expect(result.alreadyPaused).toBe(false);
    expect(await isSendingPaused()).toBe(true);
  });

  it("evaluateSuppressionRate reports alreadyPaused without writing a second transition", async () => {
    for (let i = 0; i < 5; i++) {
      await suppress(`spike2-${i}@safety.example.com`, "unsubscribed");
    }
    await evaluateSuppressionRate(24, 3);
    const second = await evaluateSuppressionRate(24, 3);

    expect(second.triggered).toBe(true);
    expect(second.alreadyPaused).toBe(true);

    const transitions = await pool.query(
      `SELECT count(*)::int AS count FROM state_transitions WHERE entity_type = 'system' AND to_state = 'paused'`,
    );
    expect(transitions.rows[0].count).toBe(1);
  });
});
