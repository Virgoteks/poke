import type { DiscoverBusinessesOptions, DiscoveredBusiness, GooglePlacesClient } from "./types.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Small deterministic hash so the same query always yields the same "random" numbers. */
function seededFraction(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/**
 * Deterministic mock: the same (query, options) always returns the same
 * place_ids, names, and fields. This lets tests assert exact output and
 * lets re-running DISCOVER for the same query exercise the idempotent
 * upsert path without any network access. Selected automatically when
 * MOCK_EXTERNAL_APIS=true (the default).
 */
export class MockGooglePlacesClient implements GooglePlacesClient {
  async discoverBusinesses(
    query: string,
    options: DiscoverBusinessesOptions = {},
  ): Promise<DiscoveredBusiness[]> {
    const count = Math.min(Math.max(options.maxResults ?? 8, 1), 20);
    const querySlug = slugify(query) || "business";

    return Array.from({ length: count }, (_, i) => {
      const seed = `${querySlug}-${i}`;
      const hasWebsite = i % 3 !== 0; // ~2/3 of mock businesses have a website
      const name = `${query} Business ${i + 1}`.trim();
      const frac = seededFraction(seed);

      return {
        placeId: `mock-place-${querySlug}-${i}`,
        name,
        website: hasWebsite ? `https://${slugify(name)}.example.com` : null,
        phone: `+1-555-01${String(i).padStart(2, "0")}`,
        formattedAddress: `${100 + i} Main St, Orlando, FL 3280${i % 10}, USA`,
        addressComponents: [
          { long_name: "Orlando", types: ["locality"] },
          { long_name: "FL", types: ["administrative_area_level_1"] },
          { long_name: "USA", types: ["country"] },
        ],
        latitude: 28.5383 + frac * 0.1,
        longitude: -81.3792 - frac * 0.1,
        categories: ["point_of_interest", "establishment"],
        rating: Math.round((3 + frac * 2) * 10) / 10,
        userRatingsTotal: Math.floor(frac * 500),
        businessStatus: "OPERATIONAL",
      };
    });
  }
}
