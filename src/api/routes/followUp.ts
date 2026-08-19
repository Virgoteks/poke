import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { getContactsDueForFollowup } from "../../domain/followUp/followUpService.js";

export const followUpRouter = Router();

const querySchema = z.object({
  fromStage: z.string().min(1),
  toStage: z.string().min(1),
  hoursSince: z.coerce.number().positive().default(48),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

followUpRouter.get("/followup/pending", requireInternalApiKey, async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid query parameters", parsed.error.flatten()));
    return;
  }
  try {
    const contacts = await getContactsDueForFollowup(
      parsed.data.fromStage,
      parsed.data.toStage,
      parsed.data.hoursSince,
      parsed.data.limit,
    );
    res.json({ contacts });
  } catch (err) {
    next(err);
  }
});
