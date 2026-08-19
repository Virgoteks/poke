import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { CalendlyClient, SchedulingLinkResult } from "./types.js";

// Calendly "Single-use Scheduling Links" API: POST /scheduling_links,
// owned by a specific event type, max_event_count 1 so the link can only
// book once. UTM params appended to the returned booking_url survive
// through Calendly's booking flow and are echoed back in the
// invitee.created webhook payload's `tracking.utm_content` field, which is
// how bookingService correlates a completed booking to a specific contact.
const API_URL = "https://api.calendly.com/scheduling_links";

interface CalendlySchedulingLinkResponse {
  resource?: { booking_url?: string };
}

export class RealCalendlyClient implements CalendlyClient {
  constructor(
    private readonly apiKey: string,
    private readonly eventTypeUri: string,
  ) {}

  async createSchedulingLink(contactId: string): Promise<SchedulingLinkResult> {
    const data = await callExternalApi<CalendlySchedulingLinkResponse>("calendly", "scheduling_links", async () => {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          max_event_count: 1,
          owner: this.eventTypeUri,
          owner_type: "EventType",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Calendly scheduling link creation failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as CalendlySchedulingLinkResponse;
    });

    const baseUrl = data.resource?.booking_url;
    if (!baseUrl) {
      throw new ExternalApiError("Calendly response did not include a booking_url");
    }
    const url = new URL(baseUrl);
    url.searchParams.set("utm_content", contactId);
    const bookingUrl = url.toString();
    return { bookingUrl, raw: data };
  }
}

export function createRealCalendlyClient(): CalendlyClient {
  if (!env.CALENDLY_API_KEY) {
    throw new Error("CALENDLY_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  if (!env.CALENDLY_EVENT_TYPE_URI) {
    throw new Error("CALENDLY_EVENT_TYPE_URI is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealCalendlyClient(env.CALENDLY_API_KEY, env.CALENDLY_EVENT_TYPE_URI);
}
