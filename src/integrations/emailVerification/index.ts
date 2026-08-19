import { env } from "../../config/env.js";
import type { EmailVerificationClient } from "./types.js";
import { MockEmailVerificationClient } from "./mockClient.js";
import { createRealEmailVerificationClient } from "./realClient.js";

export * from "./types.js";

export function createEmailVerificationClient(): EmailVerificationClient {
  return env.MOCK_EXTERNAL_APIS ? new MockEmailVerificationClient() : createRealEmailVerificationClient();
}
