import { readFileSync } from "fs";
import pg from "pg";
import type { Classification } from "./types.js";

const { Pool } = pg;

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx src/import-jsonl.ts <path-to-jsonl>");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const lines = readFileSync(file, "utf-8").trim().split("\n");
  const classifications: Classification[] = lines.map(
    (line) => JSON.parse(line) as Classification
  );

  console.log(`Importing ${classifications.length} classifications from ${file}...`);

  // Create a completed run for the import
  const runResult = await pool.query<{ run_id: number }>(
    "INSERT INTO triage_runs (started_at, completed_at, total_processed) VALUES (now(), now(), $1) RETURNING run_id",
    [classifications.length]
  );
  const runId = runResult.rows[0]!.run_id;

  // Batch insert in chunks of 50
  const CHUNK = 50;
  for (let i = 0; i < classifications.length; i += CHUNK) {
    const chunk = classifications.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    for (const c of chunk) {
      values.push(
        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`
      );
      params.push(
        c.emailId,
        runId,
        c.subject,
        c.from,
        c.receivedAt,
        c.tier,
        c.reason,
        c.hasListUnsubscribe
      );
      p += 8;
    }

    await pool.query(
      `INSERT INTO classifications (email_id, run_id, subject, sender, received_at, tier, reason, has_list_unsubscribe)
       VALUES ${values.join(", ")}
       ON CONFLICT (email_id, run_id) DO NOTHING`,
      params
    );

    console.log(`  Inserted ${Math.min(i + CHUNK, classifications.length)}/${classifications.length}`);
  }

  console.log(`\nImported as run #${runId} (marked as completed)`);
  await pool.end();
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
