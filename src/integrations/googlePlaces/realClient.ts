import { env } from "../../config/env.js";
import { callExternalApi, ExternalApiError } from "../httpClient.js";
import type { DiscoverBusinessesOptions, DiscoveredBusiness, GooglePlacesClient } from "./types.js";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Requesting fields directly on Text Search (Places API New) avoids a
// second Place Details round-trip per result.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.websiteUri",
  "places.internationalPhoneNumber",
].join(",");

interface PlacesApiResponse {
  places?: Array<{
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: unknown;
    location?: { latitude?: number; longitude?: number };
    types?: string[];
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    websiteUri?: string;
    internationalPhoneNumber?: string;
  }>;
}

function toDiscoveredBusiness(place: NonNullable<PlacesApiResponse["places"]>[number]): DiscoveredBusiness {
  return {
    placeId: place.id,
    name: place.displayName?.text ?? "Unknown business",
    website: place.websiteUri ?? null,
    phone: place.internationalPhoneNumber ?? null,
    formattedAddress: place.formattedAddress ?? null,
    addressComponents: place.addressComponents ?? null,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
    categories: place.types ?? [],
    rating: place.rating ?? null,
    userRatingsTotal: place.userRatingCount ?? null,
    businessStatus: place.businessStatus ?? null,
  };
}

export class RealGooglePlacesClient implements GooglePlacesClient {
  constructor(private readonly apiKey: string) {}

  async discoverBusinesses(
    query: string,
    options: DiscoverBusinessesOptions = {},
  ): Promise<DiscoveredBusiness[]> {
    const maxResultCount = Math.min(Math.max(options.maxResults ?? 20, 1), 20);
    const body: Record<string, unknown> = { textQuery: query, maxResultCount };
    if (options.locationBias) {
      body.locationBias = {
        circle: {
          center: {
            latitude: options.locationBias.latitude,
            longitude: options.locationBias.longitude,
          },
          radius: options.locationBias.radiusMeters,
        },
      };
    }

    const data = await callExternalApi<PlacesApiResponse>("google_places", "searchText", async () => {
      const res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ExternalApiError(`Google Places searchText failed: ${res.status} ${text}`, res.status);
      }
      return (await res.json()) as PlacesApiResponse;
    });

    return (data.places ?? []).map(toDiscoveredBusiness);
  }
}

export function createRealGooglePlacesClient(): GooglePlacesClient {
  if (!env.GOOGLE_PLACES_API_KEY) {
    throw new Error("GOOGLE_PLACES_API_KEY is required when MOCK_EXTERNAL_APIS=false");
  }
  return new RealGooglePlacesClient(env.GOOGLE_PLACES_API_KEY);
}
