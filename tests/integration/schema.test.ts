import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { truncateAll } from "../helpers/db.js";

describe("schema (migration 0001_init)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("has recorded the migration as applied", async () => {
    const res = await pool.query("SELECT id FROM schema_migrations WHERE id = '0001_init'");
    expect(res.rowCount).toBe(1);
  });

  it("prevents duplicate companies by google_place_id", async () => {
    await pool.query(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-1', 'Acme Co')`,
    );
    await expect(
      pool.query(`INSERT INTO companies (google_place_id, name) VALUES ('place-1', 'Acme Co Dup')`),
    ).rejects.toThrow();
  });

  it("prevents duplicate companies by normalized_domain", async () => {
    await pool.query(
      `INSERT INTO companies (google_place_id, name, normalized_domain) VALUES ('place-2', 'Acme', 'acme.com')`,
    );
    await expect(
      pool.query(
        `INSERT INTO companies (google_place_id, name, normalized_domain) VALUES ('place-3', 'Acme Two', 'acme.com')`,
      ),
    ).rejects.toThrow();
  });

  it("allows multiple companies with NULL normalized_domain", async () => {
    await pool.query(`INSERT INTO companies (google_place_id, name) VALUES ('place-4', 'No Site A')`);
    await pool.query(`INSERT INTO companies (google_place_id, name) VALUES ('place-5', 'No Site B')`);
    const res = await pool.query("SELECT count(*) FROM companies");
    expect(Number(res.rows[0].count)).toBe(2);
  });

  it("prevents duplicate contacts per company+email but allows same email at different companies", async () => {
    const c1 = await pool.query(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-6', 'Co A') RETURNING id`,
    );
    const c2 = await pool.query(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-7', 'Co B') RETURNING id`,
    );
    const companyAId = c1.rows[0].id;
    const companyBId = c2.rows[0].id;

    await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'Owner@Co.com', 'owner@co.com')`,
      [companyAId],
    );
    await expect(
      pool.query(
        `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'owner@co.com', 'owner@co.com')`,
        [companyAId],
      ),
    ).rejects.toThrow();

    // Same normalized email at a *different* company is allowed (not a duplicate of the same lead).
    await expect(
      pool.query(
        `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'owner@co.com', 'owner@co.com')`,
        [companyBId],
      ),
    ).resolves.toBeDefined();
  });

  it("enforces one message per dedup_key (hard idempotency for outbound sends)", async () => {
    const company = await pool.query(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-8', 'Co C') RETURNING id`,
    );
    const contact = await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'x@co.com', 'x@co.com') RETURNING id`,
      [company.rows[0].id],
    );
    await pool.query(
      `INSERT INTO messages (contact_id, company_id, stage, dedup_key) VALUES ($1, $2, 'initial', 'dedupkey-1')`,
      [contact.rows[0].id, company.rows[0].id],
    );
    await expect(
      pool.query(
        `INSERT INTO messages (contact_id, company_id, stage, dedup_key) VALUES ($1, $2, 'initial', 'dedupkey-1')`,
        [contact.rows[0].id, company.rows[0].id],
      ),
    ).rejects.toThrow();
  });

  it("enforces unique (source, external_event_id) on webhook_events for duplicate webhook tolerance", async () => {
    await pool.query(
      `INSERT INTO webhook_events (source, external_event_id) VALUES ('instantly', 'evt-1')`,
    );
    await expect(
      pool.query(`INSERT INTO webhook_events (source, external_event_id) VALUES ('instantly', 'evt-1')`),
    ).rejects.toThrow();
    // Different source with the same external id is fine.
    await expect(
      pool.query(`INSERT INTO webhook_events (source, external_event_id) VALUES ('calendly', 'evt-1')`),
    ).resolves.toBeDefined();
  });

  it("enforces unique email_normalized on suppressions (global suppression list)", async () => {
    await pool.query(
      `INSERT INTO suppressions (email_normalized, reason) VALUES ('blocked@co.com', 'unsubscribed')`,
    );
    await expect(
      pool.query(`INSERT INTO suppressions (email_normalized, reason) VALUES ('blocked@co.com', 'manual')`),
    ).rejects.toThrow();
  });
});
