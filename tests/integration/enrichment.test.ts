import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import {
  CompanyNotFoundError,
  CompanyNotQualifiedError,
  EnrichmentService,
  QualificationRequiredError,
} from "../../src/domain/enrichment/enrichmentService.js";
import type { ApolloClient, ApolloPersonSummary } from "../../src/integrations/apollo/types.js";
import { truncateAll } from "../helpers/db.js";

class FakeApolloClient implements ApolloClient {
  public matchCalls: string[] = [];
  constructor(
    private readonly people: ApolloPersonSummary[],
    private readonly emailsByPersonId: Record<string, string | null> = {},
  ) {}
  async searchPeople(): Promise<ApolloPersonSummary[]> {
    return this.people;
  }
  async matchPerson(apolloPersonId: string): Promise<{ email: string | null }> {
    this.matchCalls.push(apolloPersonId);
    return { email: this.emailsByPersonId[apolloPersonId] ?? null };
  }
}

function person(overrides: Partial<ApolloPersonSummary> = {}): ApolloPersonSummary {
  return {
    apolloPersonId: "person-1",
    fullName: "Alex Owner",
    firstName: "Alex",
    lastName: "Owner",
    title: "Owner",
    linkedinUrl: null,
    phone: null,
    seniority: null,
    emailLocked: true,
    ...overrides,
  };
}

async function insertQualifiedCompany(finalQualified = true): Promise<string> {
  const company = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name, normalized_domain, pipeline_stage)
     VALUES ($1, 'Enrich Me Co', 'enrich-me.com', 'qualified') RETURNING id`,
    [`place-${Math.random()}`],
  );
  const companyId = company.rows[0]!.id;
  await pool.query(
    `INSERT INTO qualifications (company_id, deterministic_passed, decided_by, final_qualified)
     VALUES ($1, $2, 'rules_only', $2)`,
    [companyId, finalQualified],
  );
  return companyId;
}

describe("EnrichmentService.enrichCompany", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws CompanyNotFoundError for an unknown company", async () => {
    const service = new EnrichmentService(new FakeApolloClient([]));
    await expect(service.enrichCompany("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      CompanyNotFoundError,
    );
  });

  it("throws QualificationRequiredError when QUALIFY has not run", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-e1', 'Co', 'audited') RETURNING id`,
    );
    const service = new EnrichmentService(new FakeApolloClient([]));
    await expect(service.enrichCompany(company.rows[0]!.id)).rejects.toBeInstanceOf(QualificationRequiredError);
  });

  it("throws CompanyNotQualifiedError for a disqualified company", async () => {
    const companyId = await insertQualifiedCompany(false);
    const service = new EnrichmentService(new FakeApolloClient([]));
    await expect(service.enrichCompany(companyId)).rejects.toBeInstanceOf(CompanyNotQualifiedError);
  });

  it("marks no_contacts_found when Apollo returns nobody", async () => {
    const companyId = await insertQualifiedCompany();
    const service = new EnrichmentService(new FakeApolloClient([]));
    const result = await service.enrichCompany(companyId);

    expect(result.contactsFound).toBe(0);
    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("no_contacts_found");
  });

  it("reveals an email only for decision makers, and creates contacts for everyone found", async () => {
    const companyId = await insertQualifiedCompany();
    const owner = person({ apolloPersonId: "p-owner", title: "Owner" });
    const officeManager = person({
      apolloPersonId: "p-office-mgr",
      title: "Office Manager",
      fullName: "Sam Manager",
    });
    const apollo = new FakeApolloClient([owner, officeManager], { "p-owner": "alex@enrich-me.com" });
    const service = new EnrichmentService(apollo);

    const result = await service.enrichCompany(companyId);

    expect(result.contactsFound).toBe(2);
    expect(result.decisionMakersFound).toBe(1);
    expect(apollo.matchCalls).toEqual(["p-owner"]); // never revealed email for the non-decision-maker

    const contacts = await pool.query("SELECT * FROM contacts WHERE company_id = $1 ORDER BY title", [companyId]);
    expect(contacts.rowCount).toBe(2);
    const ownerRow = contacts.rows.find((r) => r.apollo_person_id === "p-owner");
    const officeMgrRow = contacts.rows.find((r) => r.apollo_person_id === "p-office-mgr");
    expect(ownerRow.is_decision_maker).toBe(true);
    expect(ownerRow.email_normalized).toBe("alex@enrich-me.com");
    expect(officeMgrRow.is_decision_maker).toBe(false);
    expect(officeMgrRow.email).toBeNull();

    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("enriched");
  });

  it("marks no_decision_maker_found when contacts exist but none qualify as decision makers", async () => {
    const companyId = await insertQualifiedCompany();
    const apollo = new FakeApolloClient([person({ apolloPersonId: "p-2", title: "Receptionist" })]);
    const service = new EnrichmentService(apollo);

    const result = await service.enrichCompany(companyId);
    expect(result.decisionMakersFound).toBe(0);
    expect(result.contactsFound).toBe(1);

    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("no_decision_maker_found");
  });

  it("is idempotent: re-enriching the same company does not duplicate contacts", async () => {
    const companyId = await insertQualifiedCompany();
    const apollo = new FakeApolloClient([person({ apolloPersonId: "p-3" })], { "p-3": "a@enrich-me.com" });
    const service = new EnrichmentService(apollo);

    await service.enrichCompany(companyId);
    await service.enrichCompany(companyId);

    const contacts = await pool.query("SELECT count(*) FROM contacts WHERE company_id = $1", [companyId]);
    expect(Number(contacts.rows[0].count)).toBe(1);
  });

  it("dedups two Apollo person ids that resolve to the same email at the same company", async () => {
    const companyId = await insertQualifiedCompany();
    const apollo = new FakeApolloClient(
      [person({ apolloPersonId: "p-dup-1" }), person({ apolloPersonId: "p-dup-2", fullName: "Duplicate Listing" })],
      { "p-dup-1": "same@enrich-me.com", "p-dup-2": "same@enrich-me.com" },
    );
    const service = new EnrichmentService(apollo);

    const result = await service.enrichCompany(companyId);
    expect(result.contactsFound).toBe(2); // both processed...
    const contacts = await pool.query(
      "SELECT count(*) FROM contacts WHERE company_id = $1 AND email_normalized = 'same@enrich-me.com'",
      [companyId],
    );
    expect(Number(contacts.rows[0].count)).toBe(1); // ...but only one row persisted
  });
});
