import { env } from "../../config/env.js";
import type { InstantlyClient } from "./types.js";
import { MockInstantlyClient } from "./mockClient.js";
import { createRealInstantlyClient } from "./realClient.js";

export * from "./types.js";

/**
 * DRY_RUN_SENDING takes precedence over MOCK_EXTERNAL_APIS: even if
 * MOCK_EXTERNAL_APIS=false (real Google Places/Apollo/etc. calls are
 * enabled), a real Instantly send additionally requires
 * DRY_RUN_SENDING=false. This project's operating constraint is "do not
 * send real emails" -- DRY_RUN_SENDING defaults to true in
 * .env.example/.env.test and nothing in this codebase changes that.
 */
export function createInstantlyClient(): InstantlyClient {
  if (env.MOCK_EXTERNAL_APIS || env.DRY_RUN_SENDING) {
    return new MockInstantlyClient();
  }
  return createRealInstantlyClient();
}
