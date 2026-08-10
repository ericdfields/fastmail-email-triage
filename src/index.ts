import { getSession, getMailboxIds, fetchAllUnread, applyActions } from "./jmap.js";
import { BACKUP_MODEL, PRIMARY_MODEL, classifyBatch } from "./classifier.js";
import {
  initDb,
  closeDb,
  createRun,
  findIncompleteRun,
  insertClassifications,
  markActionsApplied,
  completeRun,
  ensureCorrectionsTable,
  ensureOptimizationTables,
  getPreviouslyClassifiedEmailIds,
  getSenderRules,
  getTodayModelSpend,
  recordModelCall,
} from "./db.js";
import { routeDeterministically, senderKey } from "./routing.js";
import type { Classification, MailboxIds, Tier } from "./types.js";

const DEFAULT_DAILY_BUDGET_USD = 1;

function dailyBudgetUsd(): number {
  const configured = Number(process.env.OPENROUTER_DAILY_BUDGET_USD ?? DEFAULT_DAILY_BUDGET_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_BUDGET_USD;
}

async function pingHeartbeat(status: "up" | "down", message: string): Promise<void> {
  if (!process.env.UPTIME_KUMA_PUSH_URL) return;
  const url = new URL(process.env.UPTIME_KUMA_PUSH_URL);
  url.searchParams.set("status", status);
  url.searchParams.set("msg", message);
  url.searchParams.set("ping", "");
  await fetch(url);
}

async function main() {
  if (!process.env.FASTMAIL_API_TOKEN)
    throw new Error("Missing FASTMAIL_API_TOKEN");
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("Missing OPENROUTER_API_KEY");

  const watchMode = process.argv.includes("--watch");
  const dryRun = process.argv.includes("--dry-run");
  const POLL_INTERVAL = 60_000;
  const budgetUsd = dailyBudgetUsd();
  console.log(`Models: ${PRIMARY_MODEL} → ${BACKUP_MODEL}`);
  console.log(`Daily OpenRouter budget: $${budgetUsd.toFixed(2)}${watchMode ? " (watch mode)" : ""}${dryRun ? " (dry run)" : ""}`);

  initDb();
  await ensureCorrectionsTable();
  await ensureOptimizationTables();

  // Check for an incomplete run to resume
  // A dry run must never complete or otherwise mutate an in-progress production run.
  const partial = dryRun ? null : await findIncompleteRun();
  let runId: number;
  const alreadyClassified = new Set<string>();
  let alreadyActed = new Set<string>();
  let totalClassified = 0;
  const summaryCounts: Partial<Record<Tier, number>> = {};

  if (partial) {
    runId = partial.runId;
    alreadyActed = partial.alreadyActed;
    console.log(`Resuming run #${runId}`);
    console.log(`  ${partial.classifications.length} classified, ${alreadyActed.size} acted`);
    for (const c of partial.classifications) {
      alreadyClassified.add(c.emailId);
      summaryCounts[c.tier] = (summaryCounts[c.tier] ?? 0) + 1;
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
  if (partial && !dryRun) {
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

      const candidates = batch.filter((email) => !alreadyClassified.has(email.id));
      const previouslyClassified = await getPreviouslyClassifiedEmailIds(
        candidates.map((email) => email.id)
      );
      for (const emailId of previouslyClassified) alreadyClassified.add(emailId);
      const newEmails = candidates.filter((email) => !previouslyClassified.has(email.id));

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

      const senderRules = await getSenderRules(newEmails.map(senderKey));
      const { deterministic, modelEmails } = routeDeterministically(newEmails, senderRules);

      let modelClassifications: Classification[] = [];

      try {
        modelClassifications = await classifyBatch(modelEmails, {
          beforeAttempt: async () => {
            const spent = await getTodayModelSpend();
            if (spent >= budgetUsd) {
              const error = new Error(
                `Daily OpenRouter budget reached ($${spent.toFixed(4)} of $${budgetUsd.toFixed(2)})`
              );
              error.name = "DailyBudgetExceededError";
              throw error;
            }
          },
          onAttempt: async (attempt) => {
            await recordModelCall(runId, attempt);
            const status = attempt.success ? "succeeded" : "failed";
            console.log(
              `  ${attempt.model} ${status}: ${attempt.usage.inputTokens} in, ` +
              `${attempt.usage.outputTokens} out, $${attempt.usage.costUsd.toFixed(6)}, ` +
              `${attempt.latencyMs}ms`
            );
          },
        });
      } catch (err) {
        console.error("  Classification batch failed; stopping run:", err);
        throw err;
      }

      const byEmailId = new Map(
        [...deterministic, ...modelClassifications].map((classification) => [
          classification.emailId,
          classification,
        ])
      );
      const classifications = newEmails.map((email) => byEmailId.get(email.id)!);

      console.log(
        `  Routing: ${deterministic.length} deterministic, ${modelEmails.length} model`
      );

      if (!dryRun) {
        await insertClassifications(runId, classifications);
      }
      totalClassified += classifications.length;
      for (const c of classifications) alreadyClassified.add(c.emailId);

      const tierCounts = classifications.reduce(
        (acc, c) => {
          acc[c.tier] = (acc[c.tier] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
      for (const [tier, count] of Object.entries(tierCounts)) {
        const typedTier = tier as Tier;
        summaryCounts[typedTier] = (summaryCounts[typedTier] ?? 0) + count;
      }
      console.log(`  Classified: ${JSON.stringify(tierCounts)}`);

      if (!dryRun) {
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
      } else if (dryRun) {
        console.log("  Actions skipped (dry run)");
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

  console.log(`\n--- Summary (run #${runId}) ---`);
  console.log(`Total: ${totalClassified}`);
  console.log(`  auto-delete:  ${summaryCounts["auto-delete"] ?? 0}`);
  console.log(`  auto-archive: ${summaryCounts["auto-archive"] ?? 0}`);
  console.log(`  confirm:      ${summaryCounts["confirm"] ?? 0}`);
  console.log(`  attention:    ${summaryCounts["attention"] ?? 0}`);

  try {
    await pingHeartbeat("up", "OK");
    if (process.env.UPTIME_KUMA_PUSH_URL) console.log("Uptime Kuma heartbeat sent");
  } catch (err) {
    console.error("Uptime Kuma heartbeat failed:", err);
  }

  await closeDb();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  try {
    await pingHeartbeat("down", "Email classification failed");
  } catch (heartbeatError) {
    console.error("Uptime Kuma failure heartbeat failed:", heartbeatError);
  }
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
