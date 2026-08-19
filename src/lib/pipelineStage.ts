import type pg from "pg";
import { pool } from "../db/pool.js";
import { logStateTransition, type EntityType } from "./stateLog.js";

const TABLE_BY_ENTITY: Record<"company" | "contact", string> = {
  company: "companies",
  contact: "contacts",
};

/**
 * Updates an entity's `pipeline_stage` column and writes a matching
 * `state_transitions` row — but only when the stage actually changes, so
 * re-running an idempotent stage against an already-processed entity
 * doesn't spam the audit log with no-op transitions.
 */
export async function transitionEntityStage(
  entityType: "company" | "contact",
  entityId: string,
  stage: string,
  toState: string,
  metadata: Record<string, unknown> = {},
  client?: pg.PoolClient,
): Promise<{ changed: boolean; fromState: string | null }> {
  const runner = client ?? pool;
  const table = TABLE_BY_ENTITY[entityType];
  const current = await runner.query<{ pipeline_stage: string }>(
    `SELECT pipeline_stage FROM ${table} WHERE id = $1`,
    [entityId],
  );
  const fromState = current.rows[0]?.pipeline_stage ?? null;
  if (fromState === toState) {
    return { changed: false, fromState };
  }
  await runner.query(`UPDATE ${table} SET pipeline_stage = $2, updated_at = now() WHERE id = $1`, [
    entityId,
    toState,
  ]);
  await logStateTransition(
    { entityType: entityType as EntityType, entityId, stage, fromState, toState, actor: "system", metadata },
    client,
  );
  return { changed: true, fromState };
}
