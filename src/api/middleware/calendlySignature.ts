import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errorHandler.js";

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies Calendly's real webhook signing scheme:
 * `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256>`,
 * where the signed payload is `${t}.${rawRequestBody}` and the HMAC key is
 * the shared secret configured on the Calendly webhook subscription
 * (requirement #13: the secret only ever comes from env config, see
 * `env.CALENDLY_WEBHOOK_SECRET`). The timestamp tolerance defends against
 * replaying a captured payload long after the fact.
 */
export function requireCalendlySignature(secret: string, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header("calendly-webhook-signature");
    const rawBody = (req as RequestWithRawBody).rawBody;

    if (!secret || !header || !rawBody) {
      next(new HttpError(401, "Missing Calendly webhook signature"));
      return;
    }

    const parts: Record<string, string> = {};
    for (const kv of header.split(",")) {
      const [key, value] = kv.split("=");
      if (key && value) parts[key] = value;
    }
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      next(new HttpError(401, "Malformed Calendly webhook signature"));
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) {
      next(new HttpError(401, "Calendly webhook signature timestamp outside tolerance"));
      return;
    }

    const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
    const expectedHex = createHmac("sha256", secret).update(signedPayload).digest("hex");

    let valid = false;
    try {
      const expectedBuf = Buffer.from(expectedHex, "hex");
      const providedBuf = Buffer.from(signature, "hex");
      valid = expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
    } catch {
      valid = false;
    }

    if (!valid) {
      next(new HttpError(401, "Invalid Calendly webhook signature"));
      return;
    }

    next();
  };
}
