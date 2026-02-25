# Attention Processing TUI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `npm run act` — a TUI for processing `attention`-tier emails in configurable batches, with archiving, snooze presets, and optional notes stored for future introspection.

**Architecture:** New `src/act.ts` entry point. DB layer extended with `attention_actions` table (acted/snoozed records). JMAP layer extended with body fetching and single-email archive. TUI pattern mirrors `src/correct.ts` (raw-mode stdin, ANSI output).

**Tech Stack:** TypeScript (ES modules, tsx), PostgreSQL (pg), Fastmail JMAP, Node.js raw stdin

---

## Reference

Design doc: `docs/plans/2026-02-25-attention-processing-design.md`

Key existing files:
- `src/db.ts` — all DB functions, export pattern to follow
- `src/jmap.ts` — `jmapRequest()` (unexported, internal), `getSession()`, `getMailboxIds()`, `applyActions()`
- `src/correct.ts` — TUI pattern: raw stdin, ANSI escape codes, render loop
- `src/types.ts` — `Tier`, `Classification`, `JMAPSession`, `MailboxIds`

All imports use `.js` extensions. Use `import type` for type-only imports.

Worktree: `.worktrees/attention-processing/`
All file edits happen in the worktree — paths below are relative to the project root.

---

## Task 1: DB — `attention_actions` table + queries

**Files:**
- Modify: `src/db.ts`

### Step 1: Add the ensure-table function

At the bottom of `src/db.ts`, add:

```typescript
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
      FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id)
    )
  `);
}
```

### Step 2: Add the queue query

This returns `limit` attention emails that need processing (never acted, or snooze expired), oldest first. Uses `DISTINCT ON` to deduplicate emails that appear in multiple runs (takes most recent classification).

```typescript
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
```

### Step 3: Add the total count query

```typescript
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
```

### Step 4: Add the record-action function

```typescript
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
```

### Step 5: Verify TypeScript compiles

```bash
cd .worktrees/attention-processing
npx tsc --noEmit
```

Expected: no errors

### Step 6: Commit

```bash
git add src/db.ts
git commit -m "feat: add attention_actions table and queue queries"
```

---

## Task 2: JMAP — body fetching and single-email archive

**Files:**
- Modify: `src/jmap.ts`

### Step 1: Add `fetchEmailBodies`

The `jmapRequest` function is not exported — add these two functions as exports below `applyActions`. The new function fetches body text for a list of email IDs in a single JMAP call.

```typescript
export type EmailBody = {
  emailId: string;
  text: string; // plain text, trimmed to ~500 chars
};

/** Fetch plain-text body for a batch of email IDs. */
export async function fetchEmailBodies(
  session: JMAPSession,
  emailIds: string[]
): Promise<Map<string, string>> {
  if (emailIds.length === 0) return new Map();

  const data = await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/get",
        {
          accountId: session.accountId,
          ids: emailIds,
          properties: ["id", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          maxBodyValueBytes: 2048,
        },
        "bodies0",
      ],
    ],
  });

  const result = new Map<string, string>();
  const emails: any[] = data.methodResponses[0][1].list ?? [];

  for (const email of emails) {
    const bodyValues: Record<string, { value: string }> = email.bodyValues ?? {};

    // Prefer text/plain part
    let text = "";
    if (email.textBody && email.textBody.length > 0) {
      const partId = email.textBody[0].partId;
      text = bodyValues[partId]?.value ?? "";
    } else if (email.htmlBody && email.htmlBody.length > 0) {
      const partId = email.htmlBody[0].partId;
      const html = bodyValues[partId]?.value ?? "";
      // Strip HTML tags
      text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    // Trim to 500 chars
    result.set(email.id, text.length > 500 ? text.substring(0, 497) + "..." : text);
  }

  return result;
}
```

### Step 2: Add `archiveEmail`

```typescript
/** Move a single email to archive and mark as read. */
export async function archiveEmail(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  emailId: string
): Promise<void> {
  await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: session.accountId,
          update: {
            [emailId]: {
              [`mailboxIds/${mailboxIds.inbox}`]: null,
              [`mailboxIds/${mailboxIds.archive}`]: true,
              "keywords/$seen": true,
            },
          },
        },
        "archive0",
      ],
    ],
  });
}
```

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Expected: no errors

### Step 4: Commit

```bash
git add src/jmap.ts
git commit -m "feat: add fetchEmailBodies and archiveEmail to jmap client"
```

---

## Task 3: `src/act.ts` — scaffold, CLI parsing, data loading

**Files:**
- Create: `src/act.ts`

This file is the entry point. It handles CLI flags, DB init, JMAP setup, and loading the first batch. Start with a working scaffold that loads data and prints it, so we can verify the DB/JMAP wiring before building the TUI.

### Step 1: Create `src/act.ts`

```typescript
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
  const bodyMap = await fetchEmailBodies(session, queue.map((r) => r.emailId));

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

  await launchTUI(session, mailboxIds, queue, bodyMap, batchSize, totalRemaining);
}

