import type { CrawlResult, WebsiteCrawler } from "./types.js";

function seededFraction(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

const CMS_OPTIONS = ["wordpress", "shopify", "squarespace", "webflow", null] as const;

/**
 * Deterministic mock crawler: the same URL always yields the same
 * signals. A handful of reserved URLs simulate failure/edge cases so
 * tests can exercise them without real network access:
 *   - any URL containing "unreachable" -> crawl failure
 *   - any URL containing "thin-content" -> very low word count, no forms
 */
export class MockWebsiteCrawler implements WebsiteCrawler {
  async crawl(url: string): Promise<CrawlResult> {
    if (url.includes("unreachable")) {
      return { ok: false, signals: null, error: "mock: connection refused" };
    }

    const frac = seededFraction(url);
    const isThin = url.includes("thin-content");

    return {
      ok: true,
      error: null,
      signals: {
        finalUrl: url,
        httpStatus: 200,
        hasSsl: url.startsWith("https://"),
        title: `Welcome | ${new URL(url).hostname}`,
        metaDescription: isThin ? null : "A locally owned business serving the community.",
        hasContactForm: !isThin && frac > 0.3,
        hasPhoneNumberOnPage: !isThin && frac > 0.2,
        hasMobileViewportMeta: frac > 0.1, // most sites have this
        wordCount: isThin ? Math.round(frac * 30) : Math.round(300 + frac * 1200),
        cmsGuess: CMS_OPTIONS[Math.floor(frac * CMS_OPTIONS.length)] ?? null,
        pagesCrawled: [url],
      },
    };
  }
}
