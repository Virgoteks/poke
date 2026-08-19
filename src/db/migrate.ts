import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../logging/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");

interface Migration {
  id: string; // e.g. 0001_init
  upPath: string;
  downPath: string | null;
}

function loadMigrations(): Migration[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const files = readdirSync(MIGRATIONS_DIR).filter(
    (f) => f.endsWith(".sql") && !f.endsWith(".down.sql"),
  );
  files.sort();
  return files.map((f) => {
    const id = f.replace(/\.sql$/, "");
    const downFile = `${id}.down.sql`;
    return {
      id,
      upPath: path.join(MIGRATIONS_DIR, f),
      downPath: existsSync(path.join(MIGRATIONS_DIR, downFile))
        ? path.join(MIGRATIONS_DIR, downFile)
        : null,
    };
  });
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client: pg.PoolClient): Promise<Set<string>> {
  const res = await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
  return new Set(res.rows.map((r) => r.id));
}

async function up(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const migrations = loadMigrations();
    let ran = 0;
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      const sql = readFileSync(m.upPath, "utf8");
      logger.info({ migration: m.id }, "Applying migration");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
        await client.query("COMMIT");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error({ err, migration: m.id }, "Migration failed, rolled back");
        throw err;
      }
    }
    logger.info({ ran, total: migrations.length }, "Migrations up complete");
  } finally {
    client.release();
    await pool.end();
  }
}

async function down(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const migrations = loadMigrations();
    const lastApplied = migrations
      .filter((m) => applied.has(m.id))
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    if (!lastApplied) {
      logger.info("No migrations to roll back");
      return;
    }
    if (!lastApplied.downPath) {
      throw new Error(`Migration ${lastApplied.id} has no .down.sql file; cannot roll back`);
    }
    const sql = readFileSync(lastApplied.downPath, "utf8");
    logger.info({ migration: lastApplied.id }, "Rolling back migration");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE id = $1", [lastApplied.id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function status(): Promise<void> {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const migrations = loadMigrations();
    for (const m of migrations) {
      // eslint-disable-next-line no-console
      console.log(`${applied.has(m.id) ? "[x]" : "[ ]"} ${m.id}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const command = process.argv[2] ?? "up";

const run = command === "up" ? up : command === "down" ? down : command === "status" ? status : null;

if (!run) {
  logger.error({ command }, "Unknown migrate command. Use: up | down | status");
  process.exit(1);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Migration command failed");
    process.exit(1);
  });
