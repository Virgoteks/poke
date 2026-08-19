import type { NextFunction, Request, Response } from "express";
import { logger } from "../../logging/logger.js";
import { IdempotencyLockError } from "../../lib/idempotency.js";
import { CircuitOpenError } from "../../lib/circuitBreaker.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }
  if (err instanceof IdempotencyLockError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof CircuitOpenError) {
    res.status(503).json({ error: err.message });
    return;
  }
  logger.error({ err, path: req.path, method: req.method }, "Unhandled API error");
  res.status(500).json({ error: "Internal server error" });
}
