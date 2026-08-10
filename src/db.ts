import pg from "pg";
import type { Classification, Tier } from "./types.js";
import type { ModelAttempt } from "./classifier.js";
import { normalizeSender } from "./routing.js";

const { Pool } = pg;

let pool: pg.Pool;

export function initDb() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
}

export async function closeDb() {
  await pool.end();
}

/** Create a new run and return its ID. */
export async function createRun(): Promise<number> {
  const result = await pool.query<{ run_id: number }>(
    "INSERT INTO triage_runs DEFAULT VALUES RETURNING run_id"
  );
  return result.rows[0]!.run_id;
}

/** Find the latest run that was never completed (no completed_at). */
export async function findIncompleteRun(): Promise<{
  runId: number;
  classifications: Classification[];
  alreadyActed: Set<string>;
} | null> {
  const runResult = await pool.query<{ run_id: number }>(
    "SELECT run_id FROM triage_runs WHERE completed_at IS NULL ORDER BY started_at DESC LIMIT 1"
  );
  if (runResult.rows.length === 0) return null;

  const runId = runResult.rows[0]!.run_id;

  const classResult = await pool.query<{
    email_id: string;
    subject: string;
    sender: string;
    received_at: string;
    tier: Tier;
    reason: string;
    has_list_unsubscribe: boolean;
    acted_at: string | null;
  }>(
    `SELECT email_id, subject, sender, received_at, tier, reason, has_list_unsubscribe, acted_at
     FROM classifications
     WHERE run_id = $1
       AND reason <> 'Classification failed — defaulting to confirm'`,
    [runId]
  );

  const classifications: Classification[] = [];
  const alreadyActed = new Set<string>();

  for (const r of classResult.rows) {
    classifications.push({
      emailId: r.email_id,
      subject: r.subject,
      from: r.sender,
      receivedAt: r.received_at,
      tier: r.tier,
      reason: r.reason,
      hasListUnsubscribe: r.has_list_unsubscribe,
    });
    if (r.acted_at !== null) {
      alreadyActed.add(r.email_id);
    }
  }

  return { runId, classifications, alreadyActed };
}

/** Insert a batch of classifications. */
export async function insertClassifications(
  runId: number,
  classifications: Classification[]
) {
  if (classifications.length === 0) return;

  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  for (const c of classifications) {
    values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7})`);
    params.push(c.emailId, runId, c.subject, c.from, c.receivedAt, c.tier, c.reason, c.hasListUnsubscribe);
    i += 8;
  }

  await pool.query(
    `INSERT INTO classifications (email_id, run_id, subject, sender, received_at, tier, reason, has_list_unsubscribe)
     VALUES ${values.join(", ")}
     ON CONFLICT (email_id, run_id) DO NOTHING`,
    params
  );
}

/** Stamp acted_at for successfully acted emails. */
export async function markActionsApplied(runId: number, emailIds: string[]) {
  if (emailIds.length === 0) return;

  const placeholders = emailIds.map((_, i) => `$${i + 2}`).join(", ");
  await pool.query(
    `UPDATE classifications SET acted_at = now() WHERE run_id = $1 AND email_id IN (${placeholders})`,
    [runId, ...emailIds]
  );
}

/** Mark a run as completed and set the total count. */
export async function completeRun(runId: number, totalProcessed: number) {
  await pool.query(
    "UPDATE triage_runs SET completed_at = now(), total_processed = $1 WHERE run_id = $2",
    [totalProcessed, runId]
  );
}

/** Get summary stats for a run. */
export async function getRunSummary(runId: number) {
  const counts = await pool.query<{ tier: Tier; count: string }>(
    "SELECT tier, COUNT(*)::text as count FROM classifications WHERE run_id = $1 GROUP BY tier",
    [runId]
  );

  const topSenders = await pool.query<{
    sender: string;
    count: string;
    tiers: Record<Tier, number>;
  }>(
    `SELECT sender, COUNT(*)::text as count,
       jsonb_build_object(
         'auto-delete', COUNT(*) FILTER (WHERE tier = 'auto-delete'),
         'auto-archive', COUNT(*) FILTER (WHERE tier = 'auto-archive'),
         'confirm', COUNT(*) FILTER (WHERE tier = 'confirm'),
         'attention', COUNT(*) FILTER (WHERE tier = 'attention')
       ) as tiers
     FROM classifications WHERE run_id = $1
     GROUP BY sender ORDER BY COUNT(*) DESC LIMIT 30`,
    [runId]
  );

  return {
    counts: Object.fromEntries(counts.rows.map((r) => [r.tier, parseInt(r.count)])),
    topSenders: topSenders.rows.map((r) => ({
      sender: r.sender,
      count: parseInt(r.count),
      tiers: r.tiers,
    })),
  };
}

// --- Corrections / Accuracy Tracking ---

/** Create the corrections table if it doesn't exist. */
export async function ensureCorrectionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corrections (
      correction_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email_id TEXT NOT NULL,
      run_id BIGINT NOT NULL,
      original_tier tier NOT NULL,
      corrected_tier tier NOT NULL,
      corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id),
      UNIQUE (email_id, run_id)
    )
  `);
}

