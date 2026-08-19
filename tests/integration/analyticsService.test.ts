import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { resetAllCircuitBreakers, getCircuitBreaker } from "../../src/lib/circuitBreaker.js";
import { getApiHealth, getPipelineFunnel } from "../../src/domain/analytics/analyticsService.js";
import { truncateAll } from "../helpers/db.js";

describe("analyticsService", () => {
  beforeEach(async () => {
    await truncateAll();
    resetAllCircuitBreakers();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("getPipelineFunnel counts companies by pipeline_stage", async () => {
    await pool.query(`INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-a1', 'A', 'discovered')`);
    await pool.query(`INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-a2', 'B', 'discovered')`);
    await pool.query(`INSERT INTO companies (google_place_id, name, pipeline_stage) VALUES ('place-a3', 'C', 'audited')`);

    const funnel = await getPipelineFunnel();
    const discovered = funnel.companies.find((c) => c.stage === "discovered");
    const audited = funnel.companies.find((c) => c.stage === "audited");
    expect(discovered?.count).toBe(2);
    expect(audited?.count).toBe(1);
  });

  it("getPipelineFunnel counts messages by stage and status", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-a4', 'D') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'x@y.com', 'x@y.com') RETURNING id`,
      [company.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key, status) VALUES ($1, $2, 'initial', 'dedup-an-1', 'sent')`,
      [contact.rows[0]!.id, company.rows[0]!.id],
    );

    const funnel = await getPipelineFunnel();
    const initialSent = funnel.messages.find((m) => m.stage === "initial" && m.status === "sent");
    expect(initialSent?.count).toBe(1);
  });

  it("getPipelineFunnel counts bookings by status", async () => {
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-a5', 'E') RETURNING id`,
    );
    const contact = await pool.query<{ id: string }>(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'z@y.com', 'z@y.com') RETURNING id`,
      [company.rows[0]!.id],
    );
    await pool.query(`INSERT INTO bookings (contact_id, calendly_event_uri, status) VALUES ($1, 'evt-an-1', 'scheduled')`, [
      contact.rows[0]!.id,
    ]);

    const funnel = await getPipelineFunnel();
    expect(funnel.bookings.find((b) => b.status === "scheduled")?.count).toBe(1);
  });

  it("getApiHealth aggregates success/failure counts per provider from api_call_log", async () => {
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status) VALUES ('google_places', 'searchText', 'success', 200)`,
    );
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status) VALUES ('google_places', 'searchText', 'failure', 500)`,
    );
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status) VALUES ('google_places', 'searchText', 'success', 200)`,
    );

    const health = await getApiHealth(24);
    const provider = health.providers.find((p) => p.provider === "google_places");
    expect(provider?.totalCalls).toBe(3);
    expect(provider?.successCalls).toBe(2);
    expect(provider?.failureCalls).toBe(1);
    expect(provider?.successRate).toBeCloseTo(2 / 3);
  });

  it("getApiHealth excludes calls older than the requested window", async () => {
    await pool.query(
      `INSERT INTO api_call_log (provider, endpoint, outcome, http_status, created_at) VALUES ('pagespeed', 'run', 'success', 200, now() - interval '48 hours')`,
    );

    const health = await getApiHealth(24);
    expect(health.providers.find((p) => p.provider === "pagespeed")).toBeUndefined();
  });

  it("getApiHealth reports live circuit breaker state for providers that have been used", async () => {
    getCircuitBreaker("apollo");
    const health = await getApiHealth(24);
    expect(health.circuitBreakers.find((b) => b.provider === "apollo")?.state).toBe("closed");
  });
});
