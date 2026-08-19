import { pool } from "../../db/pool.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { isValidEmailFormat } from "../../lib/normalize.js";
import { logger } from "../../logging/logger.js";
import {
  createEmailVerificationClient,
  type EmailVerificationClient,
  type VerificationResult,
} from "../../integrations/emailVerification/index.js";

export class ContactNotFoundError extends Error {
  constructor(public readonly contactId: string) {
    super(`Contact ${contactId} not found`);
    this.name = "ContactNotFoundError";
  }
}

interface ContactRow {
  id: string;
  email: string | null;
}

export interface VerificationOutcome {
  contactId: string;
  result: VerificationResult;
  eligibleForOutreach: boolean;
}

export class VerificationService {
  constructor(private readonly client: EmailVerificationClient = createEmailVerificationClient()) {}

  async verifyContact(contactId: string): Promise<VerificationOutcome> {
    const res = await pool.query<ContactRow>(`SELECT id, email FROM contacts WHERE id = $1`, [contactId]);
    const contact = res.rows[0];
    if (!contact) throw new ContactNotFoundError(contactId);

    let result: VerificationResult;
    let raw: unknown;
    let provider: string;

    // Deterministic rule before any external call: a missing or
    // malformed email is unconditionally invalid -- no reason to spend an
    // API credit finding that out.
    if (!contact.email || !isValidEmailFormat(contact.email)) {
      result = "invalid";
      raw = { reason: "missing_or_malformed_email" };
      provider = "deterministic";
    } else {
      const outcome = await this.client.verify(contact.email);
      result = outcome.result;
      raw = outcome.raw;
      provider = "email_verification_api";
    }

    await pool.query(
      `INSERT INTO email_verifications (contact_id, email, result, provider, raw_response)
       VALUES ($1, $2, $3, $4, $5)`,
      [contactId, contact.email ?? "", result, provider, JSON.stringify(raw)],
    );

    await pool.query(
      `UPDATE contacts SET verification_status = $2, verification_checked_at = now(), updated_at = now() WHERE id = $1`,
      [contactId, result],
    );

    const toState = result === "valid" ? "verified" : "verification_failed";
    await transitionEntityStage("contact", contactId, "verify", toState, { result });

    logger.info({ contactId, result }, "Email verification complete");

    return { contactId, result, eligibleForOutreach: result === "valid" };
  }
}

export async function getContactsPendingVerification(
  limit = 20,
): Promise<Array<{ id: string; fullName: string | null; email: string | null }>> {
  const res = await pool.query<{ id: string; full_name: string | null; email: string | null }>(
    `SELECT id, full_name, email FROM contacts
     WHERE email IS NOT NULL AND verification_status = 'unverified'
     ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email }));
}

/**
 * The single source of truth for requirement #7: "Unverified email
 * addresses must never receive outreach." Every stage that could
 * possibly send something to a contact (SEND, FOLLOW UP, safe replies)
 * must gate on this before doing so.
 */
export async function isContactEmailVerified(contactId: string): Promise<boolean> {
  const res = await pool.query<{ verification_status: string }>(
    `SELECT verification_status FROM contacts WHERE id = $1`,
    [contactId],
  );
  return res.rows[0]?.verification_status === "valid";
}
