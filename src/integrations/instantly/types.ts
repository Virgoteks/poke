export interface SendEmailRequest {
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  /** Passed through to Instantly (if supported) so duplicate delivery is a no-op on their side too. */
  idempotencyKey: string;
}

export interface SendEmailResult {
  instantlyMessageId: string;
  dryRun: boolean;
}

export interface SendReplyRequest {
  toEmail: string;
  toName: string | null;
  subject: string;
  body: string;
  /** The Instantly message id of the message being replied to, to keep the thread intact. */
  inReplyToInstantlyMessageId: string | null;
  idempotencyKey: string;
}

export interface SendReplyResult {
  instantlyMessageId: string;
  dryRun: boolean;
}

export interface InstantlyClient {
  sendEmail(request: SendEmailRequest): Promise<SendEmailResult>;
  /** Sends a threaded reply to an inbound message (used by safe automated replies). */
  sendReply(request: SendReplyRequest): Promise<SendReplyResult>;
}
