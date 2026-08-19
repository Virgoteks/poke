import { pool } from "../../db/pool.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logger } from "../../logging/logger.js";
import { createWebsiteCrawler, type WebsiteCrawler } from "../../integrations/websiteCrawler/index.js";
import { createPageSpeedClient, type PageSpeedClient } from "../../integrations/pageSpeed/index.js";

export class CompanyNotFoundError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = "CompanyNotFoundError";
  }
}

export interface AuditOutcome {
  companyId: string;
  status: "completed" | "failed";
  pipelineStage: string;
  pagespeedMobileScore: number | null;
  pagespeedDesktopScore: number | null;
  error: string | null;
}

interface CompanyRow {
  id: string;
  website: string | null;
  pipeline_stage: string;
}

async function upsertAuditRow(params: {
  companyId: string;
  url: string | null;
  status: "completed" | "failed";
  pagespeedMobileScore: number | null;
  pagespeedDesktopScore: number | null;
  coreWebVitals: unknown;
  pagesCrawled: unknown;
  crawlSignals: unknown;
  rawPagespeedResponse: unknown;
  error: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO website_audits (
       company_id, url, status, pagespeed_mobile_score, pagespeed_desktop_score,
       core_web_vitals, pages_crawled, crawl_signals, raw_pagespeed_response, error, crawled_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (company_id) DO UPDATE SET
       url = EXCLUDED.url,
       status = EXCLUDED.status,
       pagespeed_mobile_score = EXCLUDED.pagespeed_mobile_score,
       pagespeed_desktop_score = EXCLUDED.pagespeed_desktop_score,
       core_web_vitals = EXCLUDED.core_web_vitals,
       pages_crawled = EXCLUDED.pages_crawled,
       crawl_signals = EXCLUDED.crawl_signals,
       raw_pagespeed_response = EXCLUDED.raw_pagespeed_response,
       error = EXCLUDED.error,
       crawled_at = now(),
       updated_at = now()`,
    [
      params.companyId,
      params.url,
      params.status,
      params.pagespeedMobileScore,
      params.pagespeedDesktopScore,
      JSON.stringify(params.coreWebVitals ?? null),
      JSON.stringify(params.pagesCrawled ?? null),
      JSON.stringify(params.crawlSignals ?? null),
      JSON.stringify(params.rawPagespeedResponse ?? null),
      params.error,
    ],
  );
}

export class AuditService {
  constructor(
    private readonly crawler: WebsiteCrawler = createWebsiteCrawler(),
    private readonly pageSpeedClient: PageSpeedClient = createPageSpeedClient(),
  ) {}

  async auditCompany(companyId: string): Promise<AuditOutcome> {
    const companyRes = await pool.query<CompanyRow>(
      `SELECT id, website, pipeline_stage FROM companies WHERE id = $1`,
      [companyId],
    );
    const company = companyRes.rows[0];
    if (!company) throw new CompanyNotFoundError(companyId);

    if (!company.website) {
      await upsertAuditRow({
        companyId,
        url: null,
        status: "failed",
        pagespeedMobileScore: null,
        pagespeedDesktopScore: null,
        coreWebVitals: null,
        pagesCrawled: null,
        crawlSignals: null,
        rawPagespeedResponse: null,
        error: "no_website",
      });
      await transitionEntityStage("company", companyId, "audit", "audit_failed", {
        reason: "no_website",
      });
      return {
        companyId,
        status: "failed",
        pipelineStage: "audit_failed",
        pagespeedMobileScore: null,
        pagespeedDesktopScore: null,
        error: "no_website",
      };
    }

    const crawlResult = await this.crawler.crawl(company.website);

    if (!crawlResult.ok) {
      await upsertAuditRow({
        companyId,
        url: company.website,
        status: "failed",
        pagespeedMobileScore: null,
        pagespeedDesktopScore: null,
        coreWebVitals: null,
        pagesCrawled: null,
        crawlSignals: null,
        rawPagespeedResponse: null,
        error: crawlResult.error,
      });
      await transitionEntityStage("company", companyId, "audit", "audit_failed", {
        reason: "crawl_failed",
        error: crawlResult.error,
      });
      return {
        companyId,
        status: "failed",
        pipelineStage: "audit_failed",
        pagespeedMobileScore: null,
        pagespeedDesktopScore: null,
        error: crawlResult.error,
      };
    }

    const [mobile, desktop] = await Promise.allSettled([
      this.pageSpeedClient.analyze(company.website, "mobile"),
      this.pageSpeedClient.analyze(company.website, "desktop"),
    ]);

    const mobileValue = mobile.status === "fulfilled" ? mobile.value : null;
    const desktopValue = desktop.status === "fulfilled" ? desktop.value : null;
    const mobileError = mobile.status === "rejected" ? String(mobile.reason) : null;
    const desktopError = desktop.status === "rejected" ? String(desktop.reason) : null;

    if (mobileError) logger.warn({ companyId, error: mobileError }, "PageSpeed mobile analysis failed");
    if (desktopError) logger.warn({ companyId, error: desktopError }, "PageSpeed desktop analysis failed");

    const pagespeedError =
      mobileError && desktopError ? `mobile: ${mobileError}; desktop: ${desktopError}` : null;

    await upsertAuditRow({
      companyId,
      url: company.website,
      status: "completed",
      pagespeedMobileScore: mobileValue?.performanceScore ?? null,
      pagespeedDesktopScore: desktopValue?.performanceScore ?? null,
      coreWebVitals: { mobile: mobileValue?.coreWebVitals ?? null, desktop: desktopValue?.coreWebVitals ?? null },
      pagesCrawled: crawlResult.signals?.pagesCrawled ?? null,
      crawlSignals: crawlResult.signals,
      rawPagespeedResponse: { mobile: mobileValue?.raw ?? null, desktop: desktopValue?.raw ?? null, mobileError, desktopError },
      error: pagespeedError,
    });

    await transitionEntityStage("company", companyId, "audit", "audited", {
      pagespeedMobileScore: mobileValue?.performanceScore ?? null,
      pagespeedDesktopScore: desktopValue?.performanceScore ?? null,
    });

    return {
      companyId,
      status: "completed",
      pipelineStage: "audited",
      pagespeedMobileScore: mobileValue?.performanceScore ?? null,
      pagespeedDesktopScore: desktopValue?.performanceScore ?? null,
      error: pagespeedError,
    };
  }
}

export async function getCompaniesPendingAudit(limit = 20): Promise<Array<{ id: string; name: string; website: string | null }>> {
  const res = await pool.query<{ id: string; name: string; website: string | null }>(
    `SELECT id, name, website FROM companies WHERE pipeline_stage = 'discovered' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return res.rows;
}
