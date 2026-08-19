import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { requireInternalApiKey } from "../middleware/apiKeyAuth.js";
import { HttpError } from "../middleware/errorHandler.js";
import { createCalendlyClient } from "../../integrations/calendly/index.js";

export const bookingRouter = Router();

const querySchema = z.object({
  contactId: z.string().uuid("contactId must be a UUID"),
});

// Returns a personalized Calendly booking link for a contact, carrying
// their contactId through Calendly's own UTM tracking so the inbound
// webhook (POST /webhooks/calendly) can correlate a completed booking
// back to this exact contact without relying solely on email matching.
bookingRouter.get("/booking/scheduling-link", requireInternalApiKey, async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new HttpError(400, "Invalid query parameters", parsed.error.flatten()));
    return;
  }
  try {
    const contact = await pool.query(`SELECT id FROM contacts WHERE id = $1`, [parsed.data.contactId]);
    if (!contact.rows[0]) {
      next(new HttpError(404, `Contact ${parsed.data.contactId} not found`));
      return;
    }
    const client = createCalendlyClient();
    const result = await client.createSchedulingLink(parsed.data.contactId);
    res.json({ contactId: parsed.data.contactId, bookingUrl: result.bookingUrl });
  } catch (err) {
    next(err);
  }
});
