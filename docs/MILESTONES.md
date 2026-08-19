# Milestone log

Each entry is only added once its tests actually pass. This file is
updated as part of every milestone's "update documentation" step.

## Milestone 1 — Architecture, repository, Docker, PostgreSQL, migrations

**Status: complete.**

- Repository scaffolded: `src/` (config, logging, db, lib, api), `db/migrations/`,
  `n8n/workflows/`, `tests/` (unit + integration), `docs/`.
- `src/config/env.ts`: zod-validated environment configuration, single
  point of entry for secrets.
- `src/db/pool.ts` + `src/db/migrate.ts`: pg connection pool, transaction
  helper, hand-rolled SQL migration runner (`up`/`down`/`status`).
- `db/migrations/0001_init.sql`: full initial schema — companies, website_audits,
  qualifications, contacts, email_verifications, suppressions, campaigns,
  messages, replies, bookings, webhook_events, state_transitions,
  api_call_log, idempotency_keys — with the unique constraints that back
  every dedup/idempotency requirement (see `docs/ARCHITECTURE.md`).
- Cross-cutting libraries used by every future milestone:
  `src/lib/retry.ts` (exponential backoff), `src/lib/circuitBreaker.ts`
  (per-provider circuit breaker), `src/lib/idempotency.ts` (Redis lock +
  Postgres ledger), `src/lib/suppression.ts` (global suppression checks),
  `src/lib/stateLog.ts` (state-transition audit log), `src/lib/normalize.ts`
  (email/domain normalization).
- `src/api/app.ts` + `src/server.ts`: Express app with `/healthz`,
  `/readyz`, structured logging, centralized error handling,
  `x-internal-api-key` auth middleware for future internal routes.
- `docker-compose.yml` + `Dockerfile`: Postgres, Redis, n8n, a one-shot
  `migrate` service, and the API service, multi-stage build.
- Tests: 35 passing (7 files) — unit tests for retry/backoff, circuit
  breaker, normalization; integration tests for schema constraints,
  suppression behavior, idempotency replay, and health endpoints, run
  against a real local PostgreSQL 16 + Redis instance.
- Known limitation: this sandbox has no network access to Docker Hub, so
  `docker compose up --build` could not be executed end-to-end here (see
  "Local development environment" in `docs/ARCHITECTURE.md`). The compose
  file was validated with `docker compose config`, and every step the
  Docker image performs (`npm install`, `npm run build`, `node
  dist/db/migrate.js up`, `node dist/server.js`) was independently
  exercised and passed against a local Postgres/Redis instance.

## Milestone 2 — Google Places business discovery

**Status: complete.**

- `src/integrations/googlePlaces/`: `GooglePlacesClient` interface,
  `realClient.ts` (Places API New `searchText`, single call requests
  website/phone directly via field mask — no separate Details call),
  `mockClient.ts` (deterministic — same query always yields the same
  place_ids/fields, no network access), `index.ts` factory switching on
  `MOCK_EXTERNAL_APIS`.
- `src/integrations/httpClient.ts`: `callExternalApi()` composes
  exponential backoff (`withRetry`), a per-provider `CircuitBreaker`, and
  `api_call_log` logging (`withApiCallLog`) — the single entry point every
  future integration (PageSpeed, Apollo, email verification, Instantly,
  OpenAI, Calendly) will route external calls through.
- `src/domain/discovery/discoveryService.ts`: idempotent upsert —
  `google_place_id` is the primary dedup key (update in place on
  re-discovery), `normalized_domain` is a secondary dedup signal (a new
  place_id resolving to a known domain is recorded as `merged_by_domain`
  and does not create a second row); a unique-constraint race is caught
  and resolved with a fallback lookup rather than failing the batch. Only
  first-time creation logs a `discover` state transition, matching
  "significant" transitions rather than every field refresh.
