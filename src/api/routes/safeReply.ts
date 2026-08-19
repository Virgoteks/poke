import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import {
  ReplyNotFoundError,
  SafeReplyService,
  getRepliesPendingSafeResponse,
} from "../../domain/safeReply/safeReplyService.js";

export const safeReplyRouter = Router();

const bodySchema = z.object({
  replyId: z.string().uuid("replyId must be a UUID"),
});

safeReplyRouter.post("/reply/safe-response", requireInternalApiKey, async (req, res, next) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new SafeReplyService();
    const result = await service.generateAndSendSafeReply(parsed.data.replyId);
    res.json(result);
  } catch (err) {
    if (err instanceof ReplyNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    next(err);
  }
});

safeReplyRouter.get("/reply/pending-safe-response", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const replies = await getRepliesPendingSafeResponse(Number.isFinite(limit) ? limit : 20);
    res.json({ replies });
  } catch (err) {
    next(err);
  }
});
