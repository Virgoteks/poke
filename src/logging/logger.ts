import pino from "pino";
import { env, isProduction } from "../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "outreach-platform" },
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l" },
      },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
