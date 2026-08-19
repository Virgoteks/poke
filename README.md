# Outreach Platform

Autonomous B2B outreach system covering the full lifecycle:

```
DISCOVER -> AUDIT -> QUALIFY -> FIND DECISION MAKER -> ENRICH -> VERIFY
-> PERSONALIZE -> SEND -> FOLLOW UP -> PROCESS REPLY -> BOOK -> ANALYZE
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
[`docs/MILESTONES.md`](docs/MILESTONES.md) for build progress.

Stack: TypeScript, Node.js, PostgreSQL, Redis, n8n, Docker Compose.

**This project never sends real email.** `MOCK_EXTERNAL_APIS=true` and
`DRY_RUN_SENDING=true` in `.env.example`/`.env.test` are the safe
defaults; live external calls require explicit opt-in with real
credentials.

## Prerequisites

- Node.js >= 20
- Docker + Docker Compose (for the full stack: Postgres, Redis, n8n, API)
- Alternatively for local development: PostgreSQL 16 and Redis installed
  directly on the host

## Quick start (Docker Compose)

```bash
cp .env.example .env      # fill in real secrets only if you intend to go live
docker compose up --build
# API:   http://localhost:3000/healthz
# n8n:   http://localhost:5678
```

`docker compose` also runs a one-shot `migrate` service that applies all
SQL migrations before the API starts.

## Quick start (local host, no Docker)

```bash
npm install
createuser outreach --pwprompt   # or use an existing role
createdb outreach_dev -O outreach
createdb outreach_test -O outreach
cp .env.example .env             # point DATABASE_URL/REDIS_URL at your local instances
npm run migrate
npm run dev                      # http://localhost:3000/healthz
```

## Testing

```bash
npm test              # unit + integration (needs the *_test database + Redis reachable)
npm run test:unit      # no I/O
npm run test:integration
```

Integration tests load `.env.test`, which points at a separate
`outreach_test` database and Redis db index `1`, and truncate all tables
between tests (`tests/helpers/db.ts`). They never touch `outreach_dev` or
production data, and external APIs are mocked (`MOCK_EXTERNAL_APIS=true`).

## Migrations

```bash
npm run migrate          # apply all pending migrations
npm run migrate:status   # show applied/pending
npm run migrate:down     # roll back the most recently applied migration
```

Migrations are plain SQL files in `db/migrations/`, applied in lexical
order and tracked in `schema_migrations`.

## Project guardrails

- No real emails are ever sent by this codebase.
- No production infrastructure or DNS is touched by this codebase.
- All secrets come from environment variables (`src/config/env.ts`); none
  are hard-coded.
- See `docs/ARCHITECTURE.md` for the full list of cross-cutting safety
  guarantees (idempotency, suppression, dedup, backoff, circuit breakers,
  audit logging).
