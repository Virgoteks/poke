import "dotenv/config";
import { z } from "zod";

/**
 * All configuration must come from environment variables / secret storage.
 * This module is the single point of entry for reading process.env, and it
 * fails fast (at import time) if required variables are missing or invalid,
 * so misconfiguration is caught before any workflow runs.
 */
const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: boolFromString,

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  INTERNAL_API_KEY: z.string().min(1, "INTERNAL_API_KEY is required"),
  INSTANTLY_WEBHOOK_SECRET: z.string().min(1),
  CALENDLY_WEBHOOK_SECRET: z.string().min(1),

  GOOGLE_PLACES_API_KEY: z.string().default(""),
  GOOGLE_PAGESPEED_API_KEY: z.string().default(""),
  APOLLO_API_KEY: z.string().default(""),
  EMAIL_VERIFICATION_API_KEY: z.string().default(""),
  EMAIL_VERIFICATION_PROVIDER: z.string().default("neverbounce"),
  INSTANTLY_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  CALENDLY_API_KEY: z.string().default(""),
  CALENDLY_ORG_URI: z.string().default(""),
  CALENDLY_EVENT_TYPE_URI: z.string().default(""),

  MOCK_EXTERNAL_APIS: boolFromString,
  DRY_RUN_SENDING: boolFromString,

  // Safety monitoring (Milestone 11): if more than this many suppressions
  // (unsubscribes/complaints/etc.) are recorded within the rolling window,
  // evaluateSuppressionRate() auto-pauses all sending until a human
  // resumes it -- a circuit breaker for the whole campaign, not just a
  // single external API.
  SAFETY_SUPPRESSION_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  SAFETY_MAX_SUPPRESSIONS_PER_WINDOW: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