/** Create token-efficiency tables and migrate existing corrections into exact-sender rules. */
export async function ensureOptimizationTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sender_rules (
      sender      TEXT PRIMARY KEY,
      tier        tier NOT NULL,
      source      TEXT NOT NULL DEFAULT 'correction',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_calls (
      model_call_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id            BIGINT NOT NULL REFERENCES triage_runs(run_id),
      model             TEXT NOT NULL,
      attempt           INTEGER NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('success', 'failed')),
      batch_size        INTEGER NOT NULL,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd          NUMERIC(12, 8) NOT NULL DEFAULT 0,
      latency_ms        INTEGER NOT NULL,
      error_type        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS model_calls_created_at_idx
    ON model_calls (created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS classifications_success_email_idx
    ON classifications (email_id)
    WHERE reason <> 'Classification failed — defaulting to confirm'
  `);

  await pool.query(`
    INSERT INTO sender_rules (sender, tier, source, updated_at)
    SELECT DISTINCT ON (lower(trim(c.sender)))
           lower(trim(c.sender)), cr.corrected_tier, 'correction', cr.corrected_at
    FROM corrections cr
    JOIN classifications c ON cr.email_id = c.email_id AND cr.run_id = c.run_id
    WHERE trim(c.sender) <> ''
    ORDER BY lower(trim(c.sender)), cr.corrected_at DESC
    ON CONFLICT (sender) DO NOTHING
  `);
}

export type UnsubscribeCandidateRow = {
  sender: string;
  emailId: string;
  messageCount: number;
  latestSubject: string;
  recentSubjects: string[];
  lastReceivedAt: string;
};

/** Create the audit table used by the human-authorized unsubscribe workflow. */
export async function ensureUnsubscribeActionsTable(): Promise<void> {
  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS unsubscribe_actions_sender_idx
    ON unsubscribe_actions (sender, created_at DESC)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS unsubscribe_actions_active_sender_idx
    ON unsubscribe_actions (sender)
    WHERE status IN ('pending', 'success')
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS classifications_unsubscribe_sender_idx
    ON classifications (sender, received_at DESC)
    WHERE has_list_unsubscribe = true
  `);
}

