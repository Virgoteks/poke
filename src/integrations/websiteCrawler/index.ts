import { env } from "../../config/env.js";
import type { WebsiteCrawler } from "./types.js";
import { MockWebsiteCrawler } from "./mockClient.js";
import { RealWebsiteCrawler } from "./realClient.js";

export * from "./types.js";

export function createWebsiteCrawler(): WebsiteCrawler {
  return env.MOCK_EXTERNAL_APIS ? new MockWebsiteCrawler() : new RealWebsiteCrawler();
}
