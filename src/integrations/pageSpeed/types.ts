export interface CoreWebVitals {
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number | null;
  totalBlockingTimeMs: number | null;
  timeToFirstByteMs: number | null;
}

export interface PageSpeedResult {
  performanceScore: number | null; // 0-100
  coreWebVitals: CoreWebVitals;
  raw: unknown;
}

export interface PageSpeedClient {
  analyze(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult>;
}
