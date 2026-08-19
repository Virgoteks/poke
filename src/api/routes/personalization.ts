import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  CompanyNotQualifiedError,
  ContactNotFoundError,
  ContactNotVerifiedError,
  PersonalizationService,
  getContactsPendingPersonalization,
} from "../../domain/personalization/personalizationService.js";

export const personalizationRouter = Router();

const personalizeBodySchema = z.object({
  contactId: z.string().uuid("contactId must be a UUID"),
  stage: z.string().min(1).optional(),
});

personalizationRouter.post("/personalize/message", requireInternalApiKey, async (req, res, next) => {
  const parsed = personalizeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new PersonalizationService();
    const result = await service.personalizeContact(parsed.data.contactId, parsed.data.stage);
    res.json(result);
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    if (err instanceof ContactNotVerifiedError || err instanceof CompanyNotQualifiedError) {
      next(new HttpError(409, err.message));
      return;
    }
    next(err);
  }
});

personalizationRouter.get("/personalize/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const contacts = await getContactsPendingPersonalization(Number.isFinite(limit) ? limit : 20);
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});
