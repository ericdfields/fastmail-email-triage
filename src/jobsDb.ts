import { getPool } from "./db.js";
import { normalizeCompany, parseProfile } from "./jobs.js";
import type { Connection, JobProfile, JobRules, JobVerdict, RuledJob, ScoringExample } from "./jobs.js";

// --- Schema ---

/** Create the job-alert tables. Every statement is idempotent; mirrored in db/schema.sql. */
export async function ensureJobTables(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_profiles (
      version      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      profile_text TEXT NOT NULL,
      rules        JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
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
    )
  `);
  await pool.query(`
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
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_sightings (
      job_id    BIGINT NOT NULL REFERENCES jobs(job_id),
      email_id  TEXT NOT NULL,
      source    TEXT,
      url       TEXT,
      seen_at   TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (job_id, email_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_decisions (
      job_id     BIGINT PRIMARY KEY REFERENCES jobs(job_id),
      decision   TEXT NOT NULL CHECK (decision IN ('yay', 'nay')),
      note       TEXT,
      decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_research (
      company_key   TEXT PRIMARY KEY,
      company       TEXT NOT NULL,
      research      JSONB NOT NULL,
      researched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
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
    )
  `);
  await pool.query(`
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
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_pipeline (
      company_key TEXT PRIMARY KEY,
      company     TEXT NOT NULL,
      stage       TEXT,
      active      BOOLEAN NOT NULL DEFAULT true,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS jobs_company_key_idx ON jobs (company_key)");
  await pool.query("CREATE INDEX IF NOT EXISTS jobs_last_seen_idx ON jobs (last_seen_at DESC)");
  await pool.query("CREATE INDEX IF NOT EXISTS linkedin_connections_company_idx ON linkedin_connections (company_key)");
  await pool.query("CREATE INDEX IF NOT EXISTS job_research_status_idx ON job_research (status)");
}

// --- Profile ---

export async function saveJobProfile(markdown: string): Promise<number> {
  const { text, rules } = parseProfile(markdown);
  const result = await getPool().query<{ version: number }>(
    "INSERT INTO job_profiles (profile_text, rules) VALUES ($1, $2) RETURNING version",
    [text, JSON.stringify(rules)]
  );
  return result.rows[0]!.version;
}

export async function getLatestJobProfile(): Promise<JobProfile | null> {
  const result = await getPool().query<{ version: number; profile_text: string; rules: JobRules }>(
    "SELECT version, profile_text, rules FROM job_profiles ORDER BY version DESC LIMIT 1"
  );
  const row = result.rows[0];
  return row ? { version: row.version, text: row.profile_text, rules: row.rules } : null;
}

// --- Alert emails ---

export const MAX_ALERT_ATTEMPTS = 3;

/** Alert emails that need no more work: processed, or failed too many times. */
export async function getSettledAlertEmailIds(emailIds: string[]): Promise<Set<string>> {
  if (emailIds.length === 0) return new Set();
  const result = await getPool().query<{ email_id: string }>(
    `SELECT email_id FROM job_alert_emails
     WHERE email_id = ANY($1::text[])
       AND (status = 'processed' OR attempts >= $2)`,
    [emailIds, MAX_ALERT_ATTEMPTS]
  );
  return new Set(result.rows.map((row) => row.email_id));
}

export async function recordAlertEmail(alert: {
  emailId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  status: "processed" | "failed";
  jobsFound: number;
  profileVersion: number;
  error?: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO job_alert_emails
       (email_id, sender, subject, received_at, status, jobs_found, profile_version, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (email_id) DO UPDATE
     SET status = EXCLUDED.status, jobs_found = EXCLUDED.jobs_found,
         profile_version = EXCLUDED.profile_version, error = EXCLUDED.error,
         attempts = job_alert_emails.attempts + 1, processed_at = now()`,
    [
      alert.emailId,
      alert.sender,
      alert.subject,
      alert.receivedAt,
      alert.status,
      alert.jobsFound,
      alert.profileVersion,
      alert.error?.slice(0, 500) ?? null,
    ]
  );
}

// --- Company context ---

export interface CompanyContext {
  warm: Map<string, string[]>;
  pipeline: Set<string>;
}

/** Warm connections and in-flight applications, keyed by normalized company. */
export async function getCompanyContext(companyKeys: string[]): Promise<CompanyContext> {
  const keys = [...new Set(companyKeys.filter(Boolean))];
  if (keys.length === 0) return { warm: new Map(), pipeline: new Set() };

  const pool = getPool();
  const warm = await pool.query<{ company_key: string; name: string; position: string | null }>(
    `SELECT company_key, trim(first_name || ' ' || last_name) AS name, position
     FROM linkedin_connections
     WHERE company_key = ANY($1::text[])
     ORDER BY connected_on DESC NULLS LAST`,
    [keys]
  );
  const pipeline = await pool.query<{ company_key: string }>(
    "SELECT company_key FROM active_pipeline WHERE active AND company_key = ANY($1::text[])",
    [keys]
  );

  const warmMap = new Map<string, string[]>();
  for (const row of warm.rows) {
    const list = warmMap.get(row.company_key) ?? [];
    list.push(row.position ? `${row.name} (${row.position})` : row.name);
    warmMap.set(row.company_key, list);
  }
  return { warm: warmMap, pipeline: new Set(pipeline.rows.map((row) => row.company_key)) };
}

// --- Jobs ---

/** Look up already-scored jobs so repeats become sightings rather than new model calls. */
export async function findJobIdsByKey(keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const result = await getPool().query<{ job_key: string; job_id: string }>(
    "SELECT job_key, job_id::text FROM jobs WHERE job_key = ANY($1::text[])",
    [keys]
  );
  return new Map(result.rows.map((row) => [row.job_key, Number(row.job_id)]));
}

export async function insertJob(
  key: string,
  job: RuledJob,
  model: string,
  profileVersion: number,
  seenAt: string
): Promise<number> {
  const result = await getPool().query<{ job_id: string }>(
    `INSERT INTO jobs
       (job_key, title, company, company_key, location, workplace, salary_min, salary_max,
        source, url, model_verdict, verdict, decided_by, fit_score, reason, model,
        profile_version, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
     ON CONFLICT (job_key) DO UPDATE SET last_seen_at = GREATEST(jobs.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING job_id::text`,
    [
      key,
      job.title,
      job.company,
      normalizeCompany(job.company),
      job.location,
      job.workplace,
      job.salaryMin,
      job.salaryMax,
      job.source,
      job.url,
      job.modelVerdict,
      job.verdict,
      job.decidedBy,
      job.fitScore,
      job.reason,
      model,
      profileVersion,
      seenAt,
    ]
  );
  return Number(result.rows[0]!.job_id);
}

/** Record that an alert listed a job. Repeat listings bump the count once per email. */
export async function recordSighting(
  jobId: number,
  emailId: string,
  source: string | null,
  url: string | null,
  seenAt: string
): Promise<void> {
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO job_sightings (job_id, email_id, source, url, seen_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, email_id) DO NOTHING`,
    [jobId, emailId, source, url, seenAt]
  );
  if (inserted.rowCount === 0) return;
  await pool.query(
    `UPDATE jobs
     SET sighting_count = (SELECT COUNT(*) FROM job_sightings WHERE job_id = $1),
         last_seen_at = GREATEST(last_seen_at, $2),
         url = COALESCE(url, $3),
         source = COALESCE(source, $4)
     WHERE job_id = $1`,
    [jobId, seenAt, url, source]
  );
}

export type JobView = "review" | "yay" | "nay" | "in-process" | "passed";

export const JOB_VIEWS: JobView[] = ["review", "yay", "nay", "in-process", "passed"];

export interface JobRow {
  jobId: number;
  title: string;
  company: string;
  location: string | null;
  workplace: string;
  salaryMin: number | null;
  salaryMax: number | null;
  source: string | null;
  url: string | null;
  verdict: JobVerdict;
  modelVerdict: JobVerdict;
  decidedBy: string;
  fitScore: number;
  reason: string;
  profileVersion: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sightingCount: number;
  decision: "yay" | "nay" | null;
  decisionNote: string | null;
  inPipeline: boolean;
  warmConnections: string[];
  research: {
    status: string;
    posting: unknown;
    outreachDraft: string | null;
    warnings: string[];
    error: string | null;
    completedAt: string | null;
    company: unknown;
  } | null;
}

const VIEW_FILTERS: Record<JobView, string> = {
  review: "d.job_id IS NULL AND NOT in_pipeline AND j.verdict IN ('yay', 'maybe')",
  nay: "d.job_id IS NULL AND NOT in_pipeline AND j.verdict = 'nay'",
  "in-process": "d.job_id IS NULL AND in_pipeline",
  yay: "d.decision = 'yay'",
  passed: "d.decision = 'nay'",
};

const VIEW_ORDER: Record<JobView, string> = {
  review: "CASE j.verdict WHEN 'yay' THEN 0 ELSE 1 END, j.fit_score DESC, j.last_seen_at DESC",
  nay: "j.last_seen_at DESC",
  "in-process": "j.last_seen_at DESC",
  yay: "d.decided_at DESC",
  passed: "d.decided_at DESC",
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function getJobs(view: JobView, limit: number = 50, offset: number = 0): Promise<JobRow[]> {
  const result = await getPool().query<Record<string, any>>(
    `WITH base AS (
       SELECT j.*,
              EXISTS (
                SELECT 1 FROM active_pipeline ap WHERE ap.active AND ap.company_key = j.company_key
              ) AS in_pipeline
       FROM jobs j
     )
     SELECT j.*, d.decision, d.note AS decision_note,
            r.status AS research_status, r.posting, r.outreach_draft, r.warnings,
            r.error AS research_error, r.completed_at AS research_completed_at,
            cr.research AS company_research,
            COALESCE((
              SELECT array_agg(trim(lc.first_name || ' ' || lc.last_name)
                               || COALESCE(' (' || lc.position || ')', '')
                               ORDER BY lc.connected_on DESC NULLS LAST)
              FROM linkedin_connections lc WHERE lc.company_key = j.company_key
            ), '{}') AS warm_connections
     FROM base j
     LEFT JOIN job_decisions d ON d.job_id = j.job_id
     LEFT JOIN job_research r ON r.job_id = j.job_id
     LEFT JOIN company_research cr ON cr.company_key = j.company_key AND r.status IN ('done', 'closed')
     WHERE ${VIEW_FILTERS[view]}
     ORDER BY ${VIEW_ORDER[view]}
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map((row) => ({
    jobId: Number(row.job_id),
    title: row.title,
    company: row.company,
    location: row.location,
    workplace: row.workplace,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    source: row.source,
    url: row.url,
    verdict: row.verdict,
    modelVerdict: row.model_verdict,
    decidedBy: row.decided_by,
    fitScore: row.fit_score,
    reason: row.reason,
    profileVersion: row.profile_version,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    sightingCount: row.sighting_count,
    decision: row.decision ?? null,
    decisionNote: row.decision_note ?? null,
    inPipeline: row.in_pipeline,
    warmConnections: row.warm_connections ?? [],
    research: row.research_status
      ? {
          status: row.research_status,
          posting: row.posting ?? null,
          outreachDraft: row.outreach_draft ?? null,
          warnings: row.warnings ?? [],
          error: row.research_error ?? null,
          completedAt: row.research_completed_at ? iso(row.research_completed_at) : null,
          company: row.company_research ?? null,
        }
      : null,
  }));
}

export async function getJobCounts(): Promise<Record<JobView, number>> {
  const result = await getPool().query<Record<JobView, string>>(
    `WITH base AS (
       SELECT j.verdict, d.decision,
              EXISTS (
                SELECT 1 FROM active_pipeline ap WHERE ap.active AND ap.company_key = j.company_key
              ) AS in_pipeline
       FROM jobs j LEFT JOIN job_decisions d ON d.job_id = j.job_id
     )
     SELECT
       COUNT(*) FILTER (WHERE decision IS NULL AND NOT in_pipeline AND verdict IN ('yay', 'maybe'))::text AS review,
       COUNT(*) FILTER (WHERE decision IS NULL AND NOT in_pipeline AND verdict = 'nay')::text AS nay,
       COUNT(*) FILTER (WHERE decision IS NULL AND in_pipeline)::text AS "in-process",
       COUNT(*) FILTER (WHERE decision = 'yay')::text AS yay,
       COUNT(*) FILTER (WHERE decision = 'nay')::text AS passed
     FROM base`
  );
  const row = result.rows[0]!;
  return Object.fromEntries(JOB_VIEWS.map((view) => [view, parseInt(row[view] ?? "0")])) as Record<JobView, number>;
}

/**
 * Record the candidate's yay or nay. A yay queues research; a later nay cancels research
 * that has not started.
 */
export async function recordJobDecision(jobId: number, decision: "yay" | "nay", note?: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO job_decisions (job_id, decision, note)
     SELECT job_id, $2::text, $3::text FROM jobs WHERE job_id = $1
     ON CONFLICT (job_id) DO UPDATE
     SET decision = EXCLUDED.decision, note = COALESCE(EXCLUDED.note, job_decisions.note), decided_at = now()`,
    [jobId, decision, note?.slice(0, 500) ?? null]
  );
  if (result.rowCount === 0) return false;

  if (decision === "yay") {
    await pool.query(
      `INSERT INTO job_research (job_id, status) VALUES ($1, 'pending')
       ON CONFLICT (job_id) DO NOTHING`,
      [jobId]
    );
  } else {
    await pool.query("DELETE FROM job_research WHERE job_id = $1 AND status = 'pending'", [jobId]);
  }
  return true;
}

export async function retryJobResearch(jobId: number): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE job_research
     SET status = 'pending', error = NULL, requested_at = now(), started_at = NULL, completed_at = NULL
     WHERE job_id = $1 AND status IN ('failed', 'done', 'closed')`,
    [jobId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Decisions that overruled the screen, newest first. These become prompt examples. */
export async function getScoringExamples(limit: number = 20): Promise<ScoringExample[]> {
  const result = await getPool().query<{
    title: string;
    company: string;
    verdict: JobVerdict;
    decision: "yay" | "nay";
    note: string | null;
  }>(
    `SELECT j.title, j.company, j.verdict, d.decision, d.note
     FROM job_decisions d
     JOIN jobs j ON j.job_id = d.job_id
     WHERE d.decision::text <> j.verdict
     ORDER BY d.decided_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    title: row.title,
    company: row.company,
    modelVerdict: row.verdict,
    decision: row.decision,
    note: row.note,
  }));
}

// --- Research ---

export interface ResearchJob {
  jobId: number;
  title: string;
  company: string;
  companyKey: string;
  location: string | null;
  workplace: string;
  url: string | null;
  reason: string;
  decisionNote: string | null;
}

/** Claim pending research, and research stuck in `running` for over 15 minutes. */
export async function claimResearch(limit: number): Promise<ResearchJob[]> {
  const result = await getPool().query<Record<string, any>>(
    `WITH claimed AS (
       UPDATE job_research
       SET status = 'running', started_at = now(), error = NULL
       WHERE job_id IN (
         SELECT job_id FROM job_research
         WHERE status = 'pending'
            OR (status = 'running' AND started_at < now() - interval '15 minutes')
         ORDER BY requested_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING job_id
     )
     SELECT j.job_id, j.title, j.company, j.company_key, j.location, j.workplace, j.url, j.reason,
            d.note AS decision_note
     FROM claimed c
     JOIN jobs j ON j.job_id = c.job_id
     LEFT JOIN job_decisions d ON d.job_id = j.job_id`,
    [limit]
  );
  return result.rows.map((row) => ({
    jobId: Number(row.job_id),
    title: row.title,
    company: row.company,
    companyKey: row.company_key,
    location: row.location,
    workplace: row.workplace,
    url: row.url,
    reason: row.reason,
    decisionNote: row.decision_note,
  }));
}

export async function getCompanyResearch(companyKey: string, maxAgeDays: number): Promise<unknown | null> {
  const result = await getPool().query<{ research: unknown }>(
    `SELECT research FROM company_research
     WHERE company_key = $1 AND researched_at >= now() - make_interval(days => $2)`,
    [companyKey, maxAgeDays]
  );
  return result.rows[0]?.research ?? null;
}

export async function saveCompanyResearch(companyKey: string, company: string, research: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO company_research (company_key, company, research)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_key) DO UPDATE
     SET company = EXCLUDED.company, research = EXCLUDED.research, researched_at = now()`,
    [companyKey, company, JSON.stringify(research)]
  );
}

export async function finishResearch(
  jobId: number,
  outcome: {
    status: "done" | "closed" | "failed";
    posting?: unknown;
    outreachDraft?: string | null;
    warnings?: string[];
    error?: string;
  }
): Promise<void> {
  await getPool().query(
    `UPDATE job_research
     SET status = $2, posting = $3, outreach_draft = $4, warnings = $5, error = $6, completed_at = now()
     WHERE job_id = $1`,
    [
      jobId,
      outcome.status,
      outcome.posting === undefined ? null : JSON.stringify(outcome.posting),
      outcome.outreachDraft ?? null,
      JSON.stringify(outcome.warnings ?? []),
      outcome.error?.slice(0, 500) ?? null,
    ]
  );
}

// --- Connections and pipeline ---

export async function importConnections(connections: Connection[]): Promise<number> {
  const pool = getPool();
  let imported = 0;
  for (let start = 0; start < connections.length; start += 200) {
    const chunk = connections.slice(start, start + 200);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((connection, index) => {
      const i = index * 7;
      values.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7})`);
      params.push(
        connection.firstName,
        connection.lastName,
        connection.company,
        normalizeCompany(connection.company),
        connection.position,
        connection.profileUrl,
        connection.connectedOn
      );
    });
    const result = await pool.query(
      `INSERT INTO linkedin_connections
         (first_name, last_name, company, company_key, position, profile_url, connected_on)
       VALUES ${values.join(", ")}
       ON CONFLICT (first_name, last_name, company_key) DO UPDATE
       SET company = EXCLUDED.company, position = EXCLUDED.position,
           profile_url = EXCLUDED.profile_url, connected_on = EXCLUDED.connected_on, imported_at = now()`,
      params
    );
    imported += result.rowCount ?? 0;
  }
  return imported;
}

