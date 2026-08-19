import { logger } from "../logging/logger.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold?: number; // consecutive failures before opening
  resetTimeoutMs?: number; // time before trying half-open probe
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(public readonly provider: string) {
    super(`Circuit breaker is open for provider "${provider}"`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Per-provider circuit breaker. Protects downstream systems (and our own
 * quota) from hammering a failing external API, and gives ANALYZE / safety
 * monitoring (Milestone 11) a place to observe provider health.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    public readonly provider: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half_open";
    }
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();
    if (currentState === "open") {
      throw new CircuitOpenError(this.provider);
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") {
      logger.info({ provider: this.provider }, "Circuit breaker closing after successful probe");
    }
    this.state = "closed";
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      if (this.state !== "open") {
        logger.error(
          { provider: this.provider, consecutiveFailures: this.consecutiveFailures },
          "Circuit breaker opening due to repeated failures",
        );
      }
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}

const registry = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(provider: string, options?: CircuitBreakerOptions): CircuitBreaker {
  let breaker = registry.get(provider);
  if (!breaker) {
    breaker = new CircuitBreaker(provider, options);
    registry.set(provider, breaker);
  }
  return breaker;
}

export function resetAllCircuitBreakers(): void {
  for (const b of registry.values()) b.reset();
}

/**
 * Snapshot of every provider circuit breaker that has been used since the
 * process started (breakers are created lazily on first use), for
 * ANALYZE / safety-monitoring dashboards (Milestone 11).
 */
export function listCircuitBreakers(): Array<{ provider: string; state: CircuitState }> {
  return Array.from(registry.values()).map((b) => ({ provider: b.provider, state: b.getState() }));
}
