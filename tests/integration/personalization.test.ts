import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import {
  CompanyNotQualifiedError,
  ContactNotFoundError,
  ContactNotVerifiedError,
  PersonalizationService,
  computeDedupKey,
} from "../../src/domain/personalization/personalizationService.js";
import type {
  PersonalizationAiClient,
  PersonalizationFacts,
  PersonalizationResult,
} from "../../src/integrations/openai/personalization/types.js";
import { truncateAll } from "../helpers/db.js";

class FakePersonalizationClient implements PersonalizationAiClient {
  public callCount = 0;
  public lastFacts: PersonalizationFacts | null = null;
  constructor(private readonly result: PersonalizationResult) {}
  async generate(facts: PersonalizationFacts): Promise<PersonalizationResult> {
    this.callCount++;
    this.lastFacts = facts;
    return this.result;
  }
}

async function insertFullPipeline(opts: {
  verificationStatus?: string;
  finalQualified?: boolean;
  skipQualification?: boolean;
} = {}): Promise<{ companyId: string; contactId: string }> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Personalize Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const companyId = company.rows[0]!.id;

  if (!opts.skipQualification) {
    await pool.query(
      `INSERT INTO qualifications (company_id, ai_qualified, ai_tier, ai_reasoning, decided_by, final_qualified)
       VALUES ($1, $2, 'warm', 'PageSpeed score is 55', 'rules_and_ai', $2)`,
      [companyId, opts.finalQualified ?? true],
    );
  }

  await pool.query(
    `INSERT INTO website_audits (company_id, url, status, pagespeed_mobile_score, pagespeed_desktop_score, crawl_signals, crawled_at)
     VALUES ($1, 'https://x.com', 'completed', 55, 60, $2, now())`,
    [companyId, JSON.stringify({ hasContactForm: true, wordCount: 400, cmsGuess: "wordpress" })],
  );

  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, first_name, is_decision_maker, verification_status)
     VALUES ($1, 'owner@personalize.example.com', 'owner@personalize.example.com', 'Alex', true, $2) RETURNING id`,
    [companyId, opts.verificationStatus ?? "valid"],
  );

  return { companyId, contactId: contact.rows[0]!.id };
}

describe("PersonalizationService.personalizeContact", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws ContactNotFoundError for an unknown contact", async () => {
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "s", body: "b" }));
    await expect(service.personalizeContact("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      ContactNotFoundError,
    );
  });

  it("throws ContactNotVerifiedError for a contact whose email isn't verified", async () => {
    const { contactId } = await insertFullPipeline({ verificationStatus: "unverified" });
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "s", body: "b" }));
    await expect(service.personalizeContact(contactId)).rejects.toBeInstanceOf(ContactNotVerifiedError);
  });

  it("throws CompanyNotQualifiedError when there is no qualification record", async () => {
    const { contactId } = await insertFullPipeline({ skipQualification: true });
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "s", body: "b" }));
    await expect(service.personalizeContact(contactId)).rejects.toBeInstanceOf(CompanyNotQualifiedError);
  });

  it("throws CompanyNotQualifiedError when the company was disqualified", async () => {
    const { contactId } = await insertFullPipeline({ finalQualified: false });
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "s", body: "b" }));
    await expect(service.personalizeContact(contactId)).rejects.toBeInstanceOf(CompanyNotQualifiedError);
  });

  it("generates and persists a message with a deterministic dedup_key", async () => {
    const { contactId } = await insertFullPipeline();
    const ai = new FakePersonalizationClient({ subject: "Quick note", body: "Hi Alex, ..." });
    const service = new PersonalizationService(ai);

    const result = await service.personalizeContact(contactId, "initial");
    expect(result.status).toBe("queued");
    expect(result.regenerated).toBe(true);

    const row = await pool.query("SELECT * FROM messages WHERE id = $1", [result.messageId]);
    expect(row.rows[0].dedup_key).toBe(computeDedupKey(contactId, "initial"));
    expect(row.rows[0].subject).toBe("Quick note");
    expect(ai.lastFacts?.contactFirstName).toBe("Alex");
    expect(ai.lastFacts?.pagespeedMobileScore).toBe(55);
  });

  it("is idempotent: re-personalizing a queued message updates content in place, not a new row", async () => {
    const { contactId } = await insertFullPipeline();
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "v1", body: "v1 body" }));
    await service.personalizeContact(contactId, "initial");

    const service2 = new PersonalizationService(new FakePersonalizationClient({ subject: "v2", body: "v2 body" }));
    const result2 = await service2.personalizeContact(contactId, "initial");
    expect(result2.regenerated).toBe(true);

    const rows = await pool.query("SELECT * FROM messages WHERE contact_id = $1 AND stage = 'initial'", [contactId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].subject).toBe("v2");
  });

  it("never overwrites a message that has already been sent", async () => {
    const { contactId } = await insertFullPipeline();
    const service = new PersonalizationService(new FakePersonalizationClient({ subject: "original", body: "original body" }));
    await service.personalizeContact(contactId, "initial");
    await pool.query(`UPDATE messages SET status = 'sent', sent_at = now() WHERE contact_id = $1`, [contactId]);

    const service2 = new PersonalizationService(new FakePersonalizationClient({ subject: "should not apply", body: "x" }));
    const result2 = await service2.personalizeContact(contactId, "initial");
    expect(result2.status).toBe("sent");
    expect(result2.regenerated).toBe(false);

    const row = await pool.query("SELECT subject FROM messages WHERE contact_id = $1 AND stage = 'initial'", [contactId]);
    expect(row.rows[0].subject).toBe("original");
  });
});
