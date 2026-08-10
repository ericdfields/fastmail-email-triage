-- Fastmail Email Triage — full database schema.
--
-- Bootstrap a fresh database with:
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- Safe to re-run: every statement is idempotent.
--
-- Note: `corrections`, `attention_actions`, and `unsubscribe_actions` are also created on demand at
-- runtime (ensureCorrectionsTable / ensureAttentionActionsTable in src/db.ts).
-- `triage_runs` and `classifications` are NOT — they must exist before the
-- first `npm run triage`, which is what this file is for.

-- Tier enum — mirrors the `Tier` union in src/types.ts.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tier') THEN
    CREATE TYPE tier AS ENUM ('auto-delete', 'auto-archive', 'confirm', 'attention');
  END IF;
END
$$;

-- One row per triage invocation. `completed_at IS NULL` marks a run that
-- crashed mid-flight; the next run detects and resumes it.
CREATE TABLE IF NOT EXISTS triage_runs (
  run_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  total_processed INTEGER NOT NULL DEFAULT 0
);

-- One row per (email, run). `acted_at` is stamped only after the JMAP action
-- succeeds, so a crash between classify and act is recoverable.
CREATE TABLE IF NOT EXISTS classifications (
  email_id             TEXT NOT NULL,
  run_id               BIGINT NOT NULL REFERENCES triage_runs(run_id),
  subject              TEXT NOT NULL,
  sender               TEXT NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL,
  tier                 tier NOT NULL,
  reason               TEXT NOT NULL,
  has_list_unsubscribe BOOLEAN NOT NULL DEFAULT false,
  classified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at             TIMESTAMPTZ,
  PRIMARY KEY (email_id, run_id)
);

-- Human corrections to a classification. Each correction also becomes an exact-sender
-- rule so later messages from that sender bypass the model.
CREATE TABLE IF NOT EXISTS corrections (
  correction_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id       TEXT NOT NULL,
  run_id         BIGINT NOT NULL,
  original_tier  tier NOT NULL,
  corrected_tier tier NOT NULL,
  corrected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id),
  UNIQUE (email_id, run_id)
);

-- Tracks which attention-tier emails have been dealt with (or snoozed).
-- Drives the attention queue in `npm run act` and the web UI's Attention tab:
-- an email leaves the queue once it has a row here that isn't a live snooze.
CREATE TABLE IF NOT EXISTS attention_actions (
  action_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id      TEXT NOT NULL,
  run_id        BIGINT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('acted', 'snoozed')),
  note          TEXT,
  snoozed_until TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id),
  UNIQUE (email_id, run_id)
);

-- Exact sender decisions learned from explicit human corrections. These rules bypass
-- model calls for future messages from the same normalized sender string.
CREATE TABLE IF NOT EXISTS sender_rules (
  sender      TEXT PRIMARY KEY,
  tier        tier NOT NULL,
  source      TEXT NOT NULL DEFAULT 'correction',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per OpenRouter attempt. Used for the daily budget circuit breaker and
-- operational visibility into tokens, cache hits, latency, and provider failures.
CREATE TABLE IF NOT EXISTS model_calls (
  model_call_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id             BIGINT NOT NULL REFERENCES triage_runs(run_id),
  model              TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  batch_size         INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 8) NOT NULL DEFAULT 0,
  latency_ms         INTEGER NOT NULL,
  error_type         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human-authorized unsubscribe decisions and the outcome of each one-click request.
-- Full unsubscribe URLs are deliberately not retained because they often contain tokens.
CREATE TABLE IF NOT EXISTS unsubscribe_actions (
  action_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender         TEXT NOT NULL,
  email_id       TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('one-click', 'keep')),
  method         TEXT NOT NULL,
  target_host    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  http_status    INTEGER,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

-- Hot paths: the attention queue and the review list both scan by tier and
-- order by recency.
CREATE INDEX IF NOT EXISTS classifications_tier_idx ON classifications (tier);
CREATE INDEX IF NOT EXISTS classifications_received_at_idx ON classifications (received_at DESC);
CREATE INDEX IF NOT EXISTS classifications_email_classified_idx ON classifications (email_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_created_at_idx ON model_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS unsubscribe_actions_sender_idx ON unsubscribe_actions (sender, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS unsubscribe_actions_active_sender_idx
  ON unsubscribe_actions (sender)
  WHERE status IN ('pending', 'success');
CREATE INDEX IF NOT EXISTS classifications_unsubscribe_sender_idx
  ON classifications (sender, received_at DESC)
  WHERE has_list_unsubscribe = true;
CREATE INDEX IF NOT EXISTS classifications_success_email_idx
  ON classifications (email_id)
  WHERE reason <> 'Classification failed — defaulting to confirm';
