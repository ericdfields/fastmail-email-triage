import pg from "pg";
import type { Classification, Tier } from "./types.js";

const { Pool } = pg;

let pool: pg.Pool;

export function initDb() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
    "SELECT email_id, subject, sender, received_at, tier, reason, has_list_unsubscribe, acted_at FROM classifications WHERE run_id = $1",
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
     VALUES ${values.join(", ")}`,
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

/** Get all unacted classifications from completed runs. */
export async function getUnactedClassifications(): Promise<
  { runId: number; classification: Classification }[]
> {
  const result = await pool.query<{
    run_id: number;
    email_id: string;
    subject: string;
    sender: string;
    received_at: string;
    tier: Tier;
    reason: string;
    has_list_unsubscribe: boolean;
  }>(
    `SELECT c.run_id, c.email_id, c.subject, c.sender, c.received_at, c.tier, c.reason, c.has_list_unsubscribe
     FROM classifications c
     JOIN triage_runs r ON r.run_id = c.run_id
     WHERE r.completed_at IS NOT NULL AND c.acted_at IS NULL AND c.tier != 'attention'
     ORDER BY c.run_id, c.received_at`
  );

  return result.rows.map((r) => ({
    runId: r.run_id,
    classification: {
      emailId: r.email_id,
      subject: r.subject,
      from: r.sender,
      receivedAt: r.received_at,
      tier: r.tier,
      reason: r.reason,
      hasListUnsubscribe: r.has_list_unsubscribe,
    },
  }));
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