/** Group recent List-Unsubscribe mail by exact normalized sender for human review. */
export async function getUnsubscribeCandidates(
  days: number = 90,
  minimumMessages: number = 2,
  limit: number = 100
): Promise<UnsubscribeCandidateRow[]> {
  const result = await pool.query<{
    sender: string;
    email_id: string;
    message_count: string;
    latest_subject: string;
    recent_subjects: string[];
    last_received_at: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (email_id)
         email_id, lower(trim(sender)) AS sender, subject, received_at, classified_at
       FROM classifications
       WHERE has_list_unsubscribe = true
         AND received_at >= now() - make_interval(days => $1)
         AND reason <> 'Classification failed — defaulting to confirm'
       ORDER BY email_id, classified_at DESC
     ), grouped AS (
       SELECT sender,
              (array_agg(email_id ORDER BY received_at DESC))[1] AS email_id,
              COUNT(*)::text AS message_count,
              (array_agg(subject ORDER BY received_at DESC))[1] AS latest_subject,
              (array_agg(subject ORDER BY received_at DESC))[1:3] AS recent_subjects,
              MAX(received_at) AS last_received_at
       FROM latest
       WHERE sender <> ''
       GROUP BY sender
       HAVING COUNT(*) >= $2
     )
     SELECT g.*
     FROM grouped g
     WHERE NOT EXISTS (
       SELECT 1 FROM unsubscribe_actions ua
       WHERE ua.sender = g.sender
         AND (
           ua.status = 'success'
           OR (ua.status = 'pending' AND ua.created_at >= now() - interval '15 minutes')
         )
     )
     ORDER BY g.message_count::bigint DESC, g.last_received_at DESC
     LIMIT $3`,
    [days, minimumMessages, limit]
  );

  return result.rows.map((row) => ({
    sender: row.sender,
    emailId: row.email_id,
    messageCount: parseInt(row.message_count),
    latestSubject: row.latest_subject,
    recentSubjects: row.recent_subjects,
    lastReceivedAt:
      typeof row.last_received_at === "string"
        ? row.last_received_at
        : new Date(row.last_received_at).toISOString(),
  }));
}

export async function startUnsubscribeAction(
  sender: string,
  emailId: string,
  action: "one-click" | "keep",
  method: string,
  targetHost?: string
): Promise<number | null> {
  const result = await pool.query<{ action_id: number }>(
    `WITH expired AS (
       UPDATE unsubscribe_actions
       SET status = 'failed', error = 'Previous attempt interrupted', completed_at = now()
       WHERE sender = $1
         AND status = 'pending'
         AND created_at < now() - interval '15 minutes'
     )
     INSERT INTO unsubscribe_actions
       (sender, email_id, action, method, target_host, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT DO NOTHING
     RETURNING action_id`,
    [normalizeSender(sender), emailId, action, method, targetHost ?? null]
  );
  return result.rows[0]?.action_id ?? null;
}

export async function finishUnsubscribeAction(
  actionId: number,
  status: "success" | "failed",
  httpStatus?: number,
  error?: string
): Promise<void> {
  await pool.query(
    `UPDATE unsubscribe_actions
     SET status = $2, http_status = $3, error = $4, completed_at = now()
     WHERE action_id = $1`,
    [actionId, status, httpStatus ?? null, error?.slice(0, 500) ?? null]
  );
}

export async function keepUnsubscribeSender(sender: string, emailId: string): Promise<void> {
  const actionId = await startUnsubscribeAction(sender, emailId, "keep", "human-review");
  if (actionId !== null) await finishUnsubscribeAction(actionId, "success");
}

/** Return email IDs that already have a genuine (non-fallback) classification. */
export async function getPreviouslyClassifiedEmailIds(emailIds: string[]): Promise<Set<string>> {
  if (emailIds.length === 0) return new Set();
  const result = await pool.query<{ email_id: string }>(
    `SELECT DISTINCT email_id
     FROM classifications
     WHERE email_id = ANY($1::text[])
       AND reason <> 'Classification failed — defaulting to confirm'`,
    [emailIds]
  );
  return new Set(result.rows.map((row) => row.email_id));
}

/** Load deterministic rules for the exact normalized sender strings in a batch. */
export async function getSenderRules(senders: string[]): Promise<Map<string, Tier>> {
  const normalized = [...new Set(senders.map(normalizeSender).filter(Boolean))];
  if (normalized.length === 0) return new Map();
  const result = await pool.query<{ sender: string; tier: Tier }>(
    "SELECT sender, tier FROM sender_rules WHERE sender = ANY($1::text[])",
    [normalized]
  );
  return new Map(result.rows.map((row) => [normalizeSender(row.sender), row.tier]));
}

/** Persist one OpenRouter attempt for cost, reliability, and latency monitoring. */
export async function recordModelCall(runId: number, call: ModelAttempt): Promise<void> {
  await pool.query(
    `INSERT INTO model_calls
       (run_id, model, attempt, status, batch_size, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, error_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      runId,
      call.model,
      call.attempt,
      call.success ? "success" : "failed",
      call.batchSize,
      call.usage.inputTokens,
      call.usage.outputTokens,
      call.usage.cacheReadTokens,
      call.usage.cacheWriteTokens,
      call.usage.costUsd,
      call.latencyMs,
      call.errorType ?? null,
    ]
  );
}

