import { describe, expect, it } from "vitest";
import { MockGooglePlacesClient } from "../../src/integrations/googlePlaces/mockClient.js";

describe("MockGooglePlacesClient", () => {
  it("is deterministic: the same query returns identical place_ids across calls", async () => {
    const client = new MockGooglePlacesClient();
    const first = await client.discoverBusinesses("plumbers in orlando", { maxResults: 5 });
    const second = await client.discoverBusinesses("plumbers in orlando", { maxResults: 5 });
    expect(first.map((b) => b.placeId)).toEqual(second.map((b) => b.placeId));
    expect(first).toEqual(second);
  });

  it("respects maxResults", async () => {
    const client = new MockGooglePlacesClient();
    const results = await client.discoverBusinesses("dentists", { maxResults: 3 });
    expect(results).toHaveLength(3);
  });

  it("produces a mix of businesses with and without a website", async () => {
    const client = new MockGooglePlacesClient();
    const results = await client.discoverBusinesses("roofers", { maxResults: 10 });
    expect(results.some((b) => b.website)).toBe(true);
    expect(results.some((b) => b.website === null)).toBe(true);
  });

  it("different queries produce different place_ids", async () => {
    const client = new MockGooglePlacesClient();
    const a = await client.discoverBusinesses("bakeries", { maxResults: 2 });
    const b = await client.discoverBusinesses("law firms", { maxResults: 2 });
    expect(a.map((x) => x.placeId)).not.toEqual(b.map((x) => x.placeId));
  });
});
