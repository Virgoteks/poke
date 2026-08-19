# Architecture

## Overview

The platform runs the outbound pipeline

```
DISCOVER -> AUDIT -> QUALIFY -> FIND DECISION MAKER -> ENRICH -> VERIFY
-> PERSONALIZE -> SEND -> FOLLOW UP -> PROCESS REPLY -> BOOK -> ANALYZE
```

as a set of small, idempotent HTTP operations exposed by a TypeScript/Node
"core API" service, orchestrated by n8n workflows. n8n owns scheduling,
branching, retries-at-the-workflow-level, and human-visible run history;
the core API owns every piece of business logic, all external API calls,
and all reads/writes to PostgreSQL, which is the system of record for the
whole pipeline. Business logic lives in TypeScript (not inside n8n nodes)
specifically so it is unit- and integration-testable.

```
                +-------------------+
   cron /       |        n8n        |   webhook (Instantly reply,
   manual       |   (orchestration) |    fronted by n8n for visibility)
   trigger  --> |                   | <-------------------------
                +---------+---------+
                          | HTTPS + INTERNAL_API_KEY
                          v
   webhook (Calendly booking, signed --------------------------> core-api
   -- goes straight to core-api, not through n8n; see "Calendly
   webhook signature verification" below)
                +-------------------+        +-----------------+
                |     core-api      |------->|   PostgreSQL     |
                | (Express/TS)      |        | (system of record)|
                |  domain/*         |        +-----------------+
                |  integrations/*   |
                +---------+---------+        +-----------------+
                          |------------------>|      Redis       |
                          |                   | (locks, rate     |
                          v                   |  limiting, queue)|
                +-------------------+         +-----------------+
                | Google Places     |
                | PageSpeed         |
                | Apollo            |
                | Email Verification|
                | Instantly         |
                | OpenAI            |
                | Calendly          |
                +-------------------+
```

## Why n8n + a TypeScript service, rather than logic-in-n8n

