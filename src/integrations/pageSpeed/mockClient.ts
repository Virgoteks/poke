import type { PageSpeedClient, PageSpeedResult } from "./types.js";

function seededFraction(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/**
 * Deterministic mock: the same (url, strategy) always yields the same
 * score, so qualification-rule tests downstream can rely on fixed inputs.
 */
export class MockPageSpeedClient implements PageSpeedClient {
  async analyze(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult> {
    const frac = seededFraction(`${url}:${strategy}`);
    const performanceScore = Math.round(frac * 100);
    return {
      performanceScore,
      coreWebVitals: {
        largestContentfulPaintMs: Math.round(1500 + frac * 4000),
        cumulativeLayoutShift: Math.round(frac * 50) / 100,
        totalBlockingTimeMs: Math.round(frac * 900),
        timeToFirstByteMs: Math.round(200 + frac * 800),
      },
      raw: { mock: true, url, strategy, performanceScore },
    };
  }
}
