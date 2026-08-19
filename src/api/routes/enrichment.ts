import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  CompanyNotFoundError,
  CompanyNotQualifiedError,
  EnrichmentService,
  QualificationRequiredError,
  getCompaniesPendingEnrichment,
} from "../../domain/enrichment/enrichmentService.js";

export const enrichmentRouter = Router();

const enrichBodySchema = z.object({
  companyId: z.string().uuid("companyId must be a UUID"),
});

enrichmentRouter.post("/enrich/contacts", requireInternalApiKey, async (req, res, next) => {
  const parsed = enrichBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new EnrichmentService();
    const result = await service.enrichCompany(parsed.data.companyId);
    res.json(result);
  } catch (err) {
    if (err instanceof CompanyNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    if (err instanceof QualificationRequiredError || err instanceof CompanyNotQualifiedError) {
      next(new HttpError(409, err.message));
      return;
    }
    next(err);
  }
});

enrichmentRouter.get("/enrich/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const companies = await getCompaniesPendingEnrichment(Number.isFinite(limit) ? limit : 20);
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});
