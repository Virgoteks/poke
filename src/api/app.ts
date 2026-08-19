import express, { type Express } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "../logging/logger.js";
import { healthRouter } from "./routes/health.js";
import { discoveryRouter } from "./routes/discovery.js";
import { auditRouter } from "./routes/audit.js";
import { qualificationRouter } from "./routes/qualification.js";
import { enrichmentRouter } from "./routes/enrichment.js";
import { verificationRouter } from "./routes/verification.js";
import { personalizationRouter } from "./routes/personalization.js";
import { sendingRouter } from "./routes/sending.js";
import { replyWebhookRouter } from "./routes/replyWebhook.js";
import { followUpRouter } from "./routes/followUp.js";
import { safeReplyRouter } from "./routes/safeReply.js";
import { bookingRouter } from "./routes/booking.js";
import { calendlyWebhookRouter } from "./routes/calendlyWebhook.js";
import { safetyRouter } from "./routes/safety.js";
import { analyticsRouter } from "./routes/analytics.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { RequestWithRawBody } from "./middleware/calendlySignature.js";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    express.json({
      limit: "2mb",
      // Calendly webhook signature verification (calendlySignature.ts)
      // needs the exact bytes that were signed, not the re-serialized
      // parsed object -- capture them here, once, for every request.
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req: { url?: string }) => req.url === "/healthz" },
    }),
  );

  app.use(healthRouter);
  app.use(discoveryRouter);
  app.use(auditRouter);
  app.use(qualificationRouter);
  app.use(enrichmentRouter);
  app.use(verificationRouter);
  app.use(personalizationRouter);
  app.use(sendingRouter);
  app.use(replyWebhookRouter);
  app.use(followUpRouter);
  app.use(safeReplyRouter);
  app.use(bookingRouter);
  app.use(calendlyWebhookRouter);
  app.use(safetyRouter);
  app.use(analyticsRouter);

  // Stage routers are mounted here incrementally as each milestone lands.

  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  app.use(errorHandler);
  return app;
}
