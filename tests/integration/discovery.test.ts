import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { DiscoveryService } from "../../src/domain/discovery/discoveryService.js";
import type { GooglePlacesClient, DiscoveredBusiness } from "../../src/integrations/googlePlaces/types.js";
import { truncateAll } from "../helpers/db.js";

function fakeBusiness(overrides: Partial<DiscoveredBusiness> = {}): DiscoveredBusiness {
  return {
    placeId: "place-fixed-1",
    name: "Fixed Business",
    website: "https://fixed-business.com",
    phone: "+1-555-0100",
    formattedAddress: "1 Main St, Orlando, FL",
    addressComponents: null,
    latitude: 28.5,
    longitude: -81.4,
    categories: ["establishment"],
    rating: 4.5,
    userRatingsTotal: 100,
    businessStatus: "OPERATIONAL",
    ...overrides,
  };
}

class FixedGooglePlacesClient implements GooglePlacesClient {
  constructor(private readonly businesses: DiscoveredBusiness[]) {}
  async discoverBusinesses(): Promise<DiscoveredBusiness[]> {
    return this.businesses;
  }
}

describe("DiscoveryService.discoverAndUpsert", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("creates one company per discovered business and logs a discover state transition", async () => {
    const service = new DiscoveryService(new FixedGooglePlacesClient([fakeBusiness()]));
    const result = await service.discoverAndUpsert("fixed query");

    expect(result.discovered).toBe(1);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.mergedByDomain).toBe(0);

    const company = await pool.query("SELECT * FROM companies WHERE google_place_id = $1", ["place-fixed-1"]);
    expect(company.rowCount).toBe(1);
    expect(company.rows[0].normalized_domain).toBe("fixed-business.com");
    expect(company.rows[0].pipeline_stage).toBe("discovered");

    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'company' AND entity_id = $1`,
      [company.rows[0].id],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("discovered");
    expect(transitions.rows[0].stage).toBe("discover");
  });

  it("is idempotent: re-running discovery for the same place_id updates, never duplicates", async () => {
    const client = new FixedGooglePlacesClient([fakeBusiness({ rating: 4.5 })]);
    const service = new DiscoveryService(client);

    await service.discoverAndUpsert("fixed query");
    const second = await service.discoverAndUpsert("fixed query");

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const rows = await pool.query("SELECT * FROM companies WHERE google_place_id = $1", ["place-fixed-1"]);
    expect(rows.rowCount).toBe(1);

    // Only one state transition should exist (from the original creation), not one per run.
    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'company' AND entity_id = $1`,
      [rows.rows[0].id],
    );
    expect(transitions.rowCount).toBe(1);
  });

  it("picks up field changes (e.g. rating) on re-discovery without creating a duplicate row", async () => {
    const service1 = new DiscoveryService(new FixedGooglePlacesClient([fakeBusiness({ rating: 3.0 })]));
    await service1.discoverAndUpsert("fixed query");

    const service2 = new DiscoveryService(new FixedGooglePlacesClient([fakeBusiness({ rating: 4.8 })]));
    await service2.discoverAndUpsert("fixed query");

    const rows = await pool.query("SELECT rating FROM companies WHERE google_place_id = $1", ["place-fixed-1"]);
    expect(rows.rowCount).toBe(1);
    expect(Number(rows.rows[0].rating)).toBe(4.8);
  });

  it("treats a different place_id resolving to a known domain as a duplicate (merged_by_domain)", async () => {
    const service1 = new DiscoveryService(
      new FixedGooglePlacesClient([fakeBusiness({ placeId: "place-A", website: "https://same-domain.com" })]),
    );
    await service1.discoverAndUpsert("query A");

    const service2 = new DiscoveryService(
      new FixedGooglePlacesClient([
        fakeBusiness({ placeId: "place-B", name: "Different Place Id Same Site", website: "https://same-domain.com" }),
      ]),
    );
    const result2 = await service2.discoverAndUpsert("query B");

    expect(result2.created).toBe(0);
    expect(result2.mergedByDomain).toBe(1);

    const rows = await pool.query("SELECT count(*) FROM companies WHERE normalized_domain = 'same-domain.com'");
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("allows multiple businesses with no website (null normalized_domain) without collisions", async () => {
    const service = new DiscoveryService(
      new FixedGooglePlacesClient([
        fakeBusiness({ placeId: "place-no-site-1", website: null }),
        fakeBusiness({ placeId: "place-no-site-2", website: null }),
      ]),
    );
    const result = await service.discoverAndUpsert("no website query");
    expect(result.created).toBe(2);
  });
});
