import { env } from "../../../config/env.js";
import type { ReplyClassificationAiClient } from "./types.js";
import { MockOpenAiReplyClassificationClient } from "./mockClient.js";
import { createRealOpenAiReplyClassificationClient } from "./realClient.js";

export * from "./types.js";

export function createReplyClassificationAiClient(): ReplyClassificationAiClient {
  return env.MOCK_EXTERNAL_APIS
    ? new MockOpenAiReplyClassificationClient()
    : createRealOpenAiReplyClassificationClient();
}
