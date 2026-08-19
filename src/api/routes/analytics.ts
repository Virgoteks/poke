import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getApiHealth, getPipelineFunnel } from "../../domain/analytics/analyticsService.js";

export const analyticsRouter = Router();

analyticsRouter.get("/analytics/funnel", requireInternalApiKey, async (_req, res, next) => {
  try {
    const funnel = await getPipelineFunnel();
    res.json(funnel);
  } catch (err) {
    next(err);
  }
});

const apiHealthQuerySchema = z.object({
  hours: z.coerce.number().positive().default(24),
});

analyticsRouter.get("/analytics/api-health", requireInternalApiKey, async (req, res, next) => {
  const parsed = apiHealthQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid query parameters", parsed.error.flatten()));
    return;
  }
  try {
    const snapshot = await getApiHealth(parsed.data.hours);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});
