import {
  initDb,
  closeDb,
  ensureAttentionActionsTable,
  getAttentionQueue,
  getAttentionQueueCount,
  recordAttentionAction,
} from "./db.js";
import {
  getSession,
  getMailboxIds,
  fetchEmailBodies,
  archiveEmail,
} from "./jmap.js";
import type { JMAPSession, MailboxIds } from "./types.js";
import type { AttentionQueueRow } from "./db.js";

// --- CLI flags ---

function parseBatchSize(): number {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--batch");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1]!);
    if (!isNaN(n) && n > 0) return n;
  }
  return 5;
}

// --- Entry point ---

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  if (!process.env.FASTMAIL_API_TOKEN) throw new Error("Missing FASTMAIL_API_TOKEN");

  const batchSize = parseBatchSize();

  initDb();
  await ensureAttentionActionsTable();

  const session = await getSession();
  const mailboxIds = await getMailboxIds(session);

  const totalRemaining = await getAttentionQueueCount();

  if (totalRemaining === 0) {
    console.log("No attention emails to process. Inbox zero!");
    await closeDb();
    return;
  }

  const queue = await getAttentionQueue(batchSize);

  if (!process.stdout.isTTY) {
    // Non-TTY fallback: plain list
    console.log(`Attention queue: ${totalRemaining} emails\n`);
    for (const row of queue) {
      console.log(`  ${row.emailId}`);
      console.log(`  ${row.from}`);
      console.log(`  ${row.subject}`);
      console.log(`  ${row.reason}`);
      console.log();
    }
    await closeDb();
    return;
  }

  const bodyMap = await fetchEmailBodies(session, queue.map((r) => r.emailId));
  await launchTUI(session, mailboxIds, queue, bodyMap, batchSize, totalRemaining);
}

// --- TUI (stub — filled in Task 4) ---

async function launchTUI(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  initialQueue: AttentionQueueRow[],
  initialBodyMap: Map<string, string>,
  batchSize: number,
  initialTotal: number
): Promise<void> {
  console.log(`TODO: TUI — ${initialQueue.length} of ${initialTotal} attention emails`);
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
