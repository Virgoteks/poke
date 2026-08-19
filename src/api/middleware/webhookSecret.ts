import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errorHandler.js";

/**
 * Verifies an inbound webhook carries the shared secret configured for
 * that provider, via a header the provider is configured to send back
 * verbatim (set up on the provider's webhook configuration screen).
 * Requirement #13: the expected secret always comes from environment
 * configuration, never hard-coded.
 */
export function requireWebhookSecret(headerName: string, expectedSecret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const provided = req.header(headerName);
    if (!expectedSecret || !provided || provided !== expectedSecret) {
      next(new HttpError(401, "Missing or invalid webhook secret"));
      return;
    }
    next();
  };
}
