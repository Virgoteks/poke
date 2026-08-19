import { describe, expect, it } from "vitest";
import { deterministicQualify } from "../../src/domain/qualification/qualificationService.js";

const baseCompany = {
  id: "c1",
  name: "Acme",
  categories: ["plumber"],
  rating: 4.2,
  user_ratings_total: 30,
  business_status: "OPERATIONAL",
};

const baseAudit = {
  status: "completed" as const,
  error: null,
  pagespeed_mobile_score: 60,
  pagespeed_desktop_score: 70,
  crawl_signals: null,
};

describe("deterministicQualify", () => {
  it("disqualifies non-operational businesses regardless of website quality", () => {
    const result = deterministicQualify(
      { ...baseCompany, business_status: "CLOSED_PERMANENTLY" },
      { ...baseAudit, pagespeed_mobile_score: 20, pagespeed_desktop_score: 20 },
    );
    expect(result).toEqual({ passed: false, tier: "disqualified", reason: "not_operational" });
  });

  it("qualifies (hot) a business with no website", () => {
    const result = deterministicQualify(baseCompany, { ...baseAudit, status: "failed", error: "no_website" });
    expect(result).toEqual({ passed: true, tier: "hot", reason: "no_website" });
  });

  it("qualifies (hot) a business whose site could not be crawled", () => {
    const result = deterministicQualify(baseCompany, {
      ...baseAudit,
      status: "failed",
      error: "connection refused",
    });
    expect(result).toEqual({ passed: true, tier: "hot", reason: "site_unreachable" });
  });

  it("disqualifies a business with an already-excellent site on both mobile and desktop", () => {
    const result = deterministicQualify(baseCompany, {
      ...baseAudit,
      pagespeed_mobile_score: 95,
      pagespeed_desktop_score: 92,
    });
    expect(result).toEqual({ passed: false, tier: "disqualified", reason: "high_performance_site" });
  });

  it("does not disqualify on a high score for only one strategy", () => {
    const result = deterministicQualify(baseCompany, {
      ...baseAudit,
      pagespeed_mobile_score: 95,
      pagespeed_desktop_score: 60,
    });
    expect(result.passed).toBeNull();
  });

  it("defers to AI (passed: null) for mediocre, unremarkable scores", () => {
    const result = deterministicQualify(baseCompany, baseAudit);
    expect(result.passed).toBeNull();
    expect(result.reason).toBe("inconclusive");
  });
});
