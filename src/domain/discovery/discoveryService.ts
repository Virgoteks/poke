import { pool, withTransaction } from "../../db/pool.js";
import { logStateTransition } from "../../lib/stateLog.js";
import { normalizeDomain } from "../../lib/normalize.js";
import { logger } from "../../logging/logger.js";
import type { DiscoverBusinessesOptions, DiscoveredBusiness, GooglePlacesClient } from "../../integrations/googlePlaces/types.js";
import { createGooglePlacesClient } from "../../integrations/googlePlaces/index.js";

export type UpsertOutcome = "created" | "updated" | "merged_by_domain";

export interface UpsertedCompany {
  id: string;
  placeId: string;
  name: string;
  outcome: UpsertOutcome;
}

export interface DiscoverAndUpsertResult {
  query: string;
  discovered: number;
  created: number;
  updated: number;
  mergedByDomain: number;
  companies: UpsertedCompany[];
}

const UNIQUE_VIOLATION = "23505";

/**
 * Idempotently persists one discovered business as a `companies` row.
 *
 * Dedup strategy (requirement: "No duplicate companies"):
 *   1. `google_place_id` is the primary natural key — a second discovery
 *      of the same place updates the existing row in place.
 *   2. `normalized_domain` is a secondary dedup signal — if a *different*
 *      place_id resolves to a website we already have on file, we treat
 *      it as the same real-world business and do not create a second row.
 * Both are enforced by database UNIQUE constraints, not just this
 * application logic, so the guarantee holds even under concurrent
 * discovery runs.
 */
async function upsertCompany(
  business: DiscoveredBusiness,
  discoveryQuery: string,
): Promise<UpsertedCompany> {
  const normalizedDomain = normalizeDomain(business.website);

  const existingByPlaceId = await pool.query<{ id: string }>(
    `SELECT id FROM companies WHERE google_place_id = $1`,
    [business.placeId],
  );

  if (existingByPlaceId.rowCount && existingByPlaceId.rowCount > 0) {
    const id = existingByPlaceId.rows[0]!.id;
    await pool.query(
      `UPDATE companies SET
         name = $2, website = $3, normalized_domain = $4, phone = $5,
         formatted_address = $6, address_components = $7, latitude = $8,
         longitude = $9, categories = $10, rating = $11, user_ratings_total = $12,
         business_status = $13, updated_at = now()
       WHERE id = $1`,
      [
        id,
        business.name,
        business.website,
        normalizedDomain,
        business.phone,
        business.formattedAddress,
        JSON.stringify(business.addressComponents ?? null),
        business.latitude,
        business.longitude,
        business.categories,
        business.rating,
        business.userRatingsTotal,
        business.businessStatus,
      ],
    );
    return { id, placeId: business.placeId, name: business.name, outcome: "updated" };
  }

  if (normalizedDomain) {
    const existingByDomain = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE normalized_domain = $1`,
      [normalizedDomain],
    );
    if (existingByDomain.rowCount && existingByDomain.rowCount > 0) {
      const row = existingByDomain.rows[0]!;
      logger.info(
        { domain: normalizedDomain, placeId: business.placeId, existingCompanyId: row.id },
        "Discovered place matches an existing company by domain; treating as duplicate, not inserting",
      );
      return { id: row.id, placeId: business.placeId, name: row.name, outcome: "merged_by_domain" };
    }
  }

  try {
    // INSERT + audit log happen atomically: if the insert races with a
    // concurrent discovery run and loses, the transaction rolls back
    // cleanly and the catch block below falls back to a plain SELECT
    // (a rolled-back transaction cannot be reused for further queries).
    return await withTransaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO companies (
           google_place_id, name, website, normalized_domain, phone,
           formatted_address, address_components, latitude, longitude,
           categories, rating, user_ratings_total, business_status,
           source, discovery_query, pipeline_stage
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'google_places',$14,'discovered')
         RETURNING id`,
        [
          business.placeId,
          business.name,
          business.website,
          normalizedDomain,
          business.phone,
          business.formattedAddress,
          JSON.stringify(business.addressComponents ?? null),
          business.latitude,
          business.longitude,
          business.categories,
          business.rating,
          business.userRatingsTotal,
          business.businessStatus,
          discoveryQuery,
        ],
      );
      const id = inserted.rows[0]!.id;
      await logStateTransition(
        {
          entityType: "company",
          entityId: id,
          stage: "discover",
          fromState: null,
          toState: "discovered",
          actor: "system",
          metadata: { placeId: business.placeId, discoveryQuery },
        },
        client,
      );
      return { id, placeId: business.placeId, name: business.name, outcome: "created" as const };
    });
  } catch (err) {
    // A concurrent discovery run may have inserted the same place_id or
    // domain between our check and our insert; fall back to fetching the
    // now-existing row rather than failing the whole batch.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      const fallback = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM companies WHERE google_place_id = $1 OR normalized_domain = $2 LIMIT 1`,
        [business.placeId, normalizedDomain],
      );
      if (fallback.rowCount && fallback.rowCount > 0) {
        const row = fallback.rows[0]!;
        return { id: row.id, placeId: business.placeId, name: row.name, outcome: "merged_by_domain" };
      }
    }
    throw err;
  }
}

export class DiscoveryService {
  constructor(private readonly placesClient: GooglePlacesClient = createGooglePlacesClient()) {}

  async discoverAndUpsert(
    query: string,
    options: DiscoverBusinessesOptions = {},
  ): Promise<DiscoverAndUpsertResult> {
    const businesses = await this.placesClient.discoverBusinesses(query, options);

    const companies: UpsertedCompany[] = [];
    for (const business of businesses) {
      const result = await upsertCompany(business, query);
      companies.push(result);
    }

    const created = companies.filter((c) => c.outcome === "created").length;
    const updated = companies.filter((c) => c.outcome === "updated").length;
    const mergedByDomain = companies.filter((c) => c.outcome === "merged_by_domain").length;

    logger.info(
      { query, discovered: businesses.length, created, updated, mergedByDomain },
      "Discovery run complete",
    );

    return { query, discovered: businesses.length, created, updated, mergedByDomain, companies };
  }
}

export async function getCompanyByPlaceId(placeId: string) {
  const res = await pool.query(`SELECT * FROM companies WHERE google_place_id = $1`, [placeId]);
  return res.rows[0] ?? null;
}
