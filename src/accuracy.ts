import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  getAccuracyStats,
} from "./db.js";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

  initDb();
  await ensureCorrectionsTable();

  const stats = await getAccuracyStats();

  console.log("--- Classification Accuracy ---\n");
  console.log(`Total classified: ${stats.total}`);
  console.log(`Corrections:      ${stats.corrected}`);

  if (stats.total > 0) {
    const pct = ((1 - stats.corrected / stats.total) * 100).toFixed(1);
    console.log(`Accuracy:         ${pct}%`);
  }

  if (stats.perTier.length > 0) {
    console.log("\nPer-tier breakdown:");
    for (const t of stats.perTier) {
      const pct = t.total > 0 ? ((1 - t.corrected / t.total) * 100).toFixed(1) : "N/A";
      console.log(`  ${t.tier.padEnd(14)}  ${t.total} classified, ${t.corrected} corrected (${pct}% accurate)`);
    }
  }

  if (stats.patterns.length > 0) {
    console.log("\nCommon correction patterns:");
    for (const p of stats.patterns) {
      console.log(`  ${p.originalTier} → ${p.correctedTier}: ${p.count} time${p.count === 1 ? "" : "s"}`);
    }
  }

  if (stats.corrected === 0) {
    console.log("\nNo corrections recorded yet. Use `npm run correct` to review and correct classifications.");
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
