export interface DiscoveredBusiness {
  placeId: string;
  name: string;
  website: string | null;
  phone: string | null;
  formattedAddress: string | null;
  addressComponents: unknown;
  latitude: number | null;
  longitude: number | null;
  categories: string[];
  rating: number | null;
  userRatingsTotal: number | null;
  businessStatus: string | null;
}

export interface LocationBias {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface DiscoverBusinessesOptions {
  locationBias?: LocationBias;
  /** Capped to the provider's page size; Places API Text Search returns up to 20 per call. */
  maxResults?: number;
}

export interface GooglePlacesClient {
  discoverBusinesses(
    query: string,
    options?: DiscoverBusinessesOptions,
  ): Promise<DiscoveredBusiness[]>;
}
