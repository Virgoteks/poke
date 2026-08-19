import { env } from "../../config/env.js";
import type { PageSpeedClient } from "./types.js";
import { MockPageSpeedClient } from "./mockClient.js";
import { createRealPageSpeedClient } from "./realClient.js";

export * from "./types.js";

export function createPageSpeedClient(): PageSpeedClient {
  return env.MOCK_EXTERNAL_APIS ? new MockPageSpeedClient() : createRealPageSpeedClient();
}
