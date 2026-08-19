import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { AuditService, CompanyNotFoundError, getCompaniesPendingAudit } from "../../domain/audit/auditService.js";

export const auditRouter = Router();

const auditBodySchema = z.object({
  companyId: z.string().uuid("companyId must be a UUID"),
});

auditRouter.post("/audit/website", requireInternalApiKey, async (req, res, next) => {
  const parsed = auditBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new AuditService();
    const result = await service.auditCompany(parsed.data.companyId);
    res.json(result);
  } catch (err) {
    if (err instanceof CompanyNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    next(err);
  }
});

auditRouter.get("/audit/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const companies = await getCompaniesPendingAudit(Number.isFinite(limit) ? limit : 20);
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});
