import { env } from "../../../config/env.js";
import type { PersonalizationAiClient } from "./types.js";
import { MockOpenAiPersonalizationClient } from "./mockClient.js";
import { createRealOpenAiPersonalizationClient } from "./realClient.js";

export * from "./types.js";

export function createPersonalizationAiClient(): PersonalizationAiClient {
  return env.MOCK_EXTERNAL_APIS ? new MockOpenAiPersonalizationClient() : createRealOpenAiPersonalizationClient();
}