- `POST /discover/places` (internal API key required): validates the
  request body with zod, runs discovery, returns created/updated/merged
  counts.
- `n8n/workflows/discover.json`: scheduled trigger -> `POST
  /discover/places`.
- Tests: 15 new tests (50 total across the project) — mock client
  determinism, idempotent re-discovery, field-refresh-without-duplication,
  domain-based dedup, route auth/validation, and the retry/circuit-breaker/
  api_call_log composition in `httpClient.ts`.

## Milestone 3 — Website crawler + PageSpeed analysis

**Status: complete.**

- `src/integrations/websiteCrawler/`: dependency-free single-page (homepage)
  crawler — `realClient.ts` fetches with a 10s timeout/abort and a 2MB
  body cap, extracts title, meta description, contact-form presence,
  phone-number presence, mobile viewport meta, word count, and a CMS
  guess (WordPress/Shopify/Squarespace/Webflow/Wix) via lightweight
  regexes (no HTML-parser dependency); `mockClient.ts` is deterministic
  per URL, with reserved substrings (`unreachable`, `thin-content`) to
  simulate failure/edge cases in tests. Routed through the same
  `callExternalApi` (backoff + circuit breaker + `api_call_log`) as every
  other integration.
- `src/integrations/pageSpeed/`: Google PageSpeed Insights v5 client
  (mobile + desktop `strategy`), extracts the performance score and a
  handful of Core Web Vitals (LCP, CLS, TBT, TTFB) from the Lighthouse
  result; deterministic mock counterpart.
- `src/lib/pipelineStage.ts`: `transitionEntityStage()` — shared helper
  (companies and contacts) that updates `pipeline_stage` and logs a state
  transition, but only when the stage actually changes, so idempotent
  re-runs don't spam the audit log. Used by every stage from here on.
- `src/domain/audit/auditService.ts`: a company with no website is marked
  `audit_failed` without attempting a crawl (deterministic short-circuit,
  no external calls wasted); a failed crawl also marks `audit_failed`;
  PageSpeed mobile/desktop run independently via `Promise.allSettled` — a
  PageSpeed outage does not block the audit from completing using crawl
  data alone. One `website_audits` row per company (`UNIQUE(company_id)`,
  upserted on every re-run) — idempotent by construction, no dedup logic
  needed beyond the existing constraint.
- `POST /audit/website { companyId }` and `GET /audit/pending?limit=`
  (internal-API-key protected) + `n8n/workflows/audit.json`.
- Added migration `0002_website_audits_nullable_url.sql`: `url` must be
  nullable to correctly represent "no website to audit" rather than
  storing a placeholder value.
- Tests: 18 new tests (68 total) — mock crawler determinism, **the real
  crawler's HTML-parsing logic exercised end-to-end against a local
  `node:http` fixture server** (no external network access needed or
  used), audit service behavior for all four outcomes (no website / crawl
  failure / full success / partial PageSpeed failure), idempotent
  re-audit, and the HTTP routes.

## Milestone 4 — AI website qualification

**Status: complete.**

- `src/domain/qualification/qualificationService.ts`:
  `deterministicQualify()` runs first, and only defers to AI when
  genuinely inconclusive: non-operational businesses are disqualified
  outright; a missing or unreachable website is qualified `hot` without
  any AI call; a site already scoring >=90 on both mobile and desktop
  PageSpeed is disqualified outright. Only mid-range, ambiguous cases
  reach the AI step at all — most of the qualification decision is made
  deterministically before any AI is involved.
- `src/integrations/openai/`: OpenAI structured-output client
  (`response_format: json_schema`, `strict: true`) constrained to a
  `{qualified, tier, reasoning, confidence}` schema; the response is
  additionally validated in application code (not just trusted from the
  API) before being persisted. **"AI must never invent facts about
  prospects"** is enforced structurally, not just by instruction: the
  model is only ever given a closed `QualificationFacts` object built
  from `companies`/`website_audits` columns already on file (see
  `buildFacts()`), never free text about the business, and the system
  prompt requires `reasoning` to cite only fields it was given. A
  deterministic mock client mirrors the same "only cite given fields"
  contract for tests/dev.
