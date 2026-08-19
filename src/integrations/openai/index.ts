import { env } from "../../config/env.js";
import type { QualificationAiClient } from "./types.js";
import { MockOpenAiQualificationClient } from "./mockClient.js";
import { createRealOpenAiQualificationClient } from "./realClient.js";

export * from "./types.js";

export function createQualificationAiClient(): QualificationAiClient {
  return env.MOCK_EXTERNAL_APIS ? new MockOpenAiQualificationClient() : createRealOpenAiQualificationClient();
}
