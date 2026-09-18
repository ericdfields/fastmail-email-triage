-- Fastmail Email Triage — full database schema.
--
-- Bootstrap a fresh database with:
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- Safe to re-run: every statement is idempotent.
--
-- Note: `corrections`, `attention_actions`, `unsubscribe_actions`, and the job tables are also created on demand at
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

-- --- Job alerts -------------------------------------------------------------
-- Created at runtime by ensureJobTables() in src/jobsDb.ts; mirrored here.

-- Job-alert model calls run outside triage runs and have their own budget.
-- (ensureOptimizationTables applies this to existing databases.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'model_calls' AND column_name = 'purpose'
  ) THEN
    ALTER TABLE model_calls
      ADD COLUMN purpose TEXT NOT NULL DEFAULT 'triage',
      ALTER COLUMN run_id DROP NOT NULL;
  END IF;
END
$$;

-- Versioned private job profile. Never stored in the repo.
CREATE TABLE IF NOT EXISTS job_profiles (
  version      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_text TEXT NOT NULL,
  rules        JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per job-alert email handled. Failed rows retry up to three attempts.
CREATE TABLE IF NOT EXISTS job_alert_emails (
  email_id        TEXT PRIMARY KEY,
  sender          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('processed', 'failed')),
  jobs_found      INTEGER NOT NULL DEFAULT 0,
  profile_version INTEGER REFERENCES job_profiles(version),
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per distinct role (normalized company + title). `verdict` is the screen's
-- final call after hard rules; `model_verdict` is what the model said.
CREATE TABLE IF NOT EXISTS jobs (
  job_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_key         TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  company         TEXT NOT NULL,
  company_key     TEXT NOT NULL,
  location        TEXT,
  workplace       TEXT NOT NULL,
  salary_min      INTEGER,
  salary_max      INTEGER,
  source          TEXT,
  url             TEXT,
  model_verdict   TEXT NOT NULL CHECK (model_verdict IN ('yay', 'maybe', 'nay')),
  verdict         TEXT NOT NULL CHECK (verdict IN ('yay', 'maybe', 'nay')),
  decided_by      TEXT NOT NULL,
  fit_score       INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  model           TEXT NOT NULL,
  profile_version INTEGER NOT NULL REFERENCES job_profiles(version),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sighting_count  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS job_sightings (
  job_id    BIGINT NOT NULL REFERENCES jobs(job_id),
  email_id  TEXT NOT NULL,
  source    TEXT,
  url       TEXT,
  seen_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, email_id)
);

-- The candidate's yay or nay. Decisions that overrule the screen feed the scoring prompt.
CREATE TABLE IF NOT EXISTS job_decisions (
  job_id     BIGINT PRIMARY KEY REFERENCES jobs(job_id),
  decision   TEXT NOT NULL CHECK (decision IN ('yay', 'nay')),
  note       TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Company research shared by every job at that company; reused for 30 days.
CREATE TABLE IF NOT EXISTS company_research (
  company_key   TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  research      JSONB NOT NULL,
  researched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_research (
  job_id         BIGINT PRIMARY KEY REFERENCES jobs(job_id),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'closed', 'failed')),
  posting        JSONB,
  outreach_draft TEXT,
  warnings       JSONB NOT NULL DEFAULT '[]',
  error          TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

-- Imported from LinkedIn's own Connections.csv export; used for warm-path matching.
CREATE TABLE IF NOT EXISTS linkedin_connections (
  connection_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  company       TEXT NOT NULL,
  company_key   TEXT NOT NULL,
  position      TEXT,
  profile_url   TEXT,
  connected_on  DATE,
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (first_name, last_name, company_key)
);

-- Companies with an application or conversation in flight. Their alerts are shown
-- as "in process" instead of being queued for review.
CREATE TABLE IF NOT EXISTS active_pipeline (
  company_key TEXT PRIMARY KEY,
  company     TEXT NOT NULL,
  stage       TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_company_key_idx ON jobs (company_key);
CREATE INDEX IF NOT EXISTS jobs_last_seen_idx ON jobs (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS linkedin_connections_company_idx ON linkedin_connections (company_key);
CREATE INDEX IF NOT EXISTS job_research_status_idx ON job_research (status);