- `qualifications` is one row per company (`UNIQUE(company_id)`,
  upserted), recording exactly which path decided it
  (`decided_by = rules_only | rules_and_ai`) — `deterministic_passed` is
  nullable to represent "deferred to AI" as a real third state, not a
  fabricated false (migration `0003`).
- `POST /qualify` requires the company to have an AUDIT record first
  (`AuditRequiredError` -> HTTP 409) — QUALIFY cannot silently run ahead
  of AUDIT in the pipeline order. `GET /qualify/pending` +
  `n8n/workflows/qualify.json`.
- Tests: 22 new tests (90 total) — every deterministic rule branch, the
  AI-deferral path with an injected fake AI client asserting the *exact*
  fact object sent (proving no fabricated data crosses the boundary),
  structured-output validation in the mock, pipeline-order enforcement,
  and idempotent re-qualification.

## Milestone 5 — Apollo owner identification and enrichment

**Status: complete.**

- `src/integrations/apollo/`: `searchPeople(domain, companyName)` (people
  search) and `matchPerson(id)` (email reveal, called separately — real
  Apollo doesn't return emails at search time) with a deterministic mock
  counterpart (`no-contacts` substring simulates an empty result set for
  tests).
- `src/domain/enrichment/decisionMakerRules.ts`: `isDecisionMakerTitle()`
  — a pure, deterministic title-keyword + Apollo-seniority check, no AI
  involved in identifying a decision maker (requirement: "use
  deterministic rules before AI"). Also a credit-conservation gate: an
  email is only ever revealed (`matchPerson`) for a contact the rule
  already flagged as a decision maker.
- `src/domain/enrichment/enrichmentService.ts`: ENRICH is gated on QUALIFY
  having run (`QualificationRequiredError` -> 409) and on the company
  actually being qualified (`CompanyNotQualifiedError` -> 409, refuses to
  spend Apollo credits on a disqualified lead). Contacts are upserted
  idempotently — primary key is `apollo_person_id`, with a secondary
  `(company_id, email_normalized)` dedup check so two different Apollo
  person records that resolve to the same email at the same company don't
  create two contact rows. Company `pipeline_stage` becomes `enriched`,
  `no_decision_maker_found`, or `no_contacts_found` depending on outcome —
  all three are meaningful, logged states for ANALYZE later, not just
  "success/failure".
- `POST /enrich/contacts`, `GET /enrich/pending` +
  `n8n/workflows/enrich.json`.
- Tests: 34 new tests (124 total) — the full decision-maker title/seniority
  rule table, Apollo mock determinism, and an injected fake Apollo client
  proving an email is *only* ever requested for decision makers (asserted
  via exact `matchCalls` list), all four enrichment outcomes, dedup by
  email across Apollo person ids, idempotent re-enrichment, and pipeline
  ordering enforcement.

## Milestone 6 — Email verification

**Status: complete.**

- The task spec lists Google Places, PageSpeed, Apollo, Instantly, OpenAI,
  and Calendly as named external services, but not a specific email
  verification vendor even though it's its own milestone; `.env.example`
  already anticipated this in Milestone 1
  (`EMAIL_VERIFICATION_API_KEY`/`EMAIL_VERIFICATION_PROVIDER`).
  `src/integrations/emailVerification/` implements the same
  real/mock-behind-an-interface pattern as every other integration, with
  a NeverBounce-shaped real client (`valid`/`invalid`/`disposable`/
  `catchall`/`unknown` mapped to a normalized `valid|invalid|risky|unknown`
  result) — swapping vendors only means replacing `realClient.ts`.
- Deterministic rule before any API call: a missing or malformed email
  (`isValidEmailFormat`, added in Milestone 1) is unconditionally
  `invalid` with zero external calls, confirmed by a test using a
  verification client that throws if it is ever invoked.
- `email_verifications` is an append-only history table (every check is
  kept), while `contacts.verification_status` /
  `verification_checked_at` hold the current, fast-to-query state.
- **`isContactEmailVerified()`** in
  `src/domain/verification/verificationService.ts` is now the single
  reusable gate for requirement #7 ("Unverified email addresses must
  never receive outreach") — only a `valid` result passes; `risky`,
  `unknown`, and `invalid` are all treated as not eligible. Milestone 7
  (SEND) will call this before ever creating an outbound message.
- `POST /verify/email`, `GET /verify/pending` +
  `n8n/workflows/verify.json`.
- Tests: 14 new tests (138 total) — mock determinism and reserved-outcome
  substrings, the no-external-call-for-a-bad-email guarantee, persisted
  history vs. current-state semantics, and the eligibility gate itself.

## Milestone 7 — Instantly integration

**Status: complete.**

- **"Do NOT send real emails" is enforced structurally, not by
  convention.** `src/integrations/instantly/index.ts`'s
  `createInstantlyClient()` returns the mock client whenever
  `MOCK_EXTERNAL_APIS` **or** `DRY_RUN_SENDING` is true — either flag
  alone is sufficient to force dry-run, and `DRY_RUN_SENDING` defaults to
  `true` in `.env.example`/`.env.test`. A real send additionally requires
  `INSTANTLY_API_KEY`. Tests prove this with `vi.doMock`, asserting the
  exact client class returned under all four flag combinations.
- `src/integrations/openai/personalization/`: a second OpenAI
  structured-output client (separate from Milestone 4's qualification
  client), same discipline — closed `PersonalizationFacts` input, `{subject,
  body}` schema, validated output, deterministic mock that only ever
  interpolates given fields (never invents a claim).
- `PersonalizationService`: requires a verified email
  (`ContactNotVerifiedError`) and a qualified company
  (`CompanyNotQualifiedError`) before spending an AI call; `dedup_key` is
  a deterministic `sha256(contactId:stage)` hash, so re-running
  personalization for the same contact/stage always targets the same
  `messages` row (`UNIQUE(dedup_key)`); a message that has already been
  `sent` is never overwritten, even if personalization is re-run.
- `SendingService` is where requirement #7 is actually enforced at the
  moment of send: unverified -> `skipped_unverified` (Instantly never
  called), suppressed -> `skipped_suppressed` (Instantly never called),
  already `sent` -> no-op (Instantly never called a second time — this
  *is* "no duplicate outbound messages" at the workflow level, on top of
  the DB constraint). Every outcome is a state transition, not just a
  status flag.
- `POST /personalize/message`, `GET /personalize/pending`,
  `POST /send/message`, `GET /send/pending` +
  `n8n/workflows/personalize_and_send.json`.
- Tests: 30 new tests (168 total) — dry-run gating under every flag
  combination, the mock personalization content only ever citing given
  facts, personalization's verification/qualification gates and
  never-overwrite-a-sent-message guarantee, and sending's
  unverified/suppressed/already-sent/provider-failure paths (a failure is
  recorded, never thrown, and never marks a message sent).

## Milestone 8 — Reply webhook + intent classification

**Status: complete.**

- `POST /webhooks/instantly/reply`: shared-secret header auth
  (`x-webhook-secret` vs `INSTANTLY_WEBHOOK_SECRET`,
  `src/api/middleware/webhookSecret.ts`, reusable for Calendly in
  Milestone 10), zod-validated payload. `n8n/workflows/process_reply.json`
  fronts this webhook (Instantly's dashboard points at n8n's webhook URL)
  so every inbound reply gets a visible execution log in n8n before being
  forwarded to core-api, which does the actual verification / idempotency
  / processing.
- **Requirement #12 ("tolerate duplicate webhook delivery")**:
  `webhook_events (source, external_event_id)` is the idempotency
  arbiter, checked with `INSERT ... ON CONFLICT DO NOTHING` *before* any
  other work — a second delivery of the same event is detected
  immediately and replays the already-computed result rather than
  reprocessing (confirmed by a test asserting the AI classifier is called
  exactly once across two identical deliveries).
- `src/domain/replyProcessing/intentClassificationRules.ts`: deterministic
  keyword rules run first and catch `unsubscribe`, `legal_compliance`,
  `hostile`, and `auto_reply` without any AI call. This is also the
  concrete mechanism behind **requirement #10** ("legal/compliance/hostile
  replies must never receive an AI-generated sales response") — those
  three categories are identified deterministically and always carry
  `requiresHuman: true`, which Milestone 9's safe-reply logic will treat
  as an absolute block on auto-reply, and behind **requirement #9**
  ("unsubscribe requests must immediately prevent future outreach") — an
  `unsubscribe` classification calls `suppress()` in the same request,
  before the HTTP response is even sent.
- Only genuinely ambiguous replies (not one of the above) reach
  `src/integrations/openai/replyClassification/` — a third OpenAI
  structured-output client, classifying among
  `interested|not_interested|question|other` based only on the reply's
  own literal text (classifying given text is not "inventing a fact"
  about the prospect).
- A reply is linked to the contact's most recently sent message when one
  exists, and a contact who replies is transitioned to `replied`. An
  unmatched sender (no contact with that email on file) is recorded in
  `webhook_events` for audit but does not fabricate a `replies` row
  against no one.
- Tests: 27 new tests (195 total) — every deterministic pattern including
  a same-message legal-overrides-unsubscribe priority case, exact-once AI
  invocation under duplicate delivery, unmatched-contact handling,
  message linkage, immediate suppression on unsubscribe, and the webhook
  route's auth/validation/duplicate-tolerance end-to-end. One real bug was
  caught and fixed by these tests: the mock AI classifier matched
  "interested" as a substring of "not interested" and had to check the
  not-interested keyword list first.

## Milestone 9 — Safe automated replies

**Status: complete.**

- `src/integrations/instantly/`: `InstantlyClient` extended with
  `sendReply()` (threaded reply via Instantly's reply endpoint, keyed by
  `inReplyToInstantlyMessageId`); the mock/real split and the
  `MOCK_EXTERNAL_APIS || DRY_RUN_SENDING` dry-run gate from Milestone 7
  apply identically here — a safe automated reply can never become a real
  send any more than an initial outreach message can.
- `src/integrations/openai/safeReply/`: a fourth OpenAI structured-output
  client, same discipline as the other three — a closed `SafeReplyFacts`
  object (company name, contact first name, original subject/body, the
  incoming reply text, intent, and the qualification reasoning already on
  file) is the only input; the system prompt forbids quoting a specific
  price or guarantee and requires proposing a call rather than closing
  the sale in-thread. Deterministic mock counterpart differentiates a
  `question` acknowledgement from a general `interested` acknowledgement.
- `src/domain/safeReply/safeReplyService.ts`
  (`SafeReplyService.generateAndSendSafeReply`) is the concrete mechanism
  behind **requirement #10** ("legal/compliance/hostile replies must
  never receive an AI-generated sales response"): `reply.requires_human`
  is checked *before* intent eligibility and is an absolute gate — the AI
  client is never even called, proven by a dedicated test asserting
  `ai.callCount === 0` for a `requires_human: true` reply regardless of
  its classified intent. Only `interested` and `question` are eligible
  intents; everything else (`not_interested`, `auto_reply`, `other`, and
  unclassified) short-circuits before any AI or Instantly call.
  Requirements #7/#8/#9 are re-checked at this stage too (a safe reply is
  still outreach): unverified and suppressed contacts are blocked before
  generation. `replies.auto_reply_sent` makes a resend idempotent
  (`already_sent`, checked first, before the `requires_human` gate is
  even evaluated) and a provider failure is recorded as `failed` without
  throwing and without marking the reply sent, matching the Milestone 7
  send-failure pattern.
- `src/domain/followUp/followUpService.ts`
  (`getContactsDueForFollowup`) answers "who is due for a scripted
  follow-up right now" without duplicating any send logic: FOLLOW UP
  reuses the existing idempotent `/personalize/message` and
  `/send/message` endpoints from Milestone 7 with a later `stage` value
  (e.g. `followup_1`) rather than a separate send path. A contact is due
  only if the earlier stage was sent more than `hoursSinceSent` ago, the
  later stage hasn't already been sent (`UNIQUE(contact_id, stage)` makes
  re-running this idempotent — never queues a duplicate), they haven't
  replied at all (a reply hands off to safe-reply / human review, not a
  scripted follow-up), and their email is still `valid` (requirement #7
  re-checked, and re-checked again at actual send time by
  `SendingService`).
