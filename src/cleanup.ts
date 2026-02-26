import { getSession, getMailboxIds, jmapRequest } from "./jmap.js";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

async function archiveStaleRead(): Promise<void> {
  const session = await getSession();
  const mailboxIds = await getMailboxIds(session);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1);
  const before = cutoff.toISOString();

  const prefix = dryRun ? "[DRY RUN] " : "";
  console.log(`${prefix}Archiving read inbox emails older than ${before.slice(0, 10)}...`);

  // In dry-run mode, just query the total and exit
  if (dryRun) {
    const response = await jmapRequest(session, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId: session.accountId,
            filter: {
              inMailbox: mailboxIds.inbox,
              hasKeyword: "$seen",
              before,
            },
            limit: 0,
            calculateTotal: true,
          },
          "query0",
        ],
      ],
    });

    const total = response.methodResponses[0][1].total ?? 0;
    console.log(`${prefix}Would archive ${total} emails.`);
    return;
  }

  let totalArchived = 0;

  while (true) {
    // Query a batch of matching emails
    const response = await jmapRequest(session, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId: session.accountId,
            filter: {
              inMailbox: mailboxIds.inbox,
              hasKeyword: "$seen",
              before,
            },
            sort: [{ property: "receivedAt", isAscending: true }],
            limit: BATCH_SIZE,
            calculateTotal: totalArchived === 0,
          },
          "query0",
        ],
      ],
    });

    const queryResult = response.methodResponses[0][1];
    const ids: string[] = queryResult.ids ?? [];

    if (totalArchived === 0 && queryResult.total != null) {
      console.log(`Found ${queryResult.total} emails to archive`);
    }

    if (ids.length === 0) break;

    // Archive all emails in this batch
    const update: Record<string, object> = {};
    for (const id of ids) {
      update[id] = {
        [`mailboxIds/${mailboxIds.inbox}`]: null,
        [`mailboxIds/${mailboxIds.archive}`]: true,
      };
    }

    const setResponse = await jmapRequest(session, {
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/set",
          {
            accountId: session.accountId,
            update,
          },
          "set0",
        ],
      ],
    });

    const setResult = setResponse.methodResponses[0][1];
    const updatedCount = Object.keys(setResult.updated ?? {}).length;
    const failedCount = Object.keys(setResult.notUpdated ?? {}).length;

    totalArchived += updatedCount;
    console.log(`  Archived ${updatedCount} emails (${totalArchived} total)${failedCount > 0 ? `, ${failedCount} failed` : ""}`);

    if (ids.length < BATCH_SIZE) break;

    // Rate limit between batches
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. Archived ${totalArchived} emails.`);
}

archiveStaleRead().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
