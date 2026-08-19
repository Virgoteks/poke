import { pool } from "../../db/pool.js";

/**
 * FOLLOW UP reuses the same idempotent PERSONALIZE (Milestone 7) and SEND
 * (Milestone 7) endpoints with a later `stage` value (e.g. "followup_1")
 * -- there is no separate send path to duplicate. This function's only
 * job is answering "who is actually due for a follow-up right now":
 *   - they were sent `fromStage` at least `hoursSinceSent` hours ago
 *   - they have not already received `toStage` (idempotent: running this
 *     twice never queues a duplicate follow-up, since messages has
 *     UNIQUE(contact_id, stage))
 *   - they have not replied at all (a reply hands off to safe-reply /
 *     human review, not a scripted follow-up)
 *   - their email is still verified (requirement #7 applies to
 *     follow-ups too, and is re-checked again at actual send time)
 */
export async function getContactsDueForFollowup(
  fromStage: string,
  toStage: string,
  hoursSinceSent = 48,
  limit = 20,
): Promise<Array<{ id: string; fullName: string | null }>> {
  const res = await pool.query<{ id: string; full_name: string | null }>(
    `SELECT c.id, c.full_name
     FROM contacts c
     JOIN messages m_from ON m_from.contact_id = c.id AND m_from.stage = $1 AND m_from.status = 'sent'
     LEFT JOIN messages m_to ON m_to.contact_id = c.id AND m_to.stage = $2
     LEFT JOIN replies r ON r.contact_id = c.id
     WHERE m_from.sent_at < now() - ($3 || ' hours')::interval
       AND m_to.id IS NULL
       AND r.id IS NULL
       AND c.verification_status = 'valid'
     ORDER BY m_from.sent_at ASC
     LIMIT $4`,
    [fromStage, toStage, String(hoursSinceSent), limit],
  );
  return res.rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}
