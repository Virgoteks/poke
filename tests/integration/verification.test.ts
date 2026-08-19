import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import {
  ContactNotFoundError,
  VerificationService,
  isContactEmailVerified,
} from "../../src/domain/verification/verificationService.js";
import type { EmailVerificationClient, EmailVerificationOutcome } from "../../src/integrations/emailVerification/types.js";
import { truncateAll } from "../helpers/db.js";

class ThrowingVerificationClient implements EmailVerificationClient {
  async verify(): Promise<EmailVerificationOutcome> {
    throw new Error("should never be called for a missing/malformed email");
  }
}

class FixedVerificationClient implements EmailVerificationClient {
  public calls: string[] = [];
  constructor(private readonly result: EmailVerificationOutcome) {}
  async verify(email: string): Promise<EmailVerificationOutcome> {
    this.calls.push(email);
    return this.result;
  }
}

async function insertCompanyAndContact(email: string | null): Promise<string> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Verify Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, full_name, is_decision_maker)
     VALUES ($1, $2, $3, 'Alex Owner', true) RETURNING id`,
    [company.rows[0]!.id, email, email ? email.toLowerCase() : null],
  );
  return contact.rows[0]!.id;
}

describe("VerificationService.verifyContact", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws ContactNotFoundError for an unknown contact", async () => {
    const service = new VerificationService(new ThrowingVerificationClient());
    await expect(service.verifyContact("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      ContactNotFoundError,
    );
  });

  it("marks a contact with no email as invalid without calling the verification provider", async () => {
    const contactId = await insertCompanyAndContact(null);
    const service = new VerificationService(new ThrowingVerificationClient());

    const result = await service.verifyContact(contactId);
    expect(result.result).toBe("invalid");
    expect(result.eligibleForOutreach).toBe(false);

    const contact = await pool.query("SELECT verification_status, pipeline_stage FROM contacts WHERE id = $1", [
      contactId,
    ]);
    expect(contact.rows[0].verification_status).toBe("invalid");
    expect(contact.rows[0].pipeline_stage).toBe("verification_failed");

    const history = await pool.query("SELECT * FROM email_verifications WHERE contact_id = $1", [contactId]);
    expect(history.rowCount).toBe(1);
    expect(history.rows[0].provider).toBe("deterministic");
  });

  it("marks a malformed email as invalid without calling the verification provider", async () => {
    const contactId = await insertCompanyAndContact("not-an-email");
    const service = new VerificationService(new ThrowingVerificationClient());
    const result = await service.verifyContact(contactId);
    expect(result.result).toBe("invalid");
  });

  it("calls the verification provider for a well-formed email and persists the result", async () => {
    const contactId = await insertCompanyAndContact("owner@verify-co.example.com");
    const client = new FixedVerificationClient({ result: "valid", raw: { ok: true } });
    const service = new VerificationService(client);

    const result = await service.verifyContact(contactId);
    expect(result.result).toBe("valid");
    expect(result.eligibleForOutreach).toBe(true);
    expect(client.calls).toEqual(["owner@verify-co.example.com"]);

    const contact = await pool.query("SELECT verification_status, pipeline_stage FROM contacts WHERE id = $1", [
      contactId,
    ]);
    expect(contact.rows[0].verification_status).toBe("valid");
    expect(contact.rows[0].pipeline_stage).toBe("verified");

    expect(await isContactEmailVerified(contactId)).toBe(true);
  });

  it("treats risky and unknown results as not eligible for outreach", async () => {
    const contactId = await insertCompanyAndContact("owner@verify-co.example.com");
    const client = new FixedVerificationClient({ result: "risky", raw: {} });
    const service = new VerificationService(client);
    const result = await service.verifyContact(contactId);
    expect(result.eligibleForOutreach).toBe(false);
    expect(await isContactEmailVerified(contactId)).toBe(false);
  });

  it("appends to verification history on re-verification without duplicating the contact row", async () => {
    const contactId = await insertCompanyAndContact("owner@verify-co.example.com");
    const client = new FixedVerificationClient({ result: "valid", raw: {} });
    const service = new VerificationService(client);

    await service.verifyContact(contactId);
    await service.verifyContact(contactId);

    const history = await pool.query("SELECT count(*) FROM email_verifications WHERE contact_id = $1", [contactId]);
    expect(Number(history.rows[0].count)).toBe(2); // append-only history, both attempts recorded

    const contacts = await pool.query("SELECT count(*) FROM contacts WHERE id = $1", [contactId]);
    expect(Number(contacts.rows[0].count)).toBe(1); // exactly one contact row throughout

    const transitions = await pool.query(
      `SELECT count(*) FROM state_transitions WHERE entity_type = 'contact' AND entity_id = $1 AND stage = 'verify'`,
      [contactId],
    );
    expect(Number(transitions.rows[0].count)).toBe(1); // unchanged outcome -> no duplicate transition
  });

  it("isContactEmailVerified returns false for a contact that has never been verified", async () => {
    const contactId = await insertCompanyAndContact("owner@verify-co.example.com");
    expect(await isContactEmailVerified(contactId)).toBe(false);
  });
});
