import { createHash } from "node:crypto";
import { pool } from "../../db/pool.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logger } from "../../logging/logger.js";
import {
  createPersonalizationAiClient,
  type PersonalizationAiClient,
  type PersonalizationFacts,
} from "../../integrations/openai/personalization/index.js";

export class ContactNotFoundError extends Error {
  constructor(public readonly contactId: string) {
    super(`Contact ${contactId} not found`);
    this.name = "ContactNotFoundError";
  }
}

export class ContactNotVerifiedError extends Error {
  constructor(public readonly contactId: string) {
    super(`Contact ${contactId}'s email is not verified; cannot personalize outreach for it yet`);
    this.name = "ContactNotVerifiedError";
  }
}

export class CompanyNotQualifiedError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} is not qualified; refusing to generate outreach for it`);
    this.name = "CompanyNotQualifiedError";
  }
}

interface ContactRow {
  id: string;
  company_id: string;
  first_name: string | null;
  title: string | null;
  verification_status: string;
}

interface CompanyRow {
  id: string;
  name: string;
}

interface QualificationRow {
  final_qualified: boolean;
  ai_tier: string | null;
  ai_reasoning: string | null;
  deterministic_flags: { reason?: string } | null;
}

interface AuditRow {
  pagespeed_mobile_score: number | null;
  pagespeed_desktop_score: number | null;
  error: string | null;
  crawl_signals: { hasContactForm?: boolean; wordCount?: number; cmsGuess?: string | null } | null;
}

const SENDER_NAME = "Ron Smith";
const SENDER_COMPANY = "Smith Consulting SBC";

export function computeDedupKey(contactId: string, stage: string): string {
  return createHash("sha256").update(`${contactId}:${stage}`).digest("hex");
}

export interface PersonalizationOutcome {
  messageId: string;
  contactId: string;
  stage: string;
  status: string;
  regenerated: boolean;
}

export class PersonalizationService {
  constructor(private readonly aiClient: PersonalizationAiClient = createPersonalizationAiClient()) {}

  async personalizeContact(contactId: string, stage = "initial"): Promise<PersonalizationOutcome> {
    const contactRes = await pool.query<ContactRow>(
      `SELECT id, company_id, first_name, title, verification_status FROM contacts WHERE id = $1`,
      [contactId],
    );
    const contact = contactRes.rows[0];
    if (!contact) throw new ContactNotFoundError(contactId);
    if (contact.verification_status !== "valid") throw new ContactNotVerifiedError(contactId);

    const companyRes = await pool.query<CompanyRow>(`SELECT id, name FROM companies WHERE id = $1`, [
      contact.company_id,
    ]);
    const company = companyRes.rows[0]!;

    const qualRes = await pool.query<QualificationRow>(
      `SELECT final_qualified, ai_tier, ai_reasoning, deterministic_flags FROM qualifications WHERE company_id = $1`,
      [contact.company_id],
    );
    const qualification = qualRes.rows[0];
    if (!qualification || !qualification.final_qualified) {
      throw new CompanyNotQualifiedError(contact.company_id);
    }

    const auditRes = await pool.query<AuditRow>(
      `SELECT pagespeed_mobile_score, pagespeed_desktop_score, error, crawl_signals FROM website_audits WHERE company_id = $1`,
      [contact.company_id],
    );
    const audit = auditRes.rows[0] ?? null;

    const dedupKey = computeDedupKey(contactId, stage);

    const existing = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM messages WHERE contact_id = $1 AND stage = $2`,
      [contactId, stage],
    );
    if (existing.rowCount && existing.rowCount > 0 && existing.rows[0]!.status === "sent") {
      // Never rewrite the content of a message that has already gone out.
      logger.info({ contactId, stage }, "Message already sent; personalization is a no-op");
      return {
        messageId: existing.rows[0]!.id,
        contactId,
        stage,
        status: "sent",
        regenerated: false,
      };
    }

    const facts: PersonalizationFacts = {
      companyName: company.name,
      contactFirstName: contact.first_name,
      contactTitle: contact.title,
      qualificationTier: qualification.ai_tier ?? qualification.deterministic_flags?.reason ?? "unknown",
      qualificationReasoning: qualification.ai_reasoning,
      pagespeedMobileScore: audit?.pagespeed_mobile_score ?? null,
      pagespeedDesktopScore: audit?.pagespeed_desktop_score ?? null,
      hasContactForm: audit?.crawl_signals?.hasContactForm ?? null,
      wordCount: audit?.crawl_signals?.wordCount ?? null,
      cmsGuess: audit?.crawl_signals?.cmsGuess ?? null,
      websitePresent: audit?.error !== "no_website",
      senderName: SENDER_NAME,
      senderCompany: SENDER_COMPANY,
    };

    const generated = await this.aiClient.generate(facts);

    const upserted = await pool.query<{ id: string }>(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, subject, body, personalization_data, ai_model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'openai','queued')
       ON CONFLICT (dedup_key) DO UPDATE SET
         subject = EXCLUDED.subject,
         body = EXCLUDED.body,
         personalization_data = EXCLUDED.personalization_data,
         status = CASE WHEN messages.status = 'sent' THEN messages.status ELSE 'queued' END,
         updated_at = now()
       RETURNING id`,
      [contactId, contact.company_id, stage, dedupKey, generated.subject, generated.body, JSON.stringify(facts)],
    );
    const messageId = upserted.rows[0]!.id;

    await transitionEntityStage("contact", contactId, "personalize", "personalized", { stage, messageId });

    return { messageId, contactId, stage, status: "queued", regenerated: true };
  }
}

export async function getContactsPendingPersonalization(
  limit = 20,
): Promise<Array<{ id: string; fullName: string | null }>> {
  const res = await pool.query<{ id: string; full_name: string | null }>(
    `SELECT c.id, c.full_name
     FROM contacts c
     JOIN qualifications q ON q.company_id = c.company_id
     LEFT JOIN messages m ON m.contact_id = c.id AND m.stage = 'initial'
     WHERE c.verification_status = 'valid' AND q.final_qualified = true AND m.id IS NULL
     ORDER BY c.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}