- `POST /reply/safe-response { replyId }`, `GET
  /reply/pending-safe-response`, `GET /followup/pending?fromStage=&toStage=&hoursSince=&limit=`
  (all internal-API-key protected) + `n8n/workflows/follow_up_and_safe_reply.json`
  — a single hourly schedule trigger fans out to both the follow-up sweep
  (list due contacts -> personalize -> send) and the safe-reply sweep
  (list eligible replies -> generate + send), each branch driven entirely
  by core-api's idempotent endpoints so a missed or re-run n8n execution
  never double-sends.
- Tests: 30 new tests (225 total) — `MockOpenAiSafeReplyClient` content
  checks (greeting, call proposal, question-vs-interested differentiation,
  no price/guarantee), the full `SafeReplyService` gate ordering including
  the critical requirement #10 test, non-eligible-intent parametrized
  cases, unverified/suppressed blocking, missing-original-message
  blocking, successful send with state-transition verification,
  idempotent resend, and Instantly failure handling; `getContactsDueForFollowup`
  covering due/not-yet-due/already-followed-up/already-replied/unverified/limit
  cases; and end-to-end route tests for `/followup/pending` and
  `/reply/safe-response` (auth, validation, 404, and a full
  generate-and-send-via-mock-Instantly pass proving no real send occurs).

