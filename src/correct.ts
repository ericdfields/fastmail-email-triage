import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  getRecentClassifications,
  insertCorrection,
} from "./db.js";
import type { Tier } from "./types.js";

const VALID_TIERS: Tier[] = ["auto-delete", "auto-archive", "confirm", "attention"];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

  initDb();
  await ensureCorrectionsTable();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    // List recent classifications for review
    const recent = await getRecentClassifications(20);
    if (recent.length === 0) {
      console.log("No recent classifications found.");
      await closeDb();
      return;
    }

    console.log("Recent classifications:\n");
    for (const c of recent) {
      const corrected = c.correctedTier ? ` (corrected → ${c.correctedTier})` : "";
      console.log(`  ${c.emailId}`);
      console.log(`    ${c.tier}${corrected}  ${c.from}`);
      console.log(`    ${c.subject}`);
      console.log(`    ${c.reason}`);
      console.log();
    }

    console.log("To correct: npm run correct -- <email_id> <tier>");
    console.log(`Valid tiers: ${VALID_TIERS.join(", ")}`);
    await closeDb();
    return;
  }

  if (args.length !== 2) {
    console.error("Usage: npm run correct -- <email_id> <corrected_tier>");
    console.error("       npm run correct              (list recent classifications)");
    process.exit(1);
  }

  const [emailId, correctedTier] = args as [string, string];

  if (!VALID_TIERS.includes(correctedTier as Tier)) {
    console.error(`Invalid tier: ${correctedTier}`);
    console.error(`Valid tiers: ${VALID_TIERS.join(", ")}`);
    process.exit(1);
  }

  const result = await insertCorrection(emailId, correctedTier as Tier);

  if (!result) {
    console.error(`No classification found for email_id: ${emailId}`);
    process.exit(1);
  }

  console.log("Correction recorded:");
  console.log(`  Email:   ${result.subject}`);
  console.log(`  From:    ${result.from}`);
  console.log(`  Change:  ${result.originalTier} → ${correctedTier}`);

  await closeDb();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