export async function setPipelineCompany(company: string, active: boolean, stage?: string): Promise<void> {
  await getPool().query(
    `INSERT INTO active_pipeline (company_key, company, stage, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_key) DO UPDATE
     SET company = EXCLUDED.company, stage = COALESCE(EXCLUDED.stage, active_pipeline.stage),
         active = EXCLUDED.active, updated_at = now()`,
    [normalizeCompany(company), company, stage ?? null, active]
  );
}

export async function listPipeline(): Promise<Array<{ company: string; stage: string | null; active: boolean }>> {
  const result = await getPool().query<{ company: string; stage: string | null; active: boolean }>(
    "SELECT company, stage, active FROM active_pipeline ORDER BY active DESC, updated_at DESC"
  );
  return result.rows;
}

/** Screen verdicts against the candidate's decisions, per profile version. */
export async function getJobStats() {
  const result = await getPool().query<{
    profile_version: number;
    verdict: JobVerdict;
    total: string;
    said_yay: string;
    said_nay: string;
  }>(
    `SELECT j.profile_version, j.verdict,
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE d.decision = 'yay')::text AS said_yay,
            COUNT(*) FILTER (WHERE d.decision = 'nay')::text AS said_nay
     FROM jobs j
     LEFT JOIN job_decisions d ON d.job_id = j.job_id
     GROUP BY j.profile_version, j.verdict
     ORDER BY j.profile_version, j.verdict`
  );
  return result.rows.map((row) => ({
    profileVersion: row.profile_version,
    verdict: row.verdict,
    total: parseInt(row.total),
    saidYay: parseInt(row.said_yay),
    saidNay: parseInt(row.said_nay),
  }));
}

/** Put claimed research back in the queue, for example when the daily budget runs out. */
export async function releaseResearch(jobId: number): Promise<void> {
  await getPool().query(
    "UPDATE job_research SET status = 'pending', started_at = NULL WHERE job_id = $1 AND status = 'running'",
    [jobId]
  );
}