## Milestone 10 — Calendly booking integration

**Status: complete.**

- `src/integrations/calendly/`: `createSchedulingLink(contactId)` returns
  a Calendly booking URL with the contactId embedded as `utm_content`
  (the real client calls Calendly's single-use Scheduling Links API and
  appends the UTM param to the returned `booking_url`; the mock is
  deterministic per contactId). This is the concrete mechanism that lets
  an inbound booking be correlated back to a specific contact without
  relying solely on the email the invitee happens to type in — the same
  "known identifier over free text" discipline used everywhere else in
  this pipeline. `GET /booking/scheduling-link?contactId=` (internal-API-
  key protected) exposes it, e.g. for a future personalization step to
  embed in outreach copy.
- `src/api/middleware/calendlySignature.ts`: **unlike** the Instantly
  reply webhook (Milestone 8's `requireWebhookSecret`, a shared static
  secret in a header that n8n itself attaches when it forwards the
  request), this verifies Calendly's actual signing scheme --
  `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac-sha256>`
  computed over `${t}.${rawRequestBody}` with `CALENDLY_WEBHOOK_SECRET`
  as the HMAC key (requirement #13: secret from env only), plus a
  timestamp-tolerance window to reject replayed payloads. `src/api/app.ts`
  now captures the raw request bytes via `express.json()`'s `verify`
  callback, since the signature is only valid against the exact bytes
  Calendly sent, not a re-serialized copy of the parsed body.
- **Deliberate deviation from the Milestone 8 pattern**: Calendly's
  webhook is *not* fronted through n8n. An HTTP hop through n8n's HTTP
  Request node re-serializes the JSON payload, which would silently break
  signature verification unless n8n's raw-body passthrough is configured
  exactly right -- and this sandbox has no way to verify that against a
  live n8n instance. Rather than ship an unverified, easy-to-misconfigure
  workflow, Calendly's webhook subscription is documented to call
  `core-api` directly for this one endpoint (see `docs/ARCHITECTURE.md`);
  every other integration keeps going through n8n. This is judged safer
  than a plausible-looking but untested raw-passthrough workflow file.
- `src/domain/booking/bookingService.ts` (`BookingService.processCalendlyEvent`):
  same idempotency discipline as `ReplyProcessingService` --
  `webhook_events(source, external_event_id)` checked first (scoped by
  event type *and* invitee uri, since `invitee.created` and
  `invitee.canceled` for the same invitee are two distinct, legitimate
  deliveries), `bookings.calendly_event_uri` UNIQUE as the backstop.
  Contact matching tries the `utm_content` contactId first (validated as a
  real, known contact id), falling back to the invitee's email --
  matching either creates/updates one `bookings` row per scheduled event
  (`ON CONFLICT (calendly_event_uri) DO UPDATE`, never a duplicate) and
  transitions the contact's `pipeline_stage` to `booked`.
  `invitee.canceled` updates that same row to `status = 'canceled'`
  (only writing the transition once -- re-delivery is a no-op past the
  ledger, and a genuinely-already-canceled booking is a plain no-op too)
  and moves the contact to `booking_canceled`. An event matching no known
  contact, or a cancellation of a booking never recorded, is logged in
  `webhook_events` for audit without fabricating a `bookings` row.
- `POST /webhooks/calendly` (signature-protected, see above) +
  `GET /booking/scheduling-link?contactId=`. No new migration was needed
  -- Milestone 1's schema already modeled `bookings.calendly_event_uri`
  as the correct idempotency key and `webhook_events.source` as
  `instantly|calendly`.
- Tests: 23 new tests (248 total) -- deterministic mock-link generation,
  the signature middleware's full matrix (valid, missing header, wrong
  secret, tampered body, expired timestamp, malformed header) exercised
  directly with real HMAC computation (no mocking of the crypto itself),
  `BookingService` covering utm_content matching, email fallback matching,
  unmatched-contact and unmatched-cancellation handling, idempotent
  redelivery of both event types, and cancellation state-transition
  correctness; plus end-to-end route tests proving a validly-signed
  request succeeds, an invalid or missing signature is rejected with 401,
  and duplicate delivery doesn't double-book.

