import { getSession, getMailboxIds, fetchAllUnread, applyActions } from "./jmap.js";
import { classifyBatch } from "./classifier.js";
import {
  initDb,
  closeDb,
  createRun,
  findIncompleteRun,
  insertClassifications,
  markActionsApplied,
  completeRun,
  getRunSummary,
} from "./db.js";
import type { Classification, MailboxIds } from "./types.js";

async function main() {
  if (!process.env.FASTMAIL_API_TOKEN)
    throw new Error("Missing FASTMAIL_API_TOKEN");
  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("Missing ANTHROPIC_API_KEY");

  const model = process.argv.includes("--haiku")
    ? "claude-haiku-4-5-20251001"
    : "claude-sonnet-4-6";
  const watchMode = process.argv.includes("--watch");
  const POLL_INTERVAL = 60_000;
  console.log(`Model: ${model}${watchMode ? " (watch mode)" : ""}`);

  initDb();

  // Check for an incomplete run to resume
  const partial = await findIncompleteRun();
  let runId: number;
  const alreadyClassified = new Set<string>();
  let alreadyActed = new Set<string>();
  let totalClassified = 0;

  if (partial) {
    runId = partial.runId;
    alreadyActed = partial.alreadyActed;
    console.log(`Resuming run #${runId}`);
    console.log(`  ${partial.classifications.length} classified, ${alreadyActed.size} acted`);
    for (const c of partial.classifications) {
      alreadyClassified.add(c.emailId);
    }
    totalClassified = partial.classifications.length;
  } else {
    runId = await createRun();
    console.log(`Starting run #${runId}`);
  }

  console.log("Connecting to Fastmail...");
  const session = await getSession();
  console.log(`Account: ${session.accountId}`);

  const mailboxIds = await getMailboxIds(session);
  console.log(`Mailboxes: inbox=${mailboxIds.inbox}, archive=${mailboxIds.archive}, trash=${mailboxIds.trash}`);

  // On resume: retry actions for classified-but-unacted emails
  if (partial) {
    const pendingActions = partial.classifications.filter(
      (c) => !alreadyActed.has(c.emailId) && c.tier !== "attention"
    );
    if (pendingActions.length > 0) {
      console.log(`Retrying actions for ${pendingActions.length} classified-but-unacted emails...`);
      try {
        const results = await applyActions(session, mailboxIds, pendingActions);
        const succeeded = results.filter((r) => r.success).map((r) => r.emailId);
        const failed = results.filter((r) => !r.success);
        if (succeeded.length > 0) await markActionsApplied(runId, succeeded);
        console.log(`  Resume actions: ${succeeded.length} succeeded, ${failed.length} failed`);
        for (const f of failed) console.error(`  Action failed: ${f.emailId} — ${f.error}`);
      } catch (err) {
        console.error("  Resume action batch failed:", err);
      }
    }
  }

  let batchNum = 0;
  let stopping = false;

  if (watchMode) {
    process.on("SIGINT", () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log("\nStopping after current batch...");
    });
  }

  while (true) {
    let batchesThisPoll = 0;

    for await (const batch of fetchAllUnread(session, mailboxIds.inbox)) {
      if (stopping) break;

      const newEmails = batch.filter((e) => !alreadyClassified.has(e.id));

      batchNum++;
      if (newEmails.length === 0) {
        console.log(
          `\nBatch ${batchNum}: ${batch.length} emails (all already classified, skipping)`
        );
        continue;
      }

      batchesThisPoll++;
      const skipped = batch.length - newEmails.length;
      console.log(
        `\nBatch ${batchNum}: ${newEmails.length} emails` +
          (skipped > 0 ? ` (${skipped} already classified, skipped)` : "")
      );

      let classifications: Classification[];
      let isFallback = false;

      try {
        classifications = await classifyBatch(newEmails, model);
      } catch (err) {
        console.error(`  Classification failed:`, err);
        classifications = newEmails.map((email) => ({
          emailId: email.id,
          subject: email.subject,
          from: email.from.map((f) => f.email).join(", "),
          receivedAt: email.receivedAt,
          tier: "confirm",
          reason: "Classification failed — defaulting to confirm",
          hasListUnsubscribe: email.hasListUnsubscribe,
        }));
        isFallback = true;
      }

      await insertClassifications(runId, classifications);
      totalClassified += classifications.length;
      for (const c of classifications) alreadyClassified.add(c.emailId);

      const tierCounts = classifications.reduce(
        (acc, c) => {
          acc[c.tier] = (acc[c.tier] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
      console.log(`  Classified: ${JSON.stringify(tierCounts)}`);

      // Apply actions (skip for fallback classifications — leave for manual review)
      if (!isFallback) {
        try {
          const results = await applyActions(session, mailboxIds, classifications);
          const succeeded = results.filter((r) => r.success).map((r) => r.emailId);
          const failed = results.filter((r) => !r.success);
          if (succeeded.length > 0) await markActionsApplied(runId, succeeded);
          console.log(`  Actions: ${succeeded.length} applied, ${failed.length} failed`);
          for (const f of failed) console.error(`  Action failed: ${f.emailId} — ${f.error}`);
        } catch (err) {
          console.error("  Action batch failed:", err);
        }
      }

      // Rate limiting pause
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!watchMode || stopping) break;

    if (batchesThisPoll === 0) {
      console.log(`\nNo new emails. Polling again in ${POLL_INTERVAL / 1000}s...`);
    } else {
      console.log(`\nDone with current batch. Polling again in ${POLL_INTERVAL / 1000}s...`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  await completeRun(runId, totalClassified);

  const summary = await getRunSummary(runId);

  console.log(`\n--- Summary (run #${runId}) ---`);
  console.log(`Total: ${totalClassified}`);
  console.log(`  auto-delete:  ${summary.counts["auto-delete"] ?? 0}`);
  console.log(`  auto-archive: ${summary.counts["auto-archive"] ?? 0}`);
  console.log(`  confirm:      ${summary.counts["confirm"] ?? 0}`);
  console.log(`  attention:    ${summary.counts["attention"] ?? 0}`);

  await closeDb();
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
