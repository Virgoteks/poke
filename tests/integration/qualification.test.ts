import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import {
  AuditRequiredError,
  CompanyNotFoundError,
  QualificationService,
} from "../../src/domain/qualification/qualificationService.js";
import type { QualificationAiClient, QualificationAiResult, QualificationFacts } from "../../src/integrations/openai/types.js";
import { truncateAll } from "../helpers/db.js";

class FakeAiClient implements QualificationAiClient {
  public callCount = 0;
  public lastFacts: QualificationFacts | null = null;
  constructor(private readonly result: QualificationAiResult) {}
  async classify(facts: QualificationFacts): Promise<QualificationAiResult> {
    this.callCount++;
    this.lastFacts = facts;
    return this.result;
  }
}

async function insertCompany(overrides: Partial<{ website: string | null; businessStatus: string }> = {}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name, website, business_status, pipeline_stage)
     VALUES ($1, 'Test Co', $2, $3, 'audited') RETURNING id`,
    [`place-${Math.random()}`, overrides.website ?? "https://example.com", overrides.businessStatus ?? "OPERATIONAL"],
  );
  return res.rows[0]!.id;
}

async function insertAudit(companyId: string, overrides: Partial<{
  status: "completed" | "failed";
  error: string | null;
  pagespeedMobileScore: number | null;
  pagespeedDesktopScore: number | null;
  crawlSignals: unknown;
}> = {}): Promise<void> {
  await pool.query(
    `INSERT INTO website_audits (company_id, url, status, error, pagespeed_mobile_score, pagespeed_desktop_score, crawl_signals, crawled_at)
     VALUES ($1, 'https://example.com', $2, $3, $4, $5, $6, now())`,
    [
      companyId,
      overrides.status ?? "completed",
      overrides.error ?? null,
      overrides.pagespeedMobileScore ?? 60,
      overrides.pagespeedDesktopScore ?? 65,
      JSON.stringify(overrides.crawlSignals ?? { wordCount: 300, hasContactForm: true, hasMobileViewportMeta: true, cmsGuess: "wordpress" }),
    ],
  );
}

describe("QualificationService.qualifyCompany", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws CompanyNotFoundError for an unknown company", async () => {
    const service = new QualificationService(new FakeAiClient({ qualified: true, tier: "hot", reasoning: "x", confidence: 0.9 }));
    await expect(service.qualifyCompany("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      CompanyNotFoundError,
    );
  });

  it("throws AuditRequiredError when no audit has been run yet", async () => {
    const companyId = await insertCompany();
    const service = new QualificationService(new FakeAiClient({ qualified: true, tier: "hot", reasoning: "x", confidence: 0.9 }));
    await expect(service.qualifyCompany(companyId)).rejects.toBeInstanceOf(AuditRequiredError);
  });

  it("qualifies via rules only (no AI call) when the site has no website", async () => {
    const companyId = await insertCompany({ website: null });
    await insertAudit(companyId, { status: "failed", error: "no_website", pagespeedMobileScore: null, pagespeedDesktopScore: null });
    const ai = new FakeAiClient({ qualified: false, tier: "cold", reasoning: "should not be used", confidence: 0.1 });
    const service = new QualificationService(ai);

    const result = await service.qualifyCompany(companyId);

    expect(result.decidedBy).toBe("rules_only");
    expect(result.finalQualified).toBe(true);
    expect(result.tier).toBe("hot");
    expect(ai.callCount).toBe(0);

    const row = await pool.query("SELECT * FROM qualifications WHERE company_id = $1", [companyId]);
    expect(row.rows[0].decided_by).toBe("rules_only");
    expect(row.rows[0].deterministic_passed).toBe(true);
    expect(row.rows[0].ai_qualified).toBeNull();

    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("qualified");
  });

  it("disqualifies via rules only when the site already performs excellently", async () => {
    const companyId = await insertCompany();
    await insertAudit(companyId, { pagespeedMobileScore: 95, pagespeedDesktopScore: 93 });
    const ai = new FakeAiClient({ qualified: true, tier: "hot", reasoning: "should not be used", confidence: 0.9 });
    const service = new QualificationService(ai);

    const result = await service.qualifyCompany(companyId);
    expect(result.decidedBy).toBe("rules_only");
    expect(result.finalQualified).toBe(false);
    expect(ai.callCount).toBe(0);

    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("disqualified");
  });

  it("defers to AI for inconclusive scores and persists the AI's structured result", async () => {
    const companyId = await insertCompany();
    await insertAudit(companyId, { pagespeedMobileScore: 60, pagespeedDesktopScore: 65 });
    const ai = new FakeAiClient({ qualified: true, tier: "warm", reasoning: "PageSpeed mobile score is 60", confidence: 0.7 });
    const service = new QualificationService(ai);

    const result = await service.qualifyCompany(companyId);

    expect(result.decidedBy).toBe("rules_and_ai");
    expect(result.tier).toBe("warm");
    expect(ai.callCount).toBe(1);
    expect(ai.lastFacts?.pagespeedMobileScore).toBe(60);

    const row = await pool.query("SELECT * FROM qualifications WHERE company_id = $1", [companyId]);
    expect(row.rows[0].deterministic_passed).toBeNull();
    expect(row.rows[0].ai_tier).toBe("warm");
    expect(row.rows[0].ai_reasoning).toBe("PageSpeed mobile score is 60");
    expect(row.rows[0].ai_model).toBe("openai");
  });

  it("never sends fabricated facts to the AI client -- only fields sourced from company/audit rows", async () => {
    const companyId = await insertCompany();
    await insertAudit(companyId, {
      pagespeedMobileScore: 55,
      pagespeedDesktopScore: 58,
      crawlSignals: { wordCount: 120, hasContactForm: false, hasMobileViewportMeta: false, cmsGuess: null },
    });
    const ai = new FakeAiClient({ qualified: true, tier: "warm", reasoning: "ok", confidence: 0.5 });
    const service = new QualificationService(ai);
    await service.qualifyCompany(companyId);

    expect(ai.lastFacts).toEqual({
      companyName: "Test Co",
      categories: [],
      googleRating: null,
      googleRatingCount: null,
      websitePresent: true,
      auditStatus: "completed",
      auditError: null,
      pagespeedMobileScore: 55,
      pagespeedDesktopScore: 58,
      wordCount: 120,
      hasContactForm: false,
      hasMobileViewportMeta: false,
      cmsGuess: null,
    });
  });

  it("is idempotent: re-qualifying does not duplicate rows or state transitions when the outcome is unchanged", async () => {
    const companyId = await insertCompany({ website: null });
    await insertAudit(companyId, { status: "failed", error: "no_website" });
    const service = new QualificationService(new FakeAiClient({ qualified: true, tier: "hot", reasoning: "x", confidence: 0.9 }));

    await service.qualifyCompany(companyId);
    await service.qualifyCompany(companyId);

    const rows = await pool.query("SELECT count(*) FROM qualifications WHERE company_id = $1", [companyId]);
    expect(Number(rows.rows[0].count)).toBe(1);

    const transitions = await pool.query(
      `SELECT count(*) FROM state_transitions WHERE entity_type = 'company' AND entity_id = $1 AND stage = 'qualify'`,
      [companyId],
    );
    expect(Number(transitions.rows[0].count)).toBe(1);
  });
});