export async function getTodayModelSpend(): Promise<number> {
  const result = await pool.query<{ cost: string }>(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS cost
     FROM model_calls
     WHERE created_at >= date_trunc('day', now())`
  );
  return Number(result.rows[0]?.cost ?? 0);
}

/** Get recent classifications for review. */
export async function getRecentClassifications(limit: number = 20) {
  const result = await pool.query<{
    email_id: string;
    run_id: number;
    subject: string;
    sender: string;
    received_at: string;
    tier: Tier;
    reason: string;
    has_list_unsubscribe: boolean;
    corrected_tier: Tier | null;
  }>(
    `SELECT c.email_id, c.run_id, c.subject, c.sender, c.received_at,
            c.tier, c.reason, c.has_list_unsubscribe, cr.corrected_tier
     FROM classifications c
     LEFT JOIN corrections cr ON c.email_id = cr.email_id AND c.run_id = cr.run_id
     ORDER BY c.received_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((r) => ({
    emailId: r.email_id,
    runId: r.run_id,
    subject: r.subject,
    from: r.sender,
    receivedAt: typeof r.received_at === "string" ? r.received_at : new Date(r.received_at).toISOString(),
    tier: r.tier,
    reason: r.reason,
    hasListUnsubscribe: r.has_list_unsubscribe,
    correctedTier: r.corrected_tier,
  }));
}

/** Record a correction for an email's classification. */
export async function insertCorrection(
  emailId: string,
  correctedTier: Tier
): Promise<{ originalTier: Tier; runId: number; subject: string; from: string } | null> {
  const classResult = await pool.query<{
    run_id: number;
    tier: Tier;
    subject: string;
    sender: string;
  }>(
    `SELECT run_id, tier, subject, sender FROM classifications
     WHERE email_id = $1
     ORDER BY classified_at DESC LIMIT 1`,
    [emailId]
  );

  if (classResult.rows.length === 0) return null;

  const row = classResult.rows[0]!;

  await pool.query(
    `INSERT INTO corrections (email_id, run_id, original_tier, corrected_tier)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email_id, run_id) DO UPDATE SET corrected_tier = $4, corrected_at = now()`,
    [emailId, row.run_id, row.tier, correctedTier]
  );

  const sender = normalizeSender(row.sender);
  if (sender) {
    await pool.query(
      `INSERT INTO sender_rules (sender, tier, source, updated_at)
       VALUES ($1, $2, 'correction', now())
       ON CONFLICT (sender) DO UPDATE
       SET tier = EXCLUDED.tier, source = EXCLUDED.source, updated_at = now()`,
      [sender, correctedTier]
    );
  }

  return { originalTier: row.tier, runId: row.run_id, subject: row.subject, from: row.sender };
}

/** Get accuracy statistics from corrections. */
export async function getAccuracyStats() {
  const totalResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text as count FROM classifications"
  );
  const total = parseInt(totalResult.rows[0]!.count);

  const correctedResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text as count FROM corrections"
  );
  const corrected = parseInt(correctedResult.rows[0]!.count);

  const perTierResult = await pool.query<{ tier: Tier; total: string; corrected: string }>(
    `SELECT c.tier,
            COUNT(*)::text as total,
            COUNT(cr.correction_id)::text as corrected
     FROM classifications c
     LEFT JOIN corrections cr ON c.email_id = cr.email_id AND c.run_id = cr.run_id
     GROUP BY c.tier
     ORDER BY c.tier`
  );

  const patternsResult = await pool.query<{ original_tier: Tier; corrected_tier: Tier; count: string }>(
    `SELECT original_tier, corrected_tier, COUNT(*)::text as count
     FROM corrections
     GROUP BY original_tier, corrected_tier
     ORDER BY COUNT(*) DESC`
  );

  return {
    total,
    corrected,
    perTier: perTierResult.rows.map((r) => ({
      tier: r.tier,
      total: parseInt(r.total),
      corrected: parseInt(r.corrected),
    })),
    patterns: patternsResult.rows.map((r) => ({
      originalTier: r.original_tier,
      correctedTier: r.corrected_tier,
      count: parseInt(r.count),
    })),
  };
}

// --- Attention Actions ---

/** Create the attention_actions table if it doesn't exist. */
export async function ensureAttentionActionsTable() {
  await pool.query(`
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
    )
  `);
}

export type AttentionQueueRow = {
  emailId: string;
  runId: number;
  subject: string;
  from: string;
  receivedAt: string;
  reason: string;
};

/** Get attention-tier emails that still need processing. */
export async function getAttentionQueue(limit: number): Promise<AttentionQueueRow[]> {
  const result = await pool.query<{
    email_id: string;
    run_id: number;
    subject: string;
    sender: string;
    received_at: string;
    reason: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (email_id)
         email_id, run_id, subject, sender, received_at, reason
       FROM classifications
       WHERE tier = 'attention'
       ORDER BY email_id, classified_at DESC
     )
     SELECT l.*
     FROM latest l
     LEFT JOIN attention_actions aa
       ON l.email_id = aa.email_id AND l.run_id = aa.run_id
     WHERE aa.action_id IS NULL
        OR (aa.action = 'snoozed' AND aa.snoozed_until <= now())
     ORDER BY l.received_at ASC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((r) => ({
    emailId: r.email_id,
    runId: r.run_id,
    subject: r.subject,
    from: r.sender,
    receivedAt: typeof r.received_at === "string" ? r.received_at : new Date(r.received_at).toISOString(),
    reason: r.reason,
  }));
}

/** Count total attention emails still needing processing. */
export async function getAttentionQueueCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (email_id)
         email_id, run_id, classified_at
       FROM classifications
       WHERE tier = 'attention'
       ORDER BY email_id, classified_at DESC
     )
     SELECT COUNT(*)::text as count
     FROM latest l
     LEFT JOIN attention_actions aa
       ON l.email_id = aa.email_id AND l.run_id = aa.run_id
     WHERE aa.action_id IS NULL
        OR (aa.action = 'snoozed' AND aa.snoozed_until <= now())`
  );
  return parseInt(result.rows[0]!.count);
}

/** Record that an attention email was acted on or snoozed. */
export async function recordAttentionAction(
  emailId: string,
  runId: number,
  action: "acted" | "snoozed",
  note?: string,
  snoozedUntil?: Date
): Promise<void> {
  await pool.query(
    `INSERT INTO attention_actions (email_id, run_id, action, note, snoozed_until)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [emailId, runId, action, note ?? null, snoozedUntil ?? null]
  );
}
