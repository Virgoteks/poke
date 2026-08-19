import { pool } from "../db/pool.js";
import { logger } from "../logging/logger.js";

export interface ApiCallLogEntry {
  provider: string;
  endpoint?: string;
  outcome: "success" | "failure";
  httpStatus?: number;
  attempt?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Records every external API call outcome. Backs the circuit breakers'
 * observability and the ANALYZE / safety-monitoring stage (Milestone 11).
 * Never throws — a logging failure must not break the calling workflow.
 */
export async function logApiCall(entry: ApiCallLogEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status, attempt, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.provider,
        entry.endpoint ?? null,
        entry.outcome,
        entry.httpStatus ?? null,
        entry.attempt ?? 1,
        entry.latencyMs ?? null,
        entry.error ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, entry }, "Failed to write api_call_log entry");
  }
}

/**
 * Wraps an external API call with timing + outcome logging. Composition
 * point for withRetry() and the per-provider CircuitBreaker: call this
 * from inside the retried/breaker-guarded function so every attempt is
 * logged individually.
 */
export async function withApiCallLog<T>(
  provider: string,
  endpoint: string,
  attempt: number,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await logApiCall({ provider, endpoint, outcome: "success", attempt, latencyMs: Date.now() - start });
    return result;
  } catch (err) {
    const httpStatus = (err as { statusCode?: number; status?: number })?.statusCode ??
      (err as { status?: number })?.status;
    await logApiCall({
      provider,
      endpoint,
      outcome: "failure",
      attempt,
      latencyMs: Date.now() - start,
      httpStatus,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
