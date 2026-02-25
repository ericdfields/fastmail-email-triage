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

function dimLine(w: number): string {
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
    s += dimLine(w) + "\n";

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
    s += dimLine(w) + "\n";
    const r = queue[idx]!;
    const body = bodyMap.get(r.emailId) ?? "(no body preview)";
    s += `${ESC.dim}Body:${ESC.reset}   ${truncate(body, w - 8)}\n`;
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
      s += `${ESC.bold}  Note (enter to skip, ctrl+c to cancel): ${mode.note}\u2588${ESC.reset}\n`;
    } else if (mode.type === "snooze") {
      s += `${ESC.bold}  Snooze: ${ESC.reset}${ESC.cyan}1${ESC.reset} Tomorrow  ${ESC.cyan}2${ESC.reset} Three days  ${ESC.cyan}3${ESC.reset} One week  ${ESC.dim}esc Cancel${ESC.reset}\n`;
    } else {
      s += "\n";
    }

    // Help bar
    s += dimLine(w) + "\n";
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
    s += dimLine(w) + "\n\n";
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
      if (key === "\x1b") {
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
        mode = { type: "note", note: mode.note.slice(0, -1) };
        render();
        return;
      }
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

    if (key === "a") {
      mode = { type: "note", note: "" };
      render();
      return;
    }

    if (key === "s") {
      mode = { type: "snooze" };
      render();
      return;
    }
  });
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await closeDb(); } catch {}
  process.exit(1);
});
