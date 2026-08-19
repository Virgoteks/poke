-- 0001_init: core schema for the outreach platform.
-- PostgreSQL is the system of record for the entire pipeline:
-- DISCOVER -> AUDIT -> QUALIFY -> FIND DECISION MAKER -> ENRICH -> VERIFY
-- -> PERSONALIZE -> SEND -> FOLLOW UP -> PROCESS REPLY -> BOOK -> ANALYZE

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- companies (DISCOVER)
-- ---------------------------------------------------------------------------
CREATE TABLE companies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id     TEXT UNIQUE,
  name                TEXT NOT NULL,
  website             TEXT,
  normalized_domain   TEXT, -- lowercased registrable domain, used for secondary dedup
  phone               TEXT,
  formatted_address   TEXT,
  address_components  JSONB,
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,
  categories          TEXT[] NOT NULL DEFAULT '{}',
  rating              NUMERIC,
  user_ratings_total  INTEGER,
  business_status     TEXT,
  source              TEXT NOT NULL DEFAULT 'google_places',
  discovery_query     TEXT,
  pipeline_stage      TEXT NOT NULL DEFAULT 'discovered',
  disqualified_reason TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_companies_normalized_domain
  ON companies (normalized_domain)
  WHERE normalized_domain IS NOT NULL;

CREATE INDEX idx_companies_pipeline_stage ON companies (pipeline_stage);

-- ---------------------------------------------------------------------------
-- website_audits (AUDIT)
-- ---------------------------------------------------------------------------
CREATE TABLE website_audits (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url                     TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending', -- pending|completed|failed
  pagespeed_mobile_score  INTEGER,
  pagespeed_desktop_score INTEGER,
  core_web_vitals         JSONB,
  pages_crawled           JSONB,
  crawl_signals           JSONB, -- e.g. has_ssl, has_contact_form, cms_guess, word_count
  raw_pagespeed_response  JSONB,
  error                   TEXT,
  crawled_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

-- ---------------------------------------------------------------------------
-- qualifications (QUALIFY)
-- ---------------------------------------------------------------------------
CREATE TABLE qualifications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deterministic_passed  BOOLEAN NOT NULL,
  deterministic_flags   JSONB NOT NULL DEFAULT '{}',
  ai_qualified          BOOLEAN,
  ai_tier                TEXT, -- hot|warm|cold|disqualified
  ai_reasoning          TEXT,
  ai_model              TEXT,
  ai_response_raw       JSONB,
  decided_by            TEXT NOT NULL, -- rules_only | rules_and_ai
  final_qualified       BOOLEAN NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

-- ---------------------------------------------------------------------------
-- contacts (FIND DECISION MAKER, ENRICH)
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  apollo_person_id    TEXT UNIQUE,
  full_name           TEXT,
  first_name          TEXT,
  last_name           TEXT,
  title               TEXT,
  email               TEXT,
  email_normalized    TEXT,
  phone               TEXT,
  linkedin_url        TEXT,
  is_decision_maker   BOOLEAN NOT NULL DEFAULT false,
  source              TEXT NOT NULL DEFAULT 'apollo',
  pipeline_stage      TEXT NOT NULL DEFAULT 'discovered',
  verification_status TEXT NOT NULL DEFAULT 'unverified', -- unverified|valid|invalid|risky|unknown
  verification_checked_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_contacts_company_email
  ON contacts (company_id, email_normalized)
  WHERE email_normalized IS NOT NULL;

CREATE INDEX idx_contacts_company_id ON contacts (company_id);
CREATE INDEX idx_contacts_email_normalized ON contacts (email_normalized);

-- ---------------------------------------------------------------------------
-- email_verifications (VERIFY) - append-only history
-- ---------------------------------------------------------------------------
CREATE TABLE email_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  result          TEXT NOT NULL, -- valid|invalid|risky|unknown
  provider        TEXT NOT NULL,
  raw_response    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verifications_contact_id ON email_verifications (contact_id);

-- ---------------------------------------------------------------------------
-- suppressions - GLOBAL across all campaigns (unsubscribe, bounce, legal, manual)
-- ---------------------------------------------------------------------------
CREATE TABLE suppressions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized  TEXT NOT NULL UNIQUE,
  reason            TEXT NOT NULL, -- unsubscribed|bounced|manual|legal|complaint|hostile
  source            TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  instantly_campaign_id TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- messages (PERSONALIZE, SEND, FOLLOW UP) - outbound, hard idempotency via dedup_key
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id           UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  stage                 TEXT NOT NULL, -- initial|followup_1|followup_2|...
  dedup_key             TEXT NOT NULL UNIQUE,
  subject               TEXT,
  body                  TEXT,
  personalization_data  JSONB,
  ai_model              TEXT,
  instantly_message_id  TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'queued', -- queued|sent|failed|skipped_suppressed|skipped_unverified
  skip_reason           TEXT,
  sent_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, stage)
);

CREATE INDEX idx_messages_contact_id ON messages (contact_id);
CREATE INDEX idx_messages_status ON messages (status);

-- ---------------------------------------------------------------------------
-- replies (PROCESS REPLY)
-- ---------------------------------------------------------------------------
CREATE TABLE replies (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          UUID REFERENCES messages(id) ON DELETE SET NULL,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'instantly',
  provider_event_id   TEXT NOT NULL,
  raw_payload         JSONB,
  body                TEXT,
  intent              TEXT, -- interested|not_interested|question|unsubscribe|legal_compliance|hostile|auto_reply|other
  intent_confidence   NUMERIC,
  intent_raw          JSONB,
  requires_human      BOOLEAN NOT NULL DEFAULT false,
  auto_reply_sent     BOOLEAN NOT NULL DEFAULT false,
  auto_reply_body     TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX idx_replies_contact_id ON replies (contact_id);

-- ---------------------------------------------------------------------------
-- bookings (BOOK)
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  calendly_event_uri    TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|canceled|completed
  scheduled_at          TIMESTAMPTZ,
  raw_payload           JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_contact_id ON bookings (contact_id);

-- ---------------------------------------------------------------------------
-- webhook_events - generic inbound-webhook idempotency ledger
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source              TEXT NOT NULL, -- instantly|calendly
  external_event_id   TEXT NOT NULL,
  payload             JSONB,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_event_id)
);

-- ---------------------------------------------------------------------------
-- state_transitions - audit log for ALL significant state transitions
-- ---------------------------------------------------------------------------
CREATE TABLE state_transitions (
  id            BIGSERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL, -- company|contact|message|reply|booking
  entity_id     UUID NOT NULL,
  stage         TEXT NOT NULL, -- lifecycle stage name
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  actor         TEXT NOT NULL DEFAULT 'system', -- system|ai|n8n|webhook|human
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_state_transitions_entity ON state_transitions (entity_type, entity_id);
CREATE INDEX idx_state_transitions_stage ON state_transitions (stage);

-- ---------------------------------------------------------------------------
-- api_call_log - external API call outcomes, backs circuit breakers & analytics
-- ---------------------------------------------------------------------------
CREATE TABLE api_call_log (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL, -- google_places|pagespeed|apollo|email_verification|instantly|openai|calendly
  endpoint      TEXT,
  outcome       TEXT NOT NULL, -- success|failure
  http_status   INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 1,
  latency_ms    INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_call_log_provider_created ON api_call_log (provider, created_at DESC);

-- ---------------------------------------------------------------------------
-- idempotency_keys - generic operation-level idempotency ledger
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  operation     TEXT NOT NULL,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ
);
