import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { logStateTransition, type Actor } from "../../lib/stateLog.js";
import { logger } from "../../logging/logger.js";

// safety_state has exactly one row (CHECK (id = 1)); state_transitions
// requires a UUID entity_id, so this fixed nil UUID is the documented
// sentinel identifying "the whole system" as the entity for pause/resume
// transitions -- there is nothing else it could collide with.
const SAFETY_STATE_ENTITY_ID = "00000000-0000-0000-0000-000000000000";

export interface SafetyState {
  sendingPaused: boolean;
  pausedReason: string | null;
  pausedAt: Date | null;
  resumedAt: Date | null;
}

interface SafetyStateRow {
  sending_paused: boolean;
  paused_reason: string | null;
  paused_at: Date | null;
  resumed_at: Date | null;
}

function toSafetyState(row: SafetyStateRow): SafetyState {
  return {
    sendingPaused: row.sending_paused,
    pausedReason: row.paused_reason,
    pausedAt: row.paused_at,
    resumedAt: row.resumed_at,
  };
}

export async function getSafetyState(): Promise<SafetyState> {
  const res = await pool.query<SafetyStateRow>(
    `SELECT sending_paused, paused_reason, paused_at, resumed_at FROM safety_state WHERE id = 1`,
  );
  return toSafetyState(res.rows[0]!);
}

/**
 * The single reusable gate every send path (SendingService, SafeReplyService,
 * and any future one) checks before doing anything else -- a runtime kill
 * switch independent of the static DRY_RUN_SENDING/MOCK_EXTERNAL_APIS env
 * flags, so an operator (or evaluateSuppressionRate()) can halt all
 * outbound sending without a redeploy.
 */
export async function isSendingPaused(): Promise<boolean> {
  const res = await pool.query<{ sending_paused: boolean }>(`SELECT sending_paused FROM safety_state WHERE id = 1`);
  return res.rows[0]?.sending_paused ?? false;
}

export async function pauseSending(reason: string, actor: Actor = "human"): Promise<{ changed: boolean }> {
  const res = await pool.query(
    `UPDATE safety_state
     SET sending_paused = true, paused_reason = $1, paused_at = now(), resumed_at = NULL, updated_at = now()
     WHERE id = 1 AND sending_paused = false`,
    [reason],
  );
  const changed = (res.rowCount ?? 0) > 0;
  if (changed) {
    logger.error({ reason, actor }, "Sending paused (safety circuit breaker)");
    await logStateTransition({
      entityType: "system",
      entityId: SAFETY_STATE_ENTITY_ID,
      stage: "safety",
      fromState: "active",
      toState: "paused",
      actor,
      metadata: { reason },
    });
  }
  return { changed };
}

export async function resumeSending(actor: Actor = "human"): Promise<{ changed: boolean }> {
  const res = await pool.query(
    `UPDATE safety_state
     SET sending_paused = false, resumed_at = now(), updated_at = now()
     WHERE id = 1 AND sending_paused = true`,
  );
  const changed = (res.rowCount ?? 0) > 0;
  if (changed) {
    logger.info({ actor }, "Sending resumed");
    await logStateTransition({
      entityType: "system",
      entityId: SAFETY_STATE_ENTITY_ID,
      stage: "safety",
      fromState: "paused",
      toState: "active",
      actor,
      metadata: {},
    });
  }
  return { changed };
}

export interface SuppressionRateEvaluation {
  triggered: boolean;
  count: number;
  windowHours: number;
  maxAllowed: number;
  alreadyPaused: boolean;
}

/**
 * A circuit breaker over the whole campaign, not a single external API: if
 * more suppressions (unsubscribes, complaints, bounces, etc.) were
 * recorded in the trailing window than the configured threshold, sending
 * is auto-paused. Safe to call repeatedly/concurrently -- pauseSending()
 * is itself idempotent (only the first caller to see sending_paused=false
 * writes the transition).
 */
export async function evaluateSuppressionRate(
  windowHours: number = env.SAFETY_SUPPRESSION_WINDOW_HOURS,
  maxAllowed: number = env.SAFETY_MAX_SUPPRESSIONS_PER_WINDOW,
): Promise<SuppressionRateEvaluation> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM suppressions WHERE created_at > now() - ($1 || ' hours')::interval`,
    [String(windowHours)],
  );
  const count = Number(res.rows[0]?.count ?? 0);
  const triggered = count > maxAllowed;

  let alreadyPaused = false;
  if (triggered) {
    const before = await isSendingPaused();
    if (before) {
      alreadyPaused = true;
    } else {
      await pauseSending(
        `suppression_rate_exceeded: ${count} suppressions in the last ${windowHours}h (max ${maxAllowed})`,
        "system",
      );
    }
  }

  return { triggered, count, windowHours, maxAllowed, alreadyPaused };
}
