import { Router } from "express";
import { z } from "zod";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { MessageNotFoundError, SendingService, getMessagesPendingSend } from "../../domain/sending/sendingService.js";

export const sendingRouter = Router();

const sendBodySchema = z.object({
  messageId: z.string().uuid("messageId must be a UUID"),
});

sendingRouter.post("/send/message", requireInternalApiKey, async (req, res, next) => {
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid request body", parsed.error.flatten()));
    return;
  }
  try {
    const service = new SendingService();
    const result = await service.sendMessage(parsed.data.messageId);
    res.json(result);
  } catch (err) {
    if (err instanceof MessageNotFoundError) {
      next(new HttpError(404, err.message));
      return;
    }
    next(err);
  }
});

sendingRouter.get("/send/pending", requireInternalApiKey, async (req, res, next) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const messages = await getMessagesPendingSend(Number.isFinite(limit) ? limit : 20);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});
