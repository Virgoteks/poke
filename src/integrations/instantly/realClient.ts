import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { InstantlyClient, SendEmailRequest, SendEmailResult, SendReplyRequest, SendReplyResult } from "./types.js";

const SEND_URL = "https://api.instantly.ai/api/v2/emails/send";
const REPLY_URL = "https://api.instantly.ai/api/v2/emails/reply";

interface InstantlySendResponse {
  id?: string;
  message_id?: string;
}

/**
 * This project's hard constraint is "do not send real emails". This
 * class exists to show the production shape of the integration, but
 * createInstantlyClient() (index.ts) only ever returns it when both
 * MOCK_EXTERNAL_APIS=false and DRY_RUN_SENDING=false -- and
 * DRY_RUN_SENDING defaults to true everywhere in this repo
 * (.env.example, .env.test). Nothing in this codebase disables that
 * default.
 */
export class RealInstantlyClient implements InstantlyClient {
  constructor(private readonly apiKey: string) {}

  async sendEmail(request: SendEmailRequest): Promise<SendEmailResult> {
    const data = await callExternalApi<InstantlySendResponse>("instantly", "emails/send", async () => {
      const res = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          to: request.toEmail,
          to_name: request.toName,
          subject: request.subject,
          body: request.body,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Instantly send failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as InstantlySendResponse;
    });

    const id = data.id ?? data.message_id;
    if (!id) throw new Error("Instantly send response did not include a message id");
    return { instantlyMessageId: id, dryRun: false };
  }

  async sendReply(request: SendReplyRequest): Promise<SendReplyResult> {
    const data = await callExternalApi<InstantlySendResponse>("instantly", "emails/reply", async () => {
      const res = await fetch(REPLY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          to: request.toEmail,
          to_name: request.toName,
          subject: request.subject,
          body: request.body,
          in_reply_to: request.inReplyToInstantlyMessageId,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Instantly reply failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as InstantlySendResponse;
    });

    const id = data.id ?? data.message_id;
    if (!id) throw new Error("Instantly reply response did not include a message id");
    return { instantlyMessageId: id, dryRun: false };
  }
}

export function createRealInstantlyClient(): InstantlyClient {
  if (!env.INSTANTLY_API_KEY) {
    throw new Error("INSTANTLY_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealInstantlyClient(env.INSTANTLY_API_KEY);
}