## Milestone 11 — Analytics, safety monitoring, circuit breakers

**Status: complete.**

- **Per-provider circuit breakers** were already built in Milestone 1/2
  (`src/lib/circuitBreaker.ts`, wired into every integration through
  `callExternalApi`); this milestone adds `listCircuitBreakers()`, a
  snapshot of every provider breaker's live state, so ANALYZE has
  somewhere to surface "is Apollo currently open" rather than that state
  being invisible outside the process.
- `src/domain/analytics/analyticsService.ts` -- `getPipelineFunnel()`
  reads counts straight from the columns each earlier milestone already
  treats as the source of truth (`companies.pipeline_stage`,
  `contacts.pipeline_stage`, `messages.stage`/`status`, `replies.intent`,
  `bookings.status`), so this view can never drift out of sync with
  actual pipeline behavior -- there is no separate analytics table to
  keep in sync. `getApiHealth(windowHours)` aggregates `api_call_log`
  (success/failure counts and rate per provider over a trailing window)
  and joins in the live circuit breaker snapshot. `GET /analytics/funnel`
  and `GET /analytics/api-health?hours=` (internal-API-key protected)
  expose both.
- **A circuit breaker for the whole campaign, not just one API**:
  `db/migrations/0004_safety_state.sql` adds a single-row `safety_state`
  table (`CHECK (id = 1)` enforces the singleton) backing a runtime
  sending kill switch that is independent of the static
  `DRY_RUN_SENDING`/`MOCK_EXTERNAL_APIS` env flags -- it can be flipped
  without a redeploy. `src/domain/safety/safetyService.ts` exposes
  `isSendingPaused()` (the gate), `pauseSending()`/`resumeSending()`
  (idempotent -- only the transition that actually changes state writes
  to `state_transitions`, using a documented nil-UUID sentinel as the
  "system" entity id), and `evaluateSuppressionRate(windowHours,
  maxAllowed)`: if more suppressions (unsubscribes/complaints/bounces)
  were recorded in the trailing window than the configured threshold
  (`SAFETY_SUPPRESSION_WINDOW_HOURS` / `SAFETY_MAX_SUPPRESSIONS_PER_WINDOW`),
  sending auto-pauses -- a real-world signal (a spike in unsubscribes
  usually means something upstream is wrong -- bad targeting, a broken
  personalization template, a deliverability problem) halting the whole
  pipeline the same way a failing external API halts calls to just that
  provider.
