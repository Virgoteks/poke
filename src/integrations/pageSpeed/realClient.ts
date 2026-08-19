import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { CoreWebVitals, PageSpeedClient, PageSpeedResult } from "./types.js";

const API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

interface LighthouseAudit {
  numericValue?: number;
}

interface PageSpeedApiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, LighthouseAudit>;
  };
}

function extractCoreWebVitals(data: PageSpeedApiResponse): CoreWebVitals {
  const audits = data.lighthouseResult?.audits ?? {};
  return {
    largestContentfulPaintMs: audits["largest-contentful-paint"]?.numericValue ?? null,
    cumulativeLayoutShift: audits["cumulative-layout-shift"]?.numericValue ?? null,
    totalBlockingTimeMs: audits["total-blocking-time"]?.numericValue ?? null,
    timeToFirstByteMs: audits["server-response-time"]?.numericValue ?? null,
  };
}

export class RealPageSpeedClient implements PageSpeedClient {
  constructor(private readonly apiKey: string) {}

  async analyze(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult> {
    const params = new URLSearchParams({
      url,
      key: this.apiKey,
      strategy,
      category: "performance",
    });

    const data = await callExternalApi<PageSpeedApiResponse>("pagespeed", `runPagespeed:${strategy}`, async () => {
      const res = await fetch(`${API_URL}?${params.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`PageSpeed API failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as PageSpeedApiResponse;
    });

    const rawScore = data.lighthouseResult?.categories?.performance?.score;
    return {
      performanceScore: typeof rawScore === "number" ? Math.round(rawScore * 100) : null,
      coreWebVitals: extractCoreWebVitals(data),
      raw: data,
    };
  }
}

export function createRealPageSpeedClient(): PageSpeedClient {
  if (!env.GOOGLE_PAGESPEED_API_KEY) {
    throw new Error("GOOGLE_PAGESPEED_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealPageSpeedClient(env.GOOGLE_PAGESPEED_API_KEY);
}
