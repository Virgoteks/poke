# n8n workflows

Exported n8n workflow JSON lives here, one file per lifecycle stage
(`discover.json`, `audit.json`, `qualify.json`, ...). Each workflow is a
thin orchestration layer: cron/webhook trigger -> HTTP Request node(s)
calling `core-api` with `x-internal-api-key` -> minimal branching on the
HTTP response. All business logic, external API calls, and database
access live in `src/domain` and `src/integrations`, not in the workflow
itself, so they stay unit-testable.

Workflows are added incrementally as each milestone's corresponding API
route lands (see `docs/MILESTONES.md`).
