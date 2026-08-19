import { createApp } from "./api/app.js";
import { env } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { closePool } from "./db/pool.js";
import { closeRedis } from "./lib/redis.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "outreach-platform API listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down gracefully");
  server.close(async () => {
    await closePool();
    await closeRedis();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
