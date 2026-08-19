import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  AuditRequiredError,
  CompanyNotFoundError,
  QualificationService,
  getCompaniesPendingQualification,
} from "../../domain/qualification/qualificationService.js";

export const qualificationRouter = Router();

const qualifyBodySchema = z.object({
  companyId: z.string().uuid("companyId must be a UUID"),
});

qualificationRouter.post("/qualify", requireInternalApiKey, async (req, res, next) => {
  const parsed = qualifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new QualificationService();
    const result = await service.qualifyCompany(parsed.data.companyId);
    res.json(result);
  } catch (err) {
    if (err instanceof CompanyNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    if (err instanceof AuditRequiredError) {
      next(new HttpError(409, err.message));
      return;
    }
    next(err);
  }
});

qualificationRouter.get("/qualify/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const companies = await getCompaniesPendingQualification(Number.isFinite(limit) ? limit : 20);
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});
