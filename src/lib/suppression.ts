import { query } from "../db/pool.js";
import { normalizeEmail } from "./normalize.js";
import { logStateTransition } from "./stateLog.js";
import { logger } from "../logging/logger.js";

export type SuppressionReason =
  | "unsubscribed"
  | "bounced"
  | "manual"
  | "legal"
  | "complaint"
  | "hostile";

/**
 * Requirement #8: "Suppression must be global across all campaigns."
 * Requirement #9: "Unsubscribe requests must immediately prevent future outreach."
 *
 * A single suppressions table keyed on normalized email is checked before
 * every send, across every campaign and every stage. There is no
 * per-campaign opt-out — once suppressed, a contact is suppressed
 * everywhere.
 */
export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return true; // no usable email => never send
  const res = await query(`SELECT 1 FROM suppressions WHERE email_normalized = $1`, [normalized]);
  return (res.rowCount ?? 0) > 0;
}

export async function suppress(
  email: string,
  reason: SuppressionReason,
  source?: string,
  notes?: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    logger.warn({ email }, "Attempted to suppress an unusable email; ignoring");
    return;
  }
  await query(
    `INSERT INTO suppressions (email_normalized, reason, source, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_normalized) DO UPDATE SET reason = EXCLUDED.reason, notes = EXCLUDED.notes`,
    [normalized, reason, source ?? null, notes ?? null],
  );
  logger.warn({ email: normalized, reason, source }, "Email added to global suppression list");

  const contactRes = await query<{ id: string }>(
    `SELECT id FROM contacts WHERE email_normalized = $1`,
    [normalized],
  );
  for (const row of contactRes.rows) {
    await logStateTransition({
      entityType: "contact",
      entityId: row.id,
      stage: "suppression",
      fromState: null,
      toState: "suppressed",
      actor: "system",
      metadata: { reason, source },
    });
  }
}
