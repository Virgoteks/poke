import { env } from "../../config/env.js";
import type { GooglePlacesClient } from "./types.js";
import { MockGooglePlacesClient } from "./mockClient.js";
import { createRealGooglePlacesClient } from "./realClient.js";

export * from "./types.js";

export function createGooglePlacesClient(): GooglePlacesClient {
  return env.MOCK_EXTERNAL_APIS ? new MockGooglePlacesClient() : createRealGooglePlacesClient();
}
