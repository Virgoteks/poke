import { logger } from "../logging/logger.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Called with the raised error; return false to abort retrying immediately. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for deterministic tests. Returns [0, 1). */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Requirement: "API failures must use exponential backoff."
 * Full-jitter exponential backoff: delay = random() * min(maxDelayMs, base * 2^attempt)
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * exp);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 200,
    maxDelayMs = 8000,
    isRetryable = () => true,
    sleep = defaultSleep,
    random = Math.random,
    onRetry,
  } = options;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const remaining = maxAttempts - attempt - 1;
      if (remaining <= 0 || !isRetryable(err)) {
        throw err;
      }
      const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.({ attempt, delayMs, err });
      logger.warn({ attempt, delayMs, err: String(err) }, "Retrying after failure (exponential backoff)");
      await sleep(delayMs);
    }
  }
  // Unreachable, but keeps TypeScript happy.
  throw lastErr;
}
