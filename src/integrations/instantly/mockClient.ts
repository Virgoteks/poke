import { logger } from "../../logging/logger.js";
import type { InstantlyClient, SendEmailRequest, SendEmailResult, SendReplyRequest, SendReplyResult } from "./types.js";

/**
 * Never makes a network call. Used whenever MOCK_EXTERNAL_APIS=true or
 * DRY_RUN_SENDING=true (the default) -- see index.ts. Logs what would
 * have been sent, for visibility during development, and returns a
 * deterministic fake message id keyed on the idempotency key so retried
 * "sends" of the same message are visibly the same send.
 */
export class MockInstantlyClient implements InstantlyClient {
  async sendEmail(request: SendEmailRequest): Promise<SendEmailResult> {
    logger.info(
      { to: request.toEmail, subject: request.subject, idempotencyKey: request.idempotencyKey },
      "[DRY RUN] Would send email via Instantly (no real email sent)",
    );
    return { instantlyMessageId: `mock-instantly-${request.idempotencyKey}`, dryRun: true };
  }

  async sendReply(request: SendReplyRequest): Promise<SendReplyResult> {
    logger.info(
      { to: request.toEmail, subject: request.subject, idempotencyKey: request.idempotencyKey },
      "[DRY RUN] Would send threaded reply via Instantly (no real email sent)",
    );
    return { instantlyMessageId: `mock-instantly-reply-${request.idempotencyKey}`, dryRun: true };
  }
}
