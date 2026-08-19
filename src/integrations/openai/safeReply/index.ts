import { env } from "../../../config/env.js";
import type { SafeReplyAiClient } from "./types.js";
import { MockOpenAiSafeReplyClient } from "./mockClient.js";
import { createRealOpenAiSafeReplyClient } from "./realClient.js";

export * from "./types.js";

export function createSafeReplyAiClient(): SafeReplyAiClient {
  return env.MOCK_EXTERNAL_APIS ? new MockOpenAiSafeReplyClient() : createRealOpenAiSafeReplyClient();
}
