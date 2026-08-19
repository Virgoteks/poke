export interface CrawlSignals {
  finalUrl: string;
  httpStatus: number | null;
  hasSsl: boolean;
  title: string | null;
  metaDescription: string | null;
  hasContactForm: boolean;
  hasPhoneNumberOnPage: boolean;
  hasMobileViewportMeta: boolean;
  wordCount: number;
  cmsGuess: string | null;
  pagesCrawled: string[];
}

export interface CrawlResult {
  ok: boolean;
  signals: CrawlSignals | null;
  error: string | null;
}

export interface WebsiteCrawler {
  crawl(url: string): Promise<CrawlResult>;
}