// --- TUI (stub — filled in next tasks) ---

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
```

### Step 2: Add the `act` script to `package.json`

In `package.json`, add to `scripts`:

```json
"act": "doppler run -- tsx src/act.ts"
```

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Expected: no errors

### Step 4: Verify it runs (will print stub message)

```bash
npm run act
```

Expected: prints attention queue count and "TODO: TUI" message (or "No attention emails" if queue is empty)

### Step 5: Commit

```bash
git add src/act.ts package.json
git commit -m "feat: scaffold act.ts with CLI parsing and data loading"
```

---

## Task 4: TUI — list navigation and detail panel

**Files:**
- Modify: `src/act.ts`

Replace the `launchTUI` stub with a working interactive TUI. This task covers: ANSI helpers, the render function, j/k navigation, and the detail panel. Action keys (`a`, `s`) are stubs.

### Step 1: Replace `launchTUI` with the full implementation

Replace the stub `launchTUI` function with:

```typescript
// --- ANSI helpers ---

const ESC = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function dimLine(s: string, w: number): string {
  return `${ESC.dim}${"\u2500".repeat(w)}${ESC.reset}`;
}

// --- TUI state type ---

type TUIMode =
  | { type: "list" }
  | { type: "note"; note: string }
  | { type: "snooze" }
  | { type: "batch-complete"; remaining: number };

