import { env } from "../../config/env.js";
import type { ApolloClient } from "./types.js";
import { MockApolloClient } from "./mockClient.js";
import { createRealApolloClient } from "./realClient.js";

export * from "./types.js";

export function createApolloClient(): ApolloClient {
  return env.MOCK_EXTERNAL_APIS ? new MockApolloClient() : createRealApolloClient();
}
