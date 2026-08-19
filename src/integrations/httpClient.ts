import { getCircuitBreaker } from "../lib/circuitBreaker.js";
import { withRetry, type RetryOptions } from "../lib/retry.js";
import { withApiCallLog } from "../lib/apiCallLog.js";

export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExternalApiError";
  }
}

/** HTTP status codes that are worth retrying (rate limit / transient server errors). */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network error, no status — assume transient
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Every external API integration (Google Places, PageSpeed, Apollo, email
 * verification, Instantly, OpenAI, Calendly) routes its calls through
 * this function so that exponential backoff, a per-provider circuit
 * breaker, and api_call_log observability are applied uniformly.
 */
export async function callExternalApi<T>(
  provider: string,
  endpoint: string,
  fn: () => Promise<T>,
  retryOptions: RetryOptions = {},
): Promise<T> {
  const breaker = getCircuitBreaker(provider);
  return breaker.exec(() =>
    withRetry(
      (attempt) => withApiCallLog(provider, endpoint, attempt + 1, fn),
      {
        isRetryable: (err) => {
          const status = err instanceof ExternalApiError ? err.statusCode : undefined;
          return isRetryableHttpStatus(status);
        },
        ...retryOptions,
      },
    ),
  );
}
