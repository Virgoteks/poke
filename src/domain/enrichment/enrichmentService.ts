import { pool, withTransaction } from "../../db/pool.js";
import { normalizeEmail } from "../../lib/normalize.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logStateTransition } from "../../lib/stateLog.js";
import { logger } from "../../logging/logger.js";
import { createApolloClient, type ApolloClient, type ApolloPersonSummary } from "../../integrations/apollo/index.js";
import { isDecisionMakerTitle } from "./decisionMakerRules.js";

export class CompanyNotFoundError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = "CompanyNotFoundError";
  }
}

export class QualificationRequiredError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} has not been qualified yet; run QUALIFY before ENRICH`);
    this.name = "QualificationRequiredError";
  }
}

export class CompanyNotQualifiedError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} was disqualified; refusing to spend enrichment credits on it`);
    this.name = "CompanyNotQualifiedError";
  }
}

interface CompanyRow {
  id: string;
  name: string;
  normalized_domain: string | null;
}

const UNIQUE_VIOLATION = "23505";

interface UpsertedContact {
  id: string;
  isDecisionMaker: boolean;
  hasEmail: boolean;
  outcome: "created" | "updated" | "merged_by_email";
}

async function upsertContact(
  companyId: string,
  person: ApolloPersonSummary,
  email: string | null,
  isDecisionMaker: boolean,
): Promise<UpsertedContact> {
  const normalizedEmail = normalizeEmail(email);

  const existingByApolloId = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE apollo_person_id = $1`,
    [person.apolloPersonId],
  );
  if (existingByApolloId.rowCount && existingByApolloId.rowCount > 0) {
    const id = existingByApolloId.rows[0]!.id;
    await pool.query(
      `UPDATE contacts SET
         full_name = $2, first_name = $3, last_name = $4, title = $5,
         email = COALESCE($6, email), email_normalized = COALESCE($7, email_normalized),
         phone = $8, linkedin_url = $9, is_decision_maker = $10, updated_at = now()
       WHERE id = $1`,
      [
        id,
        person.fullName,
        person.firstName,
        person.lastName,
        person.title,
        email,
        normalizedEmail,
        person.phone,
        person.linkedinUrl,
        isDecisionMaker,
      ],
    );
    return { id, isDecisionMaker, hasEmail: Boolean(normalizedEmail), outcome: "updated" };
  }

  if (normalizedEmail) {
    const existingByEmail = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE company_id = $1 AND email_normalized = $2`,
      [companyId, normalizedEmail],
    );
    if (existingByEmail.rowCount && existingByEmail.rowCount > 0) {
      const id = existingByEmail.rows[0]!.id;
      logger.info(
        { companyId, apolloPersonId: person.apolloPersonId, contactId: id },
        "Apollo person matches an existing contact by email; treating as duplicate, not inserting",
      );
      return { id, isDecisionMaker, hasEmail: true, outcome: "merged_by_email" };
    }
  }

  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO contacts (
           company_id, apollo_person_id, full_name, first_name, last_name, title,
           email, email_normalized, phone, linkedin_url, is_decision_maker, source, pipeline_stage
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'apollo','discovered')
         RETURNING id`,
        [
          companyId,
          person.apolloPersonId,
          person.fullName,
          person.firstName,
          person.lastName,
          person.title,
          email,
          normalizedEmail,
          person.phone,
          person.linkedinUrl,
          isDecisionMaker,
        ],
      );
      const id = inserted.rows[0]!.id;
      await logStateTransition(
        {
          entityType: "contact",
          entityId: id,
          stage: "find_decision_maker",
          fromState: null,
          toState: "discovered",
          actor: "system",
          metadata: { apolloPersonId: person.apolloPersonId, isDecisionMaker },
        },
        client,
      );
      return { id, isDecisionMaker, hasEmail: Boolean(normalizedEmail), outcome: "created" as const };
    });
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      const fallback = await pool.query<{ id: string }>(
        `SELECT id FROM contacts WHERE apollo_person_id = $1 OR (company_id = $2 AND email_normalized = $3) LIMIT 1`,
        [person.apolloPersonId, companyId, normalizedEmail],
      );
      if (fallback.rowCount && fallback.rowCount > 0) {
        return {
          id: fallback.rows[0]!.id,
          isDecisionMaker,
          hasEmail: Boolean(normalizedEmail),
          outcome: "merged_by_email",
        };
      }
    }
    throw err;
  }
}

export interface EnrichmentOutcome {
  companyId: string;
  contactsFound: number;
  decisionMakersFound: number;
  contactIds: string[];
}

export class EnrichmentService {
  constructor(private readonly apolloClient: ApolloClient = createApolloClient()) {}

  async enrichCompany(companyId: string): Promise<EnrichmentOutcome> {
    const companyRes = await pool.query<CompanyRow>(
      `SELECT id, name, normalized_domain FROM companies WHERE id = $1`,
      [companyId],
    );
    const company = companyRes.rows[0];
    if (!company) throw new CompanyNotFoundError(companyId);

    const qualRes = await pool.query<{ final_qualified: boolean }>(
      `SELECT final_qualified FROM qualifications WHERE company_id = $1`,
      [companyId],
    );
    const qualification = qualRes.rows[0];
    if (!qualification) throw new QualificationRequiredError(companyId);
    if (!qualification.final_qualified) throw new CompanyNotQualifiedError(companyId);

    const people = await this.apolloClient.searchPeople(company.normalized_domain ?? "", company.name);

    if (people.length === 0) {
      await transitionEntityStage("company", companyId, "find_decision_maker", "no_contacts_found", {
        contactsFound: 0,
      });
      return { companyId, contactsFound: 0, decisionMakersFound: 0, contactIds: [] };
    }

    const results: UpsertedContact[] = [];
    for (const person of people) {
      const isDecisionMaker = isDecisionMakerTitle(person.title, person.seniority);

      let email: string | null = null;
      if (isDecisionMaker) {
        // Only spend an Apollo credit revealing an email for someone the
        // deterministic rule already identified as a decision maker.
        try {
          const matched = await this.apolloClient.matchPerson(person.apolloPersonId);
          email = matched.email;
        } catch (err) {
          logger.warn(
            { companyId, apolloPersonId: person.apolloPersonId, err },
            "Apollo matchPerson (email reveal) failed; continuing without an email for this contact",
          );
        }
      }

      const upserted = await upsertContact(companyId, person, email, isDecisionMaker);
      results.push(upserted);
    }

    const decisionMakersFound = results.filter((r) => r.isDecisionMaker).length;

    await transitionEntityStage(
      "company",
      companyId,
      "find_decision_maker",
      decisionMakersFound > 0 ? "enriched" : "no_decision_maker_found",
      { contactsFound: results.length, decisionMakersFound },
    );

    return {
      companyId,
      contactsFound: results.length,
      decisionMakersFound,
      contactIds: results.map((r) => r.id),
    };
  }
}

export async function getCompaniesPendingEnrichment(limit = 20): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name
     FROM companies c
     JOIN qualifications q ON q.company_id = c.id
     WHERE q.final_qualified = true AND c.pipeline_stage IN ('qualified')
     ORDER BY c.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}
