import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { getContactsDueForFollowup } from "../../src/domain/followUp/followUpService.js";
import { truncateAll } from "../helpers/db.js";

async function makeContact(opts: {
  verificationStatus?: string;
  fullName?: string;
} = {}): Promise<{ contactId: string; companyId: string }> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name) VALUES ($1, 'Follow Up Co') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const companyId = company.rows[0]!.id;
  const email = `contact-${Math.random()}@followup.example.com`;
  const contact = await pool.query<{ id: string }>(
    `INSERT INTO contacts (company_id, email, email_normalized, full_name, verification_status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, email, email, opts.fullName ?? "Jamie Prospect", opts.verificationStatus ?? "valid"],
  );
  return { contactId: contact.rows[0]!.id, companyId };
}

async function sendMessage(
  contactId: string,
  companyId: string,
  stage: string,
  hoursAgo: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, status, sent_at)
     VALUES ($1, $2, $3, $4, 'Subject', 'Body', 'sent', now() - ($5 || ' hours')::interval)`,
    [contactId, companyId, stage, `dedup-${Math.random()}`, String(hoursAgo)],
  );
}

describe("getContactsDueForFollowup", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("includes a contact sent the initial message more than hoursSinceSent ago with no follow-up yet", async () => {
    const { contactId, companyId } = await makeContact();
    await sendMessage(contactId, companyId, "initial", 72);

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 20);
    expect(due.map((d) => d.id)).toContain(contactId);
    expect(due.find((d) => d.id === contactId)?.fullName).toBe("Jamie Prospect");
  });

  it("excludes a contact whose initial message was sent less than hoursSinceSent ago", async () => {
    const { contactId, companyId } = await makeContact();
    await sendMessage(contactId, companyId, "initial", 5);

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 20);
    expect(due.map((d) => d.id)).not.toContain(contactId);
  });

  it("excludes a contact who already received the follow-up stage (idempotent)", async () => {
    const { contactId, companyId } = await makeContact();
    await sendMessage(contactId, companyId, "initial", 72);
    await sendMessage(contactId, companyId, "followup_1", 1);

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 20);
    expect(due.map((d) => d.id)).not.toContain(contactId);
  });

  it("excludes a contact who has replied at all, even if otherwise due", async () => {
    const { contactId, companyId } = await makeContact();
    await sendMessage(contactId, companyId, "initial", 72);
    const message = await pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE contact_id = $1 AND stage = 'initial'`,
      [contactId],
    );
    await pool.query(
      `INSERT INTO replies (message_id, contact_id, provider, provider_event_id, body, received_at)
       VALUES ($1, $2, 'instantly', $3, 'a reply', now())`,
      [message.rows[0]!.id, contactId, `evt-${Math.random()}`],
    );

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 20);
    expect(due.map((d) => d.id)).not.toContain(contactId);
  });

  it("excludes a contact whose email is no longer verified", async () => {
    const { contactId, companyId } = await makeContact({ verificationStatus: "invalid" });
    await sendMessage(contactId, companyId, "initial", 72);

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 20);
    expect(due.map((d) => d.id)).not.toContain(contactId);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 3; i++) {
      const { contactId, companyId } = await makeContact();
      await sendMessage(contactId, companyId, "initial", 72);
    }

    const due = await getContactsDueForFollowup("initial", "followup_1", 48, 2);
    expect(due).toHaveLength(2);
  });
});