async function launchTUI(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  initialQueue: AttentionQueueRow[],
  initialBodyMap: Map<string, string>,
  batchSize: number,
  initialTotal: number
): Promise<void> {
  const { stdin, stdout } = process;

  let queue = [...initialQueue];
  let bodyMap = new Map(initialBodyMap);
  let total = initialTotal;
  let idx = 0;
  let scroll = 0;
  let mode: TUIMode = { type: "list" };
  let statusMsg: string | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(ESC.hideCursor);

  function visibleCount(): number {
    const h = stdout.rows || 24;
    // Reserve: header(2) + separator(1) + body(4) + reason(1) + separator(1) + status(2) + separator(1) + help(1) = 13
    return Math.max(1, Math.floor((h - 13) / 2));
  }

  function renderList(): string {
    const w = stdout.columns || 80;
    const vis = visibleCount();

    if (idx < scroll) scroll = idx;
    if (idx >= scroll + vis) scroll = idx - vis + 1;

    let s = ESC.clear;

    // Header
    const batchInfo = `${queue.length} in batch`;
    const totalInfo = `${total} total remaining`;
    s += `${ESC.bold} Attention Queue${ESC.reset}  ${ESC.dim}${batchInfo}  ${totalInfo}${ESC.reset}\n`;
    s += dimLine("", w) + "\n";

    // List
    const end = Math.min(scroll + vis, queue.length);
    for (let i = scroll; i < end; i++) {
      const row = queue[i]!;
      const sel = i === idx;
      const cursor = sel ? "\u25b8" : " ";
      const from = truncate(row.from, 35);
      const subj = truncate(row.subject, w - 4);
      const date = row.receivedAt.substring(0, 10);

      if (sel) {
        s += `${ESC.bold}${cursor} ${ESC.green}attention${ESC.reset}  ${ESC.bold}${from}${ESC.reset}  ${ESC.dim}${date}${ESC.reset}\n`;
        s += `${ESC.bold}  ${subj}${ESC.reset}\n`;
      } else {
        s += `${cursor} ${ESC.green}attention${ESC.reset}  ${ESC.dim}${from}${ESC.reset}  ${ESC.dim}${date}${ESC.reset}\n`;
        s += `  ${ESC.dim}${subj}${ESC.reset}\n`;
      }
    }
    for (let i = (end - scroll) * 2; i < vis * 2; i++) s += "\n";

    // Scroll indicator
    const below = queue.length - end;
    const above = scroll;
    if (below > 0 && above > 0) {
      s += `${ESC.dim}  \u2191 ${above} above  \u2193 ${below} below${ESC.reset}\n`;
    } else if (below > 0) {
      s += `${ESC.dim}  \u2193 ${below} more below${ESC.reset}\n`;
    } else if (above > 0) {
      s += `${ESC.dim}  \u2191 ${above} more above${ESC.reset}\n`;
    } else {
      s += "\n";
    }

    // Detail panel
    s += dimLine("", w) + "\n";
    const r = queue[idx]!;
    const body = bodyMap.get(r.emailId) ?? "(no body preview)";
    const bodyLines = truncate(body, (w - 10) * 3);
    s += `${ESC.dim}Body:${ESC.reset}   ${truncate(bodyLines, w - 8)}\n`;
    // Wrap second body line if long enough
    if (body.length > w - 8) {
      s += `        ${ESC.dim}${truncate(body.substring(w - 8), w - 8)}${ESC.reset}\n`;
    } else {
      s += "\n";
    }
    s += `${ESC.dim}Reason:${ESC.reset} ${truncate(r.reason, w - 10)}\n`;
    s += `${ESC.dim}From:${ESC.reset}   ${r.from}  ${ESC.dim}${r.receivedAt.substring(0, 10)}${ESC.reset}\n`;

    // Status / mode line
    s += "\n";
    if (statusMsg) {
      s += `${ESC.bold}  ${statusMsg}${ESC.reset}\n`;
    } else if (mode.type === "note") {
      s += `${ESC.bold}  Note (enter to skip, ctrl+c to cancel): ${mode.note}█${ESC.reset}\n`;
    } else if (mode.type === "snooze") {
      s += `${ESC.bold}  Snooze: ${ESC.reset}${ESC.cyan}1${ESC.reset} Tomorrow  ${ESC.cyan}2${ESC.reset} Three days  ${ESC.cyan}3${ESC.reset} One week  ${ESC.dim}esc Cancel${ESC.reset}\n`;
    } else {
      s += "\n";
    }

    // Help bar
    s += dimLine("", w) + "\n";
    if (mode.type === "list") {
      s += `${ESC.dim}\u2191/\u2193${ESC.reset} Navigate  `;
      s += `${ESC.green}a${ESC.reset}${ESC.dim} Act${ESC.reset}  `;
      s += `${ESC.yellow}s${ESC.reset}${ESC.dim} Snooze${ESC.reset}  `;
      s += `${ESC.dim}q${ESC.reset} Quit`;
    }

    return s;
  }

  function renderBatchComplete(remaining: number): string {
    const w = stdout.columns || 80;
    let s = ESC.clear;
    s += `${ESC.bold} Batch complete!${ESC.reset}\n`;
    s += dimLine("", w) + "\n\n";
    if (remaining > 0) {
      s += `  ${ESC.green}${remaining}${ESC.reset} attention emails still remaining.\n\n`;
      s += `  ${ESC.dim}Press any key to load next batch, or ${ESC.reset}q${ESC.dim} to quit.${ESC.reset}\n`;
    } else {
      s += `  ${ESC.bold}Inbox zero!${ESC.reset} All attention emails processed.\n\n`;
      s += `  ${ESC.dim}Press any key to quit.${ESC.reset}\n`;
    }
    return s;
  }

  function render() {
    if (mode.type === "batch-complete") {
      stdout.write(renderBatchComplete(mode.remaining));
    } else {
      stdout.write(renderList());
    }
  }

  function showStatus(m: string) {
    statusMsg = m;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusMsg = null;
      render();
    }, 2000);
    render();
  }

  function removeCurrentAndAdvance() {
    queue.splice(idx, 1);
    total = Math.max(0, total - 1);
    if (queue.length === 0) {
      // Batch exhausted
      mode = { type: "batch-complete", remaining: total };
    } else {
      idx = Math.min(idx, queue.length - 1);
      mode = { type: "list" };
    }
    render();
  }

  function cleanup() {
    stdout.write(ESC.clear + ESC.showCursor);
    stdin.setRawMode(false);
    stdin.pause();
  }

  stdout.on("resize", () => render());
  render();

  stdin.on("data", async (key: string) => {
    // --- Batch complete screen ---
    if (mode.type === "batch-complete") {
      if (key === "\x03" || key === "q" || mode.remaining === 0) {
        cleanup();
        await closeDb();
        process.exit(0);
      }
      // Load next batch
      busy = true;
      try {
        const nextQueue = await getAttentionQueue(batchSize);
        const nextBodyMap = await fetchEmailBodies(session, nextQueue.map((r) => r.emailId));
        const nextTotal = await getAttentionQueueCount();
        queue = nextQueue;
        bodyMap = nextBodyMap;
        total = nextTotal;
        idx = 0;
        scroll = 0;
        if (queue.length === 0) {
          mode = { type: "batch-complete", remaining: 0 };
        } else {
          mode = { type: "list" };
        }
      } finally {
        busy = false;
      }
      render();
      return;
    }

    // Ctrl+C
    if (key === "\x03") {
      if (mode.type === "note") {
        mode = { type: "list" };
        render();
        return;
      }
      cleanup();
      await closeDb();
      process.exit(0);
    }

    // q to quit (only in list mode)
    if (key === "q" && mode.type === "list") {
      cleanup();
      await closeDb();
      process.exit(0);
    }

    if (busy) return;

    // --- Snooze mode ---
    if (mode.type === "snooze") {
      if (key === "\x1b") { // Escape
        mode = { type: "list" };
        render();
        return;
      }
      if (key === "1" || key === "2" || key === "3") {
        const days = key === "1" ? 1 : key === "2" ? 3 : 7;
        const snoozedUntil = new Date();
        snoozedUntil.setDate(snoozedUntil.getDate() + days);
        const row = queue[idx]!;
        busy = true;
        try {
          await recordAttentionAction(row.emailId, row.runId, "snoozed", undefined, snoozedUntil);
          const label = days === 1 ? "tomorrow" : days === 3 ? "3 days" : "1 week";
          showStatus(`Snoozed until ${label}`);
          removeCurrentAndAdvance();
        } catch (err) {
          showStatus(`Error: ${err}`);
          mode = { type: "list" };
        }
        busy = false;
        return;
      }
      return;
    }

    // --- Note capture mode ---
    if (mode.type === "note") {
      if (key === "\r" || key === "\n") {
        // Submit
        const note = mode.note.trim() || undefined;
        const row = queue[idx]!;
        mode = { type: "list" };
        busy = true;
        try {
          await recordAttentionAction(row.emailId, row.runId, "acted", note);
          await archiveEmail(session, mailboxIds, row.emailId);
          showStatus(note ? `Acted: "${truncate(note, 40)}"` : "Acted \u2713");
          removeCurrentAndAdvance();
        } catch (err) {
          showStatus(`Error: ${err}`);
        }
        busy = false;
        return;
      }
      if (key === "\x7f" || key === "\x08") {
        // Backspace
        mode = { type: "note", note: mode.note.slice(0, -1) };
        render();
        return;
      }
      // Printable character
      if (key.length === 1 && key >= " ") {
        mode = { type: "note", note: mode.note + key };
        render();
        return;
      }
      return;
    }

    // --- List mode navigation ---
    if (key === "\x1b[A" || key === "k") {
      if (idx > 0) { idx--; render(); }
      return;
    }
    if (key === "\x1b[B" || key === "j") {
      if (idx < queue.length - 1) { idx++; render(); }
      return;
    }
    if (key === "g") { idx = 0; render(); return; }
    if (key === "G") { idx = queue.length - 1; render(); return; }

    // a = act
    if (key === "a") {
      mode = { type: "note", note: "" };
      render();
      return;
    }

    // s = snooze
    if (key === "s") {
      mode = { type: "snooze" };
      render();
      return;
    }
  });
}
```

### Step 2: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Expected: no errors

### Step 3: Smoke test the TUI

```bash
npm run act
```

Expected: TUI renders with attention email list, j/k navigation works, detail panel shows, `q` exits cleanly

### Step 4: Commit

```bash
git add src/act.ts
git commit -m "feat: implement attention processing TUI with act, snooze, and batch navigation"
```

---

## Task 5: Final wiring and verification

**Files:**
- Modify: `package.json` (verify `act` script is present from Task 3)

### Step 1: Verify `package.json` has the `act` script

```json
"act": "doppler run -- tsx src/act.ts"
```

### Step 2: Full compile check

```bash
npx tsc --noEmit
```

Expected: no errors

### Step 3: Verify non-TTY fallback

```bash
npm run act | head -20
```

Expected: plain text list of attention emails (no TUI escape codes)

### Step 4: Verify `--batch` flag

```bash
npm run act -- --batch 3
```

Expected: TUI shows max 3 emails in batch, header reflects count

### Step 5: Commit docs

```bash
git add docs/plans/
git commit -m "docs: add attention processing design and implementation plan"
```

### Step 6: Final commit if needed

```bash
git status
```

If any uncommitted changes remain, commit them with an appropriate message.

---

## Implementation Notes

- `jmapRequest` is not exported from `jmap.ts` — the new functions `fetchEmailBodies` and `archiveEmail` call it internally (same file), which is correct
- The `ON CONFLICT DO NOTHING` in `recordAttentionAction` prevents duplicate rows if called twice for the same email — safe to retry
- The `DISTINCT ON` query in `getAttentionQueue` handles the edge case of an email appearing in multiple triage runs — always uses the most recent classification
- Body trimming is done at the JMAP level (`maxBodyValueBytes: 2048`) and again in code — belt and suspenders
- The TUI `mode` discriminated union makes state transitions explicit and type-safe
