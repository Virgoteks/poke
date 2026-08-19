import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { DiscoveryService } from "../../domain/discovery/discoveryService.js";

export const discoveryRouter = Router();

const discoverBodySchema = z.object({
  query: z.string().min(1, "query is required"),
  maxResults: z.number().int().positive().max(20).optional(),
  locationBias: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      radiusMeters: z.number().positive(),
    })
    .optional(),
});

discoveryRouter.post("/discover/places", requireInternalApiKey, async (req, res, next) => {
  const parsed = discoverBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new DiscoveryService();
    const result = await service.discoverAndUpsert(parsed.data.query, {
      maxResults: parsed.data.maxResults,
      locationBias: parsed.data.locationBias,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
