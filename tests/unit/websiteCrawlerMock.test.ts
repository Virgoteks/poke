import { describe, expect, it } from "vitest";
import { MockWebsiteCrawler } from "../../src/integrations/websiteCrawler/mockClient.js";

describe("MockWebsiteCrawler", () => {
  it("is deterministic for a given URL", async () => {
    const crawler = new MockWebsiteCrawler();
    const a = await crawler.crawl("https://example.com");
    const b = await crawler.crawl("https://example.com");
    expect(a).toEqual(b);
  });

  it("simulates a failure for URLs containing 'unreachable'", async () => {
    const crawler = new MockWebsiteCrawler();
    const result = await crawler.crawl("https://unreachable-site.example.com");
    expect(result.ok).toBe(false);
    expect(result.signals).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("simulates thin content for URLs containing 'thin-content'", async () => {
    const crawler = new MockWebsiteCrawler();
    const result = await crawler.crawl("https://thin-content.example.com");
    expect(result.ok).toBe(true);
    expect(result.signals!.wordCount).toBeLessThan(50);
    expect(result.signals!.hasContactForm).toBe(false);
  });

  it("reports hasSsl based on the URL scheme", async () => {
    const crawler = new MockWebsiteCrawler();
    const https = await crawler.crawl("https://secure.example.com");
    expect(https.signals!.hasSsl).toBe(true);
  });
});
