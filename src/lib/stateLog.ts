import type pg from "pg";
import { pool, query } from "../db/pool.js";
import { logger } from "../logging/logger.js";

export type EntityType = "company" | "contact" | "message" | "reply" | "booking" | "system";
export type Actor = "system" | "ai" | "n8n" | "webhook" | "human";

export interface StateTransitionInput {
  entityType: EntityType;
  entityId: string;
  stage: string;
  fromState: string | null;
  toState: string;
  actor?: Actor;
  metadata?: Record<string, unknown>;
}

/**
 * Requirement: "All significant state transitions must be logged."
 * Every pipeline stage writes here whenever an entity moves between states,
 * giving ANALYZE (Milestone 11) and support/debugging a full audit trail.
 */
export async function logStateTransition(
  input: StateTransitionInput,
  client?: pg.PoolClient,
): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO state_transitions (entity_type, entity_id, stage, from_state, to_state, actor, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.entityType,
      input.entityId,
      input.stage,
      input.fromState,
      input.toState,
      input.actor ?? "system",
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  logger.info(
    {
      entityType: input.entityType,
      entityId: input.entityId,
      stage: input.stage,
      fromState: input.fromState,
      toState: input.toState,
      actor: input.actor ?? "system",
    },
    "state_transition",
  );
}

export async function getStateTransitions(entityType: EntityType, entityId: string) {
  const res = await query(
    `SELECT * FROM state_transitions WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at ASC`,
    [entityType, entityId],
  );
  return res.rows;
}
