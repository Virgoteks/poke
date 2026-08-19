import { env } from "../../config/env.js";
import type { CalendlyClient } from "./types.js";
import { MockCalendlyClient } from "./mockClient.js";
import { createRealCalendlyClient } from "./realClient.js";

export * from "./types.js";

export function createCalendlyClient(): CalendlyClient {
  return env.MOCK_EXTERNAL_APIS ? new MockCalendlyClient() : createRealCalendlyClient();
}
