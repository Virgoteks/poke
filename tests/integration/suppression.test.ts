import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, pool } from "../../src/db/pool.js";
import { closeRedis } from "../../src/lib/redis.js";
import { isSuppressed, suppress } from "../../src/lib/suppression.js";
import { truncateAll } from "../helpers/db.js";

describe("suppression (global, cross-campaign)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  it("treats an unknown, unsuppressed email as not suppressed", async () => {
    expect(await isSuppressed("fresh@lead.com")).toBe(false);
  });

  it("treats a missing/unusable email as suppressed by default (fail closed)", async () => {
    expect(await isSuppressed(undefined)).toBe(true);
    expect(await isSuppressed(null)).toBe(true);
    expect(await isSuppressed("not-an-email")).toBe(true);
  });

  it("suppresses an email immediately after an unsubscribe request", async () => {
    expect(await isSuppressed("lead@company.com")).toBe(false);
    await suppress("lead@company.com", "unsubscribed", "instantly_webhook");
    expect(await isSuppressed("lead@company.com")).toBe(true);
    expect(await isSuppressed("Lead@Company.com")).toBe(true); // case-insensitive match
  });

  it("is idempotent when suppressing the same email twice", async () => {
    await suppress("dup@company.com", "unsubscribed");
    await suppress("dup@company.com", "manual");
    const res = await pool.query("SELECT count(*) FROM suppressions WHERE email_normalized = 'dup@company.com'");
    expect(Number(res.rows[0].count)).toBe(1);
  });

  it("logs a state transition for any contact matching a newly suppressed email", async () => {
    const company = await pool.query(
      `INSERT INTO companies (google_place_id, name) VALUES ('place-sup-1', 'Co') RETURNING id`,
    );
    const contact = await pool.query(
      `INSERT INTO contacts (company_id, email, email_normalized) VALUES ($1, 'watched@co.com', 'watched@co.com') RETURNING id`,
      [company.rows[0].id],
    );
    await suppress("watched@co.com", "legal");
    const transitions = await pool.query(
      `SELECT * FROM state_transitions WHERE entity_type = 'contact' AND entity_id = $1 AND stage = 'suppression'`,
      [contact.rows[0].id],
    );
    expect(transitions.rowCount).toBe(1);
    expect(transitions.rows[0].to_state).toBe("suppressed");
    expect(transitions.rows[0].metadata.reason).toBe("legal");
  });
});