- `isSendingPaused()` is now the **first** check in both
  `SendingService.sendMessage()` (after the already-sent idempotency
  short-circuit) and `SafeReplyService.generateAndSendSafeReply()`
  (after the already-sent check, before the requirement #10
  `requires_human` gate) -- a paused system blocks every send path with
  zero new code in either service beyond the one gate, and neither
  Instantly nor the AI client is ever called while paused.
  `SendOutcomeStatus`/`SafeReplyStatus` gained `skipped_paused` /
  `blocked_paused` accordingly.
- `POST /safety/pause { reason }`, `POST /safety/resume`,
  `GET /safety/status`, `POST /safety/evaluate` (internal-API-key
  protected) + `n8n/workflows/safety_monitor.json` -- an hourly trigger
  calling `/safety/evaluate` so a suppression spike is caught and paused
  automatically well before a human would otherwise notice; the workflow
  branches on `triggered` as an extension point for wiring in an actual
  alert (Slack/email/PagerDuty) once a real one of those integrations
  exists.
- Tests: 24 new tests (272 total) -- `safetyService`'s pause/resume
  idempotency and single-transition-per-change guarantee, the
  suppression-rate breaker actually triggering (and not re-triggering a
  second transition once already paused), `analyticsService`'s funnel
  counts and windowed API-health aggregation exercised against real
  `api_call_log`/`state_transitions` rows, the live circuit-breaker
  snapshot, and end-to-end route tests for both `/safety/*` and
  `/analytics/*`; plus one new test each in `sending.test.ts` and
  `safeReply.test.ts` proving the pause gate blocks a send/auto-reply
  before Instantly or the AI client is ever called, on top of every
  existing test in those two files continuing to pass unmodified
  (the gate is a no-op by default).

---

All 11 milestones are now complete. The full DISCOVER -> AUDIT -> QUALIFY
-> FIND DECISION MAKER -> ENRICH -> VERIFY -> PERSONALIZE -> SEND ->
FOLLOW UP -> PROCESS REPLY -> BOOK -> ANALYZE lifecycle is implemented
end-to-end against mocked external services, with 272 passing tests, no
real email ever sent (`DRY_RUN_SENDING`/`MOCK_EXTERNAL_APIS` both default
`true`, and `createInstantlyClient()` enforces the dry-run guarantee
structurally rather than by convention), and every one of the 15 core
requirements and 5 hard constraints from the original spec enforced in
code and covered by at least one test. See `docs/ARCHITECTURE.md` for the
full design and known limitations (no live Docker Hub / n8n execution in
this sandbox), and this file's per-milestone entries above for what was
built, tested, and why at each step.