- n8n workflow JSON is hard to unit test, hard to code-review, and easy to
  quietly break with a drag-and-drop edit. Every requirement in this spec
  (idempotency, dedup, suppression, "AI must never invent facts", "unverified
  emails must never be sent to") is much safer to guarantee in typed,
  tested code than in visual workflow nodes.
- n8n is still genuinely useful for what it's good at: cron scheduling,
  human-visible execution history, manual approval gates, and being the
  single place non-engineers can see/adjust the pipeline shape.
- Every n8n workflow node that calls into our logic is a single HTTP call
  to `core-api`, authenticated with `INTERNAL_API_KEY`. This keeps the
  workflows thin and the business logic centralized.

## Repository layout

```
src/
  config/         env loading + validation (zod), fails fast on bad config
  logging/        structured logging (pino)
  db/             pg pool, transaction helper, hand-rolled SQL migration runner
  lib/            cross-cutting concerns shared by every milestone:
                    retry.ts           exponential backoff
                    circuitBreaker.ts  per-provider circuit breaker
                    idempotency.ts     Redis lock + Postgres ledger for idempotent ops
                    suppression.ts     global suppression list checks
                    stateLog.ts        state-transition audit logging
                    normalize.ts       deterministic email/domain normalization
  integrations/   one folder per external API (added milestone by milestone),
                  each with a real HTTP client and a mock client selected by
                  MOCK_EXTERNAL_APIS
  domain/         one folder per lifecycle stage (discovery, audit,
                  qualification, ...), pure business logic against
                  integrations + the database
  api/            Express app: routes per stage + webhook receivers,
                  called by n8n
db/migrations/    versioned, hand-written SQL migrations (see below)
n8n/workflows/    exported n8n workflow JSON, one per lifecycle stage
tests/
  unit/           no I/O; pure logic, mocked dependencies
  integration/    real Postgres + Redis (test database), real Express app
                  via supertest, external HTTP mocked
```

## Data model (`db/migrations/0001_init.sql`)

PostgreSQL is the system of record. Every table that represents a
pipeline entity carries the constraints needed to satisfy the platform's
hard requirements, not just application-level checks:

| Table                | Purpose | Dedup / idempotency guarantee |
|-----------------------|---------|--------------------------------|
| `companies`           | DISCOVER | `UNIQUE(google_place_id)`, partial `UNIQUE(normalized_domain)` |
| `website_audits`      | AUDIT | `UNIQUE(company_id)` — one current audit per company |
| `qualifications`      | QUALIFY | `UNIQUE(company_id)` |
| `contacts`             | FIND DECISION MAKER / ENRICH | `UNIQUE(apollo_person_id)`, partial `UNIQUE(company_id, email_normalized)` |
| `email_verifications` | VERIFY | append-only history; `contacts.verification_status` is the fast-path check |
| `suppressions`        | global suppression | `UNIQUE(email_normalized)`, checked before every send, any campaign |
| `messages`            | PERSONALIZE / SEND / FOLLOW UP | `UNIQUE(dedup_key)` **and** `UNIQUE(contact_id, stage)` — no duplicate outbound messages, ever |
| `replies`             | PROCESS REPLY | `UNIQUE(provider, provider_event_id)` — duplicate webhook delivery is a no-op |
| `bookings`            | BOOK | `UNIQUE(calendly_event_uri)` |
| `webhook_events`      | generic inbound-webhook idempotency ledger | `UNIQUE(source, external_event_id)` |
| `state_transitions`   | audit log for every significant state change | append-only |
| `api_call_log`        | external API call outcomes | feeds circuit breakers + ANALYZE |
| `idempotency_keys`    | generic operation-level idempotency ledger | `PRIMARY KEY(key)` |
| `safety_state`        | ANALYZE / safety monitoring -- runtime sending kill switch | single row, `CHECK (id = 1)` enforces the singleton |

Migrations are plain SQL files (`NNNN_name.sql`, optional
`NNNN_name.down.sql`), applied in lexical order and tracked in
`schema_migrations`. `npm run migrate` / `npm run migrate:down` / `npm run
migrate:status` drive them. This is intentionally dependency-light (no
ORM migration DSL) so every migration is reviewable as plain SQL.

## Cross-cutting guarantees

- **Idempotent workflows** (`src/lib/idempotency.ts`): a Redis lock (fast
  path, guards against concurrent duplicate executions) plus a durable
  Postgres ledger (`idempotency_keys`, guards against duplicate executions
  far apart in time) wrap any operation that shouldn't run twice. The
  database `UNIQUE` constraints above are the ultimate backstop even if
  the idempotency layer is bypassed.
- **Duplicate webhook tolerance**: every webhook receiver (Instantly
  replies, Calendly bookings) records `(source, external_event_id)` in
  `webhook_events` before doing anything else; a second delivery of the
  same event is detected and short-circuited.
- **Calendly webhook signature verification**: unlike the Instantly reply
  webhook (a shared static secret in a header, which n8n itself can attach
  when it forwards the request), `POST /webhooks/calendly`
  (`src/api/middleware/calendlySignature.ts`) verifies Calendly's actual
  HMAC-SHA256 signing scheme (`Calendly-Webhook-Signature: t=...,v1=...`
  over `${t}.${rawRequestBody}`, plus a timestamp-tolerance replay guard)
  against the exact bytes Calendly sent. That check is only valid against
  the *unmodified* request body, and an HTTP hop through n8n's HTTP
  Request node re-serializes the JSON payload, which would silently break
  signature verification unless n8n's raw-body passthrough is wired up
  perfectly. Rather than ship an unverified, easy-to-misconfigure
  raw-passthrough n8n workflow, Calendly's webhook subscription is
  configured to call `core-api` directly for this one endpoint; every
  other inbound/outbound integration keeps going through n8n as described
  above.
- **Exponential backoff** (`src/lib/retry.ts`): full-jitter exponential
  backoff (`delay = random() * min(maxDelay, base * 2^attempt)`) wraps
  every external API call.
- **Circuit breakers** (`src/lib/circuitBreaker.ts`): per-provider
  closed/open/half-open breaker sits in front of each integration client
  so a failing external API degrades gracefully instead of being hammered.
- **Global suppression** (`src/lib/suppression.ts`): one table, checked by
  normalized email, with no per-campaign scoping — an unsubscribe or
  bounce anywhere suppresses outreach everywhere, immediately.
- **State transition logging** (`src/lib/stateLog.ts`): every stage writes
  an `(entity_type, entity_id, stage, from_state, to_state, actor,
  metadata)` row on any significant change.
- **Deterministic rules before AI**: qualification and reply
  classification both run deterministic checks first; AI is only
  consulted for the residual judgment call, and its output is always a
  validated structured schema, never free text trusted as fact (see
  Milestone 4 / 8 docs once implemented).
- **Secrets**: `src/config/env.ts` is the only file that reads
  `process.env` for configuration; it validates with zod and fails fast on
  startup if anything required is missing. Nothing else in the codebase
  should reference `process.env` directly.

## External integrations

Every external API (Google Places, PageSpeed, Apollo, email verification,
Instantly, OpenAI, Calendly) is wrapped by a client in `src/integrations/*`
with two implementations behind a common interface: a real HTTP client and
a mock. `MOCK_EXTERNAL_APIS=true` (the default in `.env.example` and
`.env.test`) selects the mock, so the whole pipeline — including CI tests
— runs deterministically with zero real network calls and zero cost.
Setting real API keys and `MOCK_EXTERNAL_APIS=false` switches to live
calls without any other code change. `DRY_RUN_SENDING=true` additionally
prevents the SEND stage from ever making a real Instantly send call
regardless of the mock flag — this must be explicitly turned off, and
sending real email is out of scope for this project per its constraints.

## Local development environment

This repository was built and tested inside a sandboxed development
container that has **no outbound access to Docker Hub** (`docker.io`
resolves to `403 Forbidden`). Because of that:

- `docker-compose.yml` and the `Dockerfile` are the intended way to run
  this stack, and `docker compose config` was used to validate the file is
  syntactically correct and fully resolves.
- All actual code execution, migrations, and automated tests in this
  environment ran against **locally installed** PostgreSQL 16 and Redis
  (started directly on the host, not in containers) — the exact same
  application code, migration SQL, and `npm run build` step that the
  Docker image runs, just without the container runtime layer.
- In any environment with normal internet access, `docker compose up
  --build` will pull `postgres:16-alpine`, `redis:7-alpine`, and
  `n8nio/n8n:latest`, build the `api`/`migrate` images from the
  `Dockerfile`, run migrations, and bring up the API on `:3000` and n8n on
  `:5678`. This has not been executed end-to-end inside this sandbox; treat
  a first run in a real environment as the final integration check before
  going further.
