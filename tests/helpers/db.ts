import { pool } from "../../src/db/pool.js";

const TABLES = [
  "idempotency_keys",
  "api_call_log",
  "state_transitions",
  "webhook_events",
  "bookings",
  "replies",
  "messages",
  "campaigns",
  "suppressions",
  "email_verifications",
  "contacts",
  "qualifications",
  "website_audits",
  "companies",
];

/** Wipes all application tables. Only ever pointed at the *_test database. */
export async function truncateAll(): Promise<void> {
  await pool.query(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  // safety_state is a fixed-row singleton (CHECK (id = 1)), not a
  // per-test-data table -- reset it in place so a test that pauses
  // sending never leaks a paused state into the next test.
  await pool.query(
    `UPDATE safety_state SET sending_paused = false, paused_reason = NULL, paused_at = NULL, resumed_at = NULL, updated_at = now() WHERE id = 1`,
  );
}
