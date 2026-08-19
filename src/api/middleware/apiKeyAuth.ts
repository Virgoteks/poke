import type { NextFunction, Request, Response } from "express";
import { env } from "../../config/env.js";
import { HttpError } from "./errorHandler.js";

/**
 * Protects internal endpoints (called by n8n) with a shared secret.
 * Requirement #13: "Secrets must only come from environment variables/secret storage."
 */
export function requireInternalApiKey(req: Request, _res: Response, next: NextFunction): void {
  const provided = req.header("x-internal-api-key");
  if (!provided || provided !== env.INTERNAL_API_KEY) {
    next(new HttpError(401, "Missing or invalid internal API key"));
    return;
  }
  next();
}
