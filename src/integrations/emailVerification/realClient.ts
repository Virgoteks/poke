import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { EmailVerificationClient, EmailVerificationOutcome, VerificationResult } from "./types.js";

// NeverBounce-shaped client by default (EMAIL_VERIFICATION_PROVIDER is
// configurable; swap this implementation for another vendor's shape if
// needed -- the rest of the pipeline only depends on the
// EmailVerificationClient interface).
const API_URL = "https://api.neverbounce.com/v4/single/check";

const RESULT_MAP: Record<string, VerificationResult> = {
  valid: "valid",
  invalid: "invalid",
  disposable: "invalid",
  catchall: "risky",
  unknown: "unknown",
};

interface NeverBounceResponse {
  status: string; // "success" | "auth_failure" | ...
  result?: string; // "valid" | "invalid" | "disposable" | "catchall" | "unknown"
}

export class RealEmailVerificationClient implements EmailVerificationClient {
  constructor(private readonly apiKey: string) {}

  async verify(email: string): Promise<EmailVerificationOutcome> {
    const params = new URLSearchParams({ key: this.apiKey, email });
    const data = await callExternalApi<NeverBounceResponse>("email_verification", "single/check", async () => {
      const res = await fetch(`${API_URL}?${params.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Email verification failed: ${res.status} ${text}`, res.status);
      }
      const json = (await res.json()) as NeverBounceResponse;
      if (json.status !== "success") {
        throw new ExternalApiError(`Email verification provider error: ${json.status}`);
      }
      return json;
    });

    const result = RESULT_MAP[data.result ?? "unknown"] ?? "unknown";
    return { result, raw: data };
  }
}

export function createRealEmailVerificationClient(): EmailVerificationClient {
  if (!env.EMAIL_VERIFICATION_API_KEY) {
    throw new Error("EMAIL_VERIFICATION_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealEmailVerificationClient(env.EMAIL_VERIFICATION_API_KEY);
}
