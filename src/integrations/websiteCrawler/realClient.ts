import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { CrawlResult, CrawlSignals, WebsiteCrawler } from "./types.js";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2_000_000; // 2MB cap so a huge page can't stall the pipeline

function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1]!.trim().slice(0, 300) : null;
}

function extractMetaDescription(html: string): string | null {
  const match = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html);
  return match ? match[1]!.trim().slice(0, 500) : null;
}

function guessCms(html: string): string | null {
  const lower = html.toLowerCase();
  if (lower.includes("wp-content") || lower.includes("wp-includes")) return "wordpress";
  if (lower.includes("cdn.shopify.com") || lower.includes("shopify")) return "shopify";
  if (lower.includes("static1.squarespace.com") || lower.includes("squarespace")) return "squarespace";
  if (lower.includes("assets-global.website-files.com") || lower.includes("webflow")) return "webflow";
  if (lower.includes("wixstatic.com") || lower.includes("wix.com")) return "wix";
  return null;
}

function countWords(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ");
  const words = text.split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * Minimal, dependency-free single-page crawler. Fetches only the
 * homepage (this is an MVP scope decision, documented in
 * docs/MILESTONES.md) and extracts deterministic structural signals used
 * by qualification (Milestone 4). Does not execute JavaScript, so
 * client-side-rendered sites will show low/zero word counts — that is a
 * known, honest limitation rather than a bug.
 */
export class RealWebsiteCrawler implements WebsiteCrawler {
  async crawl(url: string): Promise<CrawlResult> {
    try {
      const signals = await callExternalApi<CrawlSignals>("website_crawler", "fetch_homepage", async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            redirect: "follow",
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; OutreachPlatformAuditBot/1.0)",
            },
          });
          if (!res.ok) {
            throw new ExternalApiError(`Website returned ${res.status}`, res.status);
          }
          const reader = res.body;
          let html: string;
          if (reader) {
            const buf = await res.arrayBuffer();
            html = Buffer.from(buf.slice(0, MAX_HTML_BYTES)).toString("utf8");
          } else {
            html = await res.text();
          }
          return {
            finalUrl: res.url || url,
            httpStatus: res.status,
            hasSsl: (res.url || url).startsWith("https://"),
            title: extractTitle(html),
            metaDescription: extractMetaDescription(html),
            hasContactForm: /<form[^>]*>/i.test(html) && /(contact|email|message|inquiry)/i.test(html),
            hasPhoneNumberOnPage: /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(html),
            hasMobileViewportMeta: /<meta[^>]*name=["']viewport["']/i.test(html),
            wordCount: countWords(html),
            cmsGuess: guessCms(html),
            pagesCrawled: [res.url || url],
          };
        } finally {
          clearTimeout(timeout);
        }
      });
      return { ok: true, signals, error: null };
    } catch (err) {
      return { ok: false, signals: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
