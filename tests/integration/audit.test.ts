import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { AuditService, CompanyNotFoundError } from "../../src/domain/audit/auditService.js";
import type { CrawlResult, WebsiteCrawler } from "../../src/integrations/websiteCrawler/types.js";
import type { PageSpeedClient, PageSpeedResult } from "../../src/integrations/pageSpeed/types.js";
import { truncateAll } from "../helpers/db.js";

class FixedCrawler implements WebsiteCrawler {
  constructor(private readonly result: CrawlResult) {}
  async crawl(): Promise<CrawlResult> {
    return this.result;
  }
}

class FixedPageSpeed implements PageSpeedClient {
  constructor(
    private readonly mobile: PageSpeedResult | Error,
    private readonly desktop: PageSpeedResult | Error = { performanceScore: 80, coreWebVitals: {
      largestContentfulPaintMs: 1000, cumulativeLayoutShift: 0.05, totalBlockingTimeMs: 50, timeToFirstByteMs: 100,
    }, raw: {} },
  ) {}
  async analyze(_url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult> {
    const value = strategy === "mobile" ? this.mobile : this.desktop;
    if (value instanceof Error) throw value;
    return value;
  }
}

const successfulCrawl: CrawlResult = {
  ok: true,
  error: null,
  signals: {
    finalUrl: "https://example.com",
    httpStatus: 200,
    hasSsl: true,
    title: "Example",
    metaDescription: "desc",
    hasContactForm: true,
    hasPhoneNumberOnPage: true,
    hasMobileViewportMeta: true,
    wordCount: 500,
    cmsGuess: "wordpress",
    pagesCrawled: ["https://example.com"],
  },
};

const okPageSpeed: PageSpeedResult = {
  performanceScore: 65,
  coreWebVitals: { largestContentfulPaintMs: 2000, cumulativeLayoutShift: 0.1, totalBlockingTimeMs: 200, timeToFirstByteMs: 300 },
  raw: {},
};

async function insertCompany(website: string | null): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO companies (google_place_id, name, website, pipeline_stage) VALUES ($1, 'Test Co', $2, 'discovered') RETURNING id`,
    [`place-${Math.random()}`, website],
  );
  return res.rows[0]!.id;
}

describe("AuditService.auditCompany", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("throws CompanyNotFoundError for an unknown company id", async () => {
    const service = new AuditService(new FixedCrawler(successfulCrawl), new FixedPageSpeed(okPageSpeed));
    await expect(service.auditCompany("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      CompanyNotFoundError,
    );
  });

  it("marks a company with no website as audit_failed without crawling", async () => {
    const companyId = await insertCompany(null);
    const service = new AuditService(new FixedCrawler(successfulCrawl), new FixedPageSpeed(okPageSpeed));
    const result = await service.auditCompany(companyId);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("no_website");
    expect(result.pipelineStage).toBe("audit_failed");

    const audit = await pool.query("SELECT * FROM website_audits WHERE company_id = $1", [companyId]);
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].status).toBe("failed");
    expect(audit.rows[0].error).toBe("no_website");

    const company = await pool.query("SELECT pipeline_stage FROM companies WHERE id = $1", [companyId]);
    expect(company.rows[0].pipeline_stage).toBe("audit_failed");
  });

  it("marks a company as audit_failed when the crawl fails", async () => {
    const companyId = await insertCompany("https://down.example.com");
    const service = new AuditService(
      new FixedCrawler({ ok: false, signals: null, error: "connection refused" }),
      new FixedPageSpeed(okPageSpeed),
    );
    const result = await service.auditCompany(companyId);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("connection refused");
    const audit = await pool.query("SELECT * FROM website_audits WHERE company_id = $1", [companyId]);
    expect(audit.rows[0].status).toBe("failed");
  });

  it("completes successfully and stores pagespeed scores + crawl signals when everything succeeds", async () => {
    const companyId = await insertCompany("https://good.example.com");
    const service = new AuditService(new FixedCrawler(successfulCrawl), new FixedPageSpeed(okPageSpeed));
    const result = await service.auditCompany(companyId);

    expect(result.status).toBe("completed");
    expect(result.pipelineStage).toBe("audited");
    expect(result.pagespeedMobileScore).toBe(65);
    expect(result.pagespeedDesktopScore).toBe(80);

    const audit = await pool.query("SELECT * FROM website_audits WHERE company_id = $1", [companyId]);
    expect(audit.rows[0].status).toBe("completed");
    expect(audit.rows[0].crawl_signals.cmsGuess).toBe("wordpress");

    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'company' AND entity_id = $1 AND stage = 'audit'`,
      [companyId],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("audited");
  });

  it("still completes (using crawl data) when PageSpeed fails on both strategies, and records the error", async () => {
    const companyId = await insertCompany("https://good.example.com");
    const service = new AuditService(
      new FixedCrawler(successfulCrawl),
      new FixedPageSpeed(new Error("psi down"), new Error("psi down")),
    );
    const result = await service.auditCompany(companyId);

    expect(result.status).toBe("completed");
    expect(result.pagespeedMobileScore).toBeNull();
    expect(result.pagespeedDesktopScore).toBeNull();
    expect(result.error).toContain("psi down");
  });

  it("is idempotent: re-auditing the same company updates the single audit row and does not duplicate state transitions", async () => {
    const companyId = await insertCompany("https://good.example.com");
    const service = new AuditService(new FixedCrawler(successfulCrawl), new FixedPageSpeed(okPageSpeed));

    await service.auditCompany(companyId);
    await service.auditCompany(companyId);

    const audits = await pool.query("SELECT count(*) FROM website_audits WHERE company_id = $1", [companyId]);
    expect(Number(audits.rows[0].count)).toBe(1);

    const transitions = await pool.query(
      `SELECT count(*) FROM state_transitions WHERE entity_type = 'company' AND entity_id = $1 AND stage = 'audit'`,
      [companyId],
    );
    expect(Number(transitions.rows[0].count)).toBe(1); // second run is already 'audited' -> no-op transition
  });
});
