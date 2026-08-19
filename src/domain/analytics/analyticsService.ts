import { pool } from "../../db/pool.js";
import { listCircuitBreakers } from "../../lib/circuitBreaker.js";

export interface StageCount {
  stage: string;
  count: number;
}

export interface MessageStat {
  stage: string;
  status: string;
  count: number;
}

export interface ReplyIntentStat {
  intent: string | null;
  count: number;
}

export interface BookingStat {
  status: string;
  count: number;
}

export interface PipelineFunnel {
  companies: StageCount[];
  contacts: StageCount[];
  messages: MessageStat[];
  replies: ReplyIntentStat[];
  bookings: BookingStat[];
}

async function groupBy(table: string, column: string): Promise<StageCount[]> {
  const res = await pool.query<{ value: string; count: string }>(
    `SELECT ${column} AS value, count(*) AS count FROM ${table} GROUP BY ${column} ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => ({ stage: r.value, count: Number(r.count) }));
}

/**
 * A single snapshot of "how many things are at each stage of the pipeline
 * right now" -- the concrete ANALYZE-stage output. Every count here comes
 * straight from the columns each earlier milestone already treats as the
 * source of truth (pipeline_stage, messages.status, replies.intent,
 * bookings.status), so this view can never drift out of sync with the
 * pipeline's actual behavior.
 */
export async function getPipelineFunnel(): Promise<PipelineFunnel> {
  const [companies, contacts, messagesRes, repliesRes, bookingsRes] = await Promise.all([
    groupBy("companies", "pipeline_stage"),
    groupBy("contacts", "pipeline_stage"),
    pool.query<{ stage: string; status: string; count: string }>(
      `SELECT stage, status, count(*) AS count FROM messages GROUP BY stage, status ORDER BY stage, status`,
    ),
    pool.query<{ intent: string | null; count: string }>(
      `SELECT intent, count(*) AS count FROM replies GROUP BY intent ORDER BY count(*) DESC`,
    ),
    pool.query<{ status: string; count: string }>(
      `SELECT status, count(*) AS count FROM bookings GROUP BY status ORDER BY count(*) DESC`,
    ),
  ]);

  return {
    companies,
    contacts,
    messages: messagesRes.rows.map((r) => ({ stage: r.stage, status: r.status, count: Number(r.count) })),
    replies: repliesRes.rows.map((r) => ({ intent: r.intent, count: Number(r.count) })),
    bookings: bookingsRes.rows.map((r) => ({ status: r.status, count: Number(r.count) })),
  };
}

export interface ProviderHealth {
  provider: string;
  totalCalls: number;
  successCalls: number;
  failureCalls: number;
  successRate: number | null;
}

export interface ApiHealthSnapshot {
  windowHours: number;
  providers: ProviderHealth[];
  circuitBreakers: Array<{ provider: string; state: string }>;
}

/**
 * External-API health over a trailing window, straight from the
 * api_call_log every integration already writes to (src/integrations/
 * httpClient.ts), plus the live in-process circuit breaker state for each
 * provider that has been called since the process started.
 */
export async function getApiHealth(windowHours = 24): Promise<ApiHealthSnapshot> {
  const res = await pool.query<{ provider: string; outcome: string; count: string }>(
    `SELECT provider, outcome, count(*) AS count
     FROM api_call_log
     WHERE created_at > now() - ($1 || ' hours')::interval
     GROUP BY provider, outcome`,
    [String(windowHours)],
  );

  const byProvider = new Map<string, { success: number; failure: number }>();
  for (const row of res.rows) {
    const entry = byProvider.get(row.provider) ?? { success: 0, failure: 0 };
    if (row.outcome === "success") entry.success += Number(row.count);
    else entry.failure += Number(row.count);
    byProvider.set(row.provider, entry);
  }

  const providers: ProviderHealth[] = Array.from(byProvider.entries()).map(([provider, { success, failure }]) => {
    const totalCalls = success + failure;
    return {
      provider,
      totalCalls,
      successCalls: success,
      failureCalls: failure,
      successRate: totalCalls > 0 ? success / totalCalls : null,
    };
  });

  return { windowHours, providers, circuitBreakers: listCircuitBreakers() };
}
