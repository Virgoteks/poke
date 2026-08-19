import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { evaluateSuppressionRate, getSafetyState, pauseSending, resumeSending } from "../../domain/safety/safetyService.js";

export const safetyRouter = Router();

safetyRouter.get("/safety/status", requireInternalApiKey, async (_req, res, next) => {
  try {
    const state = await getSafetyState();
    res.json(state);
  } catch (err) {
    next(err);
  }
});

const pauseBodySchema = z.object({
  reason: z.string().min(1, "reason is required"),
});

safetyRouter.post("/safety/pause", requireInternalApiKey, async (req, res, next) => {
  const parsed = pauseBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const result = await pauseSending(parsed.data.reason, "human");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

safetyRouter.post("/safety/resume", requireInternalApiKey, async (_req, res, next) => {
  try {
    const result = await resumeSending("human");
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Intended to be called periodically (e.g. hourly, by n8n) so a spike in
// unsubscribes/complaints auto-pauses sending well before a human notices.
safetyRouter.post("/safety/evaluate", requireInternalApiKey, async (_req, res, next) => {
  try {
    const result = await evaluateSuppressionRate();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
