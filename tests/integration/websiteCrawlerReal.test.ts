import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { RealWebsiteCrawler } from "../../src/integrations/websiteCrawler/realClient.js";
import { truncateAll } from "../helpers/db.js";

const RICH_HTML = `<!doctype html>
<html>
<head>
  <title>Acme Plumbing | Orlando</title>
  <meta name="description" content="Family owned plumbing company in Orlando, FL.">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://example.com/wp-content/themes/acme/style.css">
</head>
<body>
  <h1>Acme Plumbing</h1>
  <p>Call us at (407) 555-0199 for emergency service.</p>
  <form action="/contact" method="post">
    <input type="email" name="email" placeholder="Your email for contact">
    <button type="submit">Send message</button>
  </form>
  <p>${"Lorem ipsum dolor sit amet. ".repeat(80)}</p>
</body>
</html>`;

const THIN_HTML = `<!doctype html><html><head><title>Coming soon</title></head><body><p>Under construction.</p></body></html>`;

describe("RealWebsiteCrawler (against a local HTTP fixture server, no external network)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/rich") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(RICH_HTML);
      } else if (req.url === "/thin") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(THIN_HTML);
      } else if (req.url === "/broken") {
        res.writeHead(500);
        res.end("server error");
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "object" && address) {
      baseUrl = `http://127.0.0.1:${address.port}`;
    } else {
      throw new Error("failed to start fixture server");
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    await closeRedis();
  });

  afterEach(async () => {
    await truncateAll();
  });

  it("extracts title, meta description, contact form, phone, viewport, cms guess, and word count", async () => {
    const crawler = new RealWebsiteCrawler();
    const result = await crawler.crawl(`${baseUrl}/rich`);

    expect(result.ok).toBe(true);
    expect(result.signals!.title).toContain("Acme Plumbing");
    expect(result.signals!.metaDescription).toContain("plumbing company");
    expect(result.signals!.hasContactForm).toBe(true);
    expect(result.signals!.hasPhoneNumberOnPage).toBe(true);
    expect(result.signals!.hasMobileViewportMeta).toBe(true);
    expect(result.signals!.cmsGuess).toBe("wordpress");
    expect(result.signals!.wordCount).toBeGreaterThan(100);

    const logRows = await pool.query("SELECT outcome FROM api_call_log WHERE provider = 'website_crawler'");
    expect(logRows.rowCount).toBeGreaterThan(0);
    expect(logRows.rows.every((r) => r.outcome === "success")).toBe(true);
  });

  it("reports low word count and no contact form for thin pages", async () => {
    const crawler = new RealWebsiteCrawler();
    const result = await crawler.crawl(`${baseUrl}/thin`);
    expect(result.ok).toBe(true);
    expect(result.signals!.hasContactForm).toBe(false);
    expect(result.signals!.wordCount).toBeLessThan(10);
  });

  it("returns ok:false with an error message on a 5xx response, without throwing", async () => {
    const crawler = new RealWebsiteCrawler();
    const result = await crawler.crawl(`${baseUrl}/broken`);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const logRows = await pool.query(
      "SELECT outcome FROM api_call_log WHERE provider = 'website_crawler' ORDER BY id DESC LIMIT 1",
    );
    expect(logRows.rows[0].outcome).toBe("failure");
  });
});
