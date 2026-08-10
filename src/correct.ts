import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  ensureOptimizationTables,
  getRecentClassifications,
  insertCorrection,
} from "./db.js";
import type { Tier } from "./types.js";

const TIERS: Tier[] = ["auto-delete", "auto-archive", "confirm", "attention"];

// ANSI escape codes
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
};

const TIER_COLOR: Record<string, string> = {
  "auto-delete": ESC.red,
  "auto-archive": ESC.yellow,
  "confirm": ESC.cyan,
  "attention": ESC.green,
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 3) + "..." : s;
}

function dimLine(s: string): string {
  return `${ESC.dim}${s}${ESC.reset}`;
}

// --- Direct (non-interactive) correction ---

async function directCorrection(emailId: string, correctedTier: string) {
  if (!TIERS.includes(correctedTier as Tier)) {
    console.error(`Invalid tier: ${correctedTier}`);
    console.error(`Valid tiers: ${TIERS.join(", ")}`);
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
}

// --- Plain text fallback (non-TTY) ---

function printPlain(rows: ReturnType<typeof formatRows>) {
  console.log("Recent classifications:\n");
  for (const c of rows) {
    const corrected = c.correctedTier ? ` (corrected → ${c.correctedTier})` : "";
    console.log(`  ${c.emailId}`);
    console.log(`    ${c.tier}${corrected}  ${c.from}`);
    console.log(`    ${c.subject}`);
    console.log(`    ${c.reason}`);
    console.log();
  }
  console.log("To correct: npm run correct -- <email_id> <tier>");
  console.log(`Valid tiers: ${TIERS.join(", ")}`);
}

type Row = Awaited<ReturnType<typeof getRecentClassifications>>[number];

function formatRows(rows: Row[]) {
  return rows;
}

// --- Interactive TUI ---

async function launchTUI() {
  const rows = await getRecentClassifications(50);

  if (rows.length === 0) {
    console.log("No recent classifications found.");
    return;
  }

  const { stdin, stdout } = process;

  if (!stdin.isTTY) {
    printPlain(rows);
    return;
  }

  let idx = 0;
  let scroll = 0;
  let msg: string | null = null;
  let msgTimer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(ESC.hideCursor);

  function visibleCount(): number {
    const termHeight = stdout.rows || 24;
    // Reserve: header(2) + scroll indicator(1) + separator(1) + detail(2) + message(2) + separator(1) + help(4) = 13
    return Math.max(1, Math.floor((termHeight - 13) / 2));
  }

  function render() {
    const w = stdout.columns || 80;
    const vis = visibleCount();

    // Adjust scroll to keep selection visible
    if (idx < scroll) scroll = idx;
    if (idx >= scroll + vis) scroll = idx - vis + 1;

    let s = ESC.clear;

    // Header
    s += `${ESC.bold} Email Triage Review${ESC.reset}  ${ESC.dim}${idx + 1} of ${rows.length}${ESC.reset}\n`;
    s += dimLine("\u2500".repeat(w)) + "\n";

    // Classification list
    const end = Math.min(scroll + vis, rows.length);
    for (let i = scroll; i < end; i++) {
      const row = rows[i]!;
      const sel = i === idx;
      const cursor = sel ? "\u25b8" : " ";
      const tier = row.correctedTier ?? row.tier;
      const tc = TIER_COLOR[tier] ?? "";
      const label = tier.padEnd(14);
      const corr = row.correctedTier ? ` ${ESC.dim}(was ${row.tier})${ESC.reset}` : "";
      const from = truncate(row.from, 40);
      const subj = truncate(row.subject, w - 4);

      if (sel) {
        s += `${ESC.bold}${cursor} ${tc}${label}${ESC.reset} ${ESC.bold}${from}${corr}${ESC.reset}\n`;
        s += `${ESC.bold}  ${subj}${ESC.reset}\n`;
      } else {
        s += `${cursor} ${tc}${label}${ESC.reset} ${ESC.dim}${from}${corr}${ESC.reset}\n`;
        s += `  ${ESC.dim}${subj}${ESC.reset}\n`;
      }
    }

    // Pad remaining list space
    for (let i = (end - scroll) * 2; i < vis * 2; i++) s += "\n";

    // Scroll indicator
    const below = rows.length - end;
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
    s += dimLine("\u2500".repeat(w)) + "\n";
    const r = rows[idx]!;
    s += `${ESC.dim}Reason:${ESC.reset} ${truncate(r.reason, w - 10)}\n`;
    s += `${ESC.dim}Received:${ESC.reset} ${r.receivedAt.substring(0, 10)}  ${ESC.dim}ID:${ESC.reset} ${r.emailId}\n`;

    // Status message
    if (msg) {
      s += `\n${ESC.bold}  ${msg}${ESC.reset}\n`;
    } else {
      s += "\n\n";
    }

    // Help bar
    s += dimLine("\u2500".repeat(w)) + "\n";
    s += "\n";
    s += `${ESC.dim}\u2191/\u2193${ESC.reset} Navigate  `;
    s += `${ESC.red}1${ESC.reset}${ESC.dim} delete${ESC.reset}  `;
    s += `${ESC.yellow}2${ESC.reset}${ESC.dim} archive${ESC.reset}  `;
    s += `${ESC.cyan}3${ESC.reset}${ESC.dim} confirm${ESC.reset}  `;
    s += `${ESC.green}4${ESC.reset}${ESC.dim} attention${ESC.reset}  `;
    s += `${ESC.dim}q${ESC.reset} Quit`;
    s += "\n\n";

    stdout.write(s);
  }

  function showMsg(m: string) {
    msg = m;
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      msg = null;
      render();
    }, 2000);
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
    // Ctrl+C or q to quit
    if (key === "\x03" || key === "q") {
      cleanup();
      await closeDb();
      process.exit(0);
    }

    if (busy) return;

    // Arrow up / k
    if (key === "\x1b[A" || key === "k") {
      if (idx > 0) { idx--; render(); }
      return;
    }
    // Arrow down / j
    if (key === "\x1b[B" || key === "j") {
      if (idx < rows.length - 1) { idx++; render(); }
      return;
    }
    // Page up
    if (key === "\x1b[5~") {
      idx = Math.max(0, idx - visibleCount());
      render();
      return;
    }
    // Page down
    if (key === "\x1b[6~") {
      idx = Math.min(rows.length - 1, idx + visibleCount());
      render();
      return;
    }
    // g = top, G = bottom
    if (key === "g") { idx = 0; render(); return; }
    if (key === "G") { idx = rows.length - 1; render(); return; }

    // 1-4 to set tier
    if (key >= "1" && key <= "4") {
      const tier = TIERS[parseInt(key) - 1]!;
      const row = rows[idx]!;
      const current = row.correctedTier ?? row.tier;

      if (current === tier) {
        showMsg(`Already ${tier}`);
        return;
      }

      busy = true;
      try {
        const result = await insertCorrection(row.emailId, tier);
        if (!result) {
          showMsg("Error: classification not found");
        } else {
          row.correctedTier = tier;
          showMsg(`${row.tier} \u2192 ${tier}`);
        }
      } catch (err) {
        showMsg(`Error: ${err}`);
      }
      busy = false;
      return;
    }
  });
}

// --- Entry point ---

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");

  initDb();
  await ensureCorrectionsTable();
  await ensureOptimizationTables();

  const args = process.argv.slice(2);

  // Direct correction mode: npm run correct -- <email_id> <tier>
  if (args.length === 2) {
    await directCorrection(args[0]!, args[1]!);
    await closeDb();
    return;
  }

  if (args.length > 0 && args.length !== 2) {
    console.error("Usage: npm run correct -- <email_id> <corrected_tier>");
    console.error("       npm run correct              (interactive review)");
    process.exit(1);
  }

  // No args: launch interactive TUI
  await launchTUI();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try {
    await closeDb();
  } catch {}
  process.exit(1);
});
