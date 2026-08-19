-- Milestone 11: a single-row table backing a runtime "kill switch" for all
-- outbound sending (initial messages, follow-ups, and safe automated
-- replies) that is independent of the static DRY_RUN_SENDING/
-- MOCK_EXTERNAL_APIS env flags -- an operator or an automated safety check
-- (see src/domain/safety/safetyService.ts) can pause sending without a
-- redeploy, and every pause/resume is itself a logged state transition.
CREATE TABLE safety_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sending_paused  BOOLEAN NOT NULL DEFAULT false,
  paused_reason   TEXT,
  paused_at       TIMESTAMPTZ,
  resumed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO safety_state (id, sending_paused) VALUES (1, false);
