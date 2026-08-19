import { pool } from "../../db/pool.js";
import { transitionEntityStage } from "../../lib/pipelineStage.js";
import { logger } from "../../logging/logger.js";
import {
  createQualificationAiClient,
  type QualificationAiClient,
  type QualificationFacts,
  type QualificationTier,
} from "../../integrations/openai/index.js";

export class CompanyNotFoundError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} not found`);
    this.name = "CompanyNotFoundError";
  }
}

export class AuditRequiredError extends Error {
  constructor(public readonly companyId: string) {
    super(`Company ${companyId} has not been audited yet; run AUDIT before QUALIFY`);
    this.name = "AuditRequiredError";
  }
}

interface CompanyRow {
  id: string;
  name: string;
  categories: string[];
  rating: number | null;
  user_ratings_total: number | null;
  business_status: string | null;
}

interface AuditRow {
  status: "completed" | "failed";
  error: string | null;
  pagespeed_mobile_score: number | null;
  pagespeed_desktop_score: number | null;
  crawl_signals: {
    wordCount?: number;
    hasContactForm?: boolean;
    hasMobileViewportMeta?: boolean;
    cmsGuess?: string | null;
  } | null;
}

export interface DeterministicOutcome {
  /** true = rules qualify it, false = rules disqualify it, null = inconclusive, defer to AI. */
  passed: boolean | null;
  tier: QualificationTier | null;
  reason: string;
}

const HIGH_PERFORMANCE_THRESHOLD = 90;

/**
 * Requirement: "Use deterministic rules before AI." These rules only ever
 * run against structured facts already on file (never invented), and only
 * defer to AI when they are genuinely inconclusive.
 */
export function deterministicQualify(company: CompanyRow, audit: AuditRow): DeterministicOutcome {
  if (company.business_status && company.business_status !== "OPERATIONAL") {
    return { passed: false, tier: "disqualified", reason: "not_operational" };
  }

  if (audit.status === "failed" && audit.error === "no_website") {
    return { passed: true, tier: "hot", reason: "no_website" };
  }

  if (audit.status === "failed") {
    return { passed: true, tier: "hot", reason: "site_unreachable" };
  }

  if (
    audit.pagespeed_mobile_score !== null &&
    audit.pagespeed_desktop_score !== null &&
    audit.pagespeed_mobile_score >= HIGH_PERFORMANCE_THRESHOLD &&
    audit.pagespeed_desktop_score >= HIGH_PERFORMANCE_THRESHOLD
  ) {
    return { passed: false, tier: "disqualified", reason: "high_performance_site" };
  }

  return { passed: null, tier: null, reason: "inconclusive" };
}

function buildFacts(company: CompanyRow, audit: AuditRow): QualificationFacts {
  return {
    companyName: company.name,
    categories: company.categories ?? [],
    googleRating: company.rating,
    googleRatingCount: company.user_ratings_total,
    websitePresent: audit.error !== "no_website",
    auditStatus: audit.status,
    auditError: audit.error,
    pagespeedMobileScore: audit.pagespeed_mobile_score,
    pagespeedDesktopScore: audit.pagespeed_desktop_score,
    wordCount: audit.crawl_signals?.wordCount ?? null,
    hasContactForm: audit.crawl_signals?.hasContactForm ?? null,
    hasMobileViewportMeta: audit.crawl_signals?.hasMobileViewportMeta ?? null,
    cmsGuess: audit.crawl_signals?.cmsGuess ?? null,
  };
}

export interface QualificationOutcome {
  companyId: string;
  finalQualified: boolean;
  tier: QualificationTier;
  decidedBy: "rules_only" | "rules_and_ai";
  reason: string;
}

export class QualificationService {
  constructor(private readonly aiClient: QualificationAiClient = createQualificationAiClient()) {}

  async qualifyCompany(companyId: string): Promise<QualificationOutcome> {
    const companyRes = await pool.query<CompanyRow>(
      `SELECT id, name, categories, rating, user_ratings_total, business_status FROM companies WHERE id = $1`,
      [companyId],
    );
    const company = companyRes.rows[0];
    if (!company) throw new CompanyNotFoundError(companyId);

    const auditRes = await pool.query<AuditRow>(
      `SELECT status, error, pagespeed_mobile_score, pagespeed_desktop_score, crawl_signals
       FROM website_audits WHERE company_id = $1`,
      [companyId],
    );
    const audit = auditRes.rows[0];
    if (!audit) throw new AuditRequiredError(companyId);

    const deterministic = deterministicQualify(company, audit);

    if (deterministic.passed !== null) {
      await pool.query(
        `INSERT INTO qualifications (
           company_id, deterministic_passed, deterministic_flags, ai_qualified, ai_tier,
           ai_reasoning, ai_model, ai_response_raw, decided_by, final_qualified
         ) VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,NULL,'rules_only',$4)
         ON CONFLICT (company_id) DO UPDATE SET
           deterministic_passed = EXCLUDED.deterministic_passed,
           deterministic_flags = EXCLUDED.deterministic_flags,
           ai_qualified = NULL, ai_tier = NULL, ai_reasoning = NULL, ai_model = NULL, ai_response_raw = NULL,
           decided_by = 'rules_only',
           final_qualified = EXCLUDED.final_qualified,
           updated_at = now()`,
        [companyId, deterministic.passed, JSON.stringify({ reason: deterministic.reason }), deterministic.passed],
      );

      await transitionEntityStage(
        "company",
        companyId,
        "qualify",
        deterministic.passed ? "qualified" : "disqualified",
        { decidedBy: "rules_only", tier: deterministic.tier, reason: deterministic.reason },
      );

      return {
        companyId,
        finalQualified: deterministic.passed,
        tier: deterministic.tier!,
        decidedBy: "rules_only",
        reason: deterministic.reason,
      };
    }

    const facts = buildFacts(company, audit);
    const ai = await this.aiClient.classify(facts);
    logger.info({ companyId, tier: ai.tier, qualified: ai.qualified }, "AI qualification decision");

    await pool.query(
      `INSERT INTO qualifications (
         company_id, deterministic_passed, deterministic_flags, ai_qualified, ai_tier,
         ai_reasoning, ai_model, ai_response_raw, decided_by, final_qualified
       ) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,'rules_and_ai',$8)
       ON CONFLICT (company_id) DO UPDATE SET
         deterministic_passed = NULL,
         deterministic_flags = EXCLUDED.deterministic_flags,
         ai_qualified = EXCLUDED.ai_qualified,
         ai_tier = EXCLUDED.ai_tier,
         ai_reasoning = EXCLUDED.ai_reasoning,
         ai_model = EXCLUDED.ai_model,
         ai_response_raw = EXCLUDED.ai_response_raw,
         decided_by = 'rules_and_ai',
         final_qualified = EXCLUDED.final_qualified,
         updated_at = now()`,
      [
        companyId,
        JSON.stringify({ reason: "inconclusive" }),
        ai.qualified,
        ai.tier,
        ai.reasoning,
        "openai",
        JSON.stringify(ai),
        ai.qualified,
      ],
    );

    await transitionEntityStage("company", companyId, "qualify", ai.qualified ? "qualified" : "disqualified", {
      decidedBy: "rules_and_ai",
      tier: ai.tier,
      confidence: ai.confidence,
    });

    return {
      companyId,
      finalQualified: ai.qualified,
      tier: ai.tier,
      decidedBy: "rules_and_ai",
      reason: "ai_classified",
    };
  }
}

export async function getCompaniesPendingQualification(
  limit = 20,
): Promise<Array<{ id: string; name: string }>> {
  const res = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name
     FROM companies c
     JOIN website_audits wa ON wa.company_id = c.id
     WHERE c.pipeline_stage IN ('audited', 'audit_failed')
     ORDER BY c.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows;
}
