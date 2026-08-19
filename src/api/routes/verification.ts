import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  ContactNotFoundError,
  VerificationService,
  getContactsPendingVerification,
} from "../../domain/verification/verificationService.js";

export const verificationRouter = Router();

const verifyBodySchema = z.object({
  contactId: z.string().uuid("contactId must be a UUID"),
});

verificationRouter.post("/verify/email", requireInternalApiKey, async (req, res, next) => {
  const parsed = verifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new VerificationService();
    const result = await service.verifyContact(parsed.data.contactId);
    res.json(result);
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    next(err);
  }
});

verificationRouter.get("/verify/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const contacts = await getContactsPendingVerification(Number.isFinite(limit) ? limit : 20);
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});
