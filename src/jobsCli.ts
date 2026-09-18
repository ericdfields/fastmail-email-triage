import { readFile } from "node:fs/promises";
import { closeDb, ensureOptimizationTables, initDb } from "./db.js";
import { getSession } from "./jmap.js";
import { runPendingResearch } from "./jobResearch.js";
import { parseConnectionsCsv, parseProfile } from "./jobs.js";
import {
  ensureJobTables,
  getJobs,
  getJobStats,
  getLatestJobProfile,
  importConnections,
  listPipeline,
  recordJobDecision,
  saveJobProfile,
  setPipelineCompany,
} from "./jobsDb.js";
import type { JobRow } from "./jobsDb.js";
import { processJobAlerts } from "./jobScoring.js";

const USAGE = `Usage: npm run jobs -- <command>

  profile set <file>             Save a new profile version (markdown with a json job-rules block)
  profile check <file>           Parse a profile file without saving it
  profile show                   Print the current profile version and rules
  process [--days N] [--limit N] [--dry-run]
                                 Score new job-alert emails (default: 3 days, 100 emails)
  research [--limit N]           Run queued research for confirmed yays (default 3)
  nays                           Review hidden nays: y un-nays (queues research), n confirms
  connections import <csv>       Load LinkedIn's Connections.csv export
  pipeline add <company> [--stage TEXT]
  pipeline remove <company>
  pipeline list
  stats                          Screen verdicts against your decisions, per profile version`;

const ESC = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

function flag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} needs a positive whole number`);
  return value;
}

function textFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function positional(args: string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
}

function salary(job: JobRow): string {
  if (job.salaryMin === null && job.salaryMax === null) return "pay not listed";
  const k = (n: number | null) => (n === null ? "?" : `$${Math.round(n / 1000)}K`);
  return `${k(job.salaryMin)}–${k(job.salaryMax)}`;
}

async function profileCommand(args: string[]) {
  const [action, file] = args;
  if (action === "show") {
    const profile = await getLatestJobProfile();
    if (!profile) return console.log("No profile saved.");
    console.log(`Profile v${profile.version} (${profile.text.length} characters)`);
    console.log(JSON.stringify(profile.rules, null, 2));
    return;
  }
  if ((action === "set" || action === "check") && file) {
    const markdown = await readFile(file, "utf8");
    const { rules } = parseProfile(markdown);
    console.log(
      `Parsed: floor ${rules.minBaseSalaryUsd ?? "none"}, ${rules.nayTitlePatterns.length} title rules, ` +
        `${rules.avoidCompanies.length} avoided companies, ${rules.highInterestCompanies.length} high-interest companies`
    );
    if (action === "set") console.log(`Saved profile v${await saveJobProfile(markdown)}`);
    return;
  }
  throw new Error(USAGE);
}

async function pipelineCommand(args: string[]) {
  const [action, ...rest] = positional(args);
  const company = rest.join(" ").trim();
  if (action === "list") {
    const rows = await listPipeline();
    if (rows.length === 0) return console.log("Pipeline is empty.");
    for (const row of rows) {
      console.log(`${row.active ? "active  " : "inactive"}  ${row.company}${row.stage ? `  (${row.stage})` : ""}`);
    }
    return;
  }
  if ((action === "add" || action === "remove") && company) {
    await setPipelineCompany(company, action === "add", textFlag(args, "--stage"));
    console.log(`${action === "add" ? "Added" : "Removed"}: ${company}`);
    return;
  }
  throw new Error(USAGE);
}

async function statsCommand() {
  const rows = await getJobStats();
  if (rows.length === 0) return console.log("No jobs scored yet.");
  console.log("profile  screen   jobs  you:yay  you:nay");
  for (const row of rows) {
    console.log(
      `v${String(row.profileVersion).padEnd(7)} ${row.verdict.padEnd(7)} ${String(row.total).padStart(5)}` +
        `  ${String(row.saidYay).padStart(7)}  ${String(row.saidNay).padStart(7)}`
    );
  }
  console.log("\nScreen nays you marked yay are false negatives; fix them in the profile.");
}

async function reviewNays() {
  const rows = await getJobs("nay", 200);
  if (rows.length === 0) return console.log("No hidden nays to review.");

  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    for (const job of rows) {
      console.log(`${job.jobId}  ${job.title} at ${job.company}\n      ${job.reason}`);
    }
    return;
  }

  let idx = 0;
  let msg = "";
  let busy = false;
  const done = new Map<number, "yay" | "nay">();

  const render = () => {
    const w = stdout.columns || 80;
    const job = rows[idx]!;
    const mark = done.get(job.jobId);
    let s = ESC.clear;
    s += `${ESC.bold} Hidden nays${ESC.reset}  ${ESC.dim}${idx + 1} of ${rows.length}, ${done.size} reviewed${ESC.reset}\n`;
    s += `${ESC.dim}${"─".repeat(w)}${ESC.reset}\n\n`;
    s += `${ESC.bold}${job.title}${ESC.reset}\n${job.company}\n\n`;
    s += `${ESC.dim}Where:${ESC.reset}  ${job.location ?? "unknown"} (${job.workplace})\n`;
    s += `${ESC.dim}Pay:${ESC.reset}    ${salary(job)}\n`;
    s += `${ESC.dim}Why:${ESC.reset}    ${job.reason}\n`;
    s += `${ESC.dim}By:${ESC.reset}     ${job.decidedBy} (model said ${job.modelVerdict}, fit ${job.fitScore}), profile v${job.profileVersion}\n`;
    if (job.warmConnections.length > 0) s += `${ESC.dim}Warm:${ESC.reset}   ${job.warmConnections.join("; ")}\n`;
    if (job.url) s += `${ESC.dim}Link:${ESC.reset}   ${job.url}\n`;
    s += "\n";
    if (mark === "yay") s += `${ESC.green}Un-nayed: research queued${ESC.reset}\n`;
    else if (mark === "nay") s += `${ESC.red}Nay confirmed${ESC.reset}\n`;
    else s += "\n";
    s += `\n${msg}\n${ESC.dim}${"─".repeat(w)}${ESC.reset}\n`;
    s += `${ESC.green}y${ESC.reset} un-nay  ${ESC.red}n${ESC.reset} confirm nay  ${ESC.dim}j/k move  q quit${ESC.reset}\n`;
    stdout.write(s);
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.write(ESC.hideCursor);
  stdout.on("resize", render);
  render();

  await new Promise<void>((resolve) => {
    stdin.on("data", async (key: string) => {
      if (key === "\x03" || key === "q") {
        stdout.write(ESC.clear + ESC.showCursor);
        stdin.setRawMode(false);
        stdin.pause();
        resolve();
        return;
      }
      if (busy) return;
      if ((key === "j" || key === "\x1b[B") && idx < rows.length - 1) idx++;
      else if ((key === "k" || key === "\x1b[A") && idx > 0) idx--;
      else if (key === "y" || key === "n") {
        const job = rows[idx]!;
        const decision = key === "y" ? "yay" : "nay";
        busy = true;
        try {
          await recordJobDecision(job.jobId, decision);
          done.set(job.jobId, decision);
          msg = "";
          if (idx < rows.length - 1) idx++;
        } catch (error) {
          msg = `Error: ${error instanceof Error ? error.message : error}`;
        }
        busy = false;
      }
      render();
    });
  });

  const yays = [...done.values()].filter((d) => d === "yay").length;
  console.log(`Reviewed ${done.size}: ${yays} un-nayed, ${done.size - yays} confirmed.`);
  if (yays > 0) console.log("Research runs on the next triage, or now with: npm run jobs -- research");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "profile" && args[0] === "check" && args[1]) {
    await profileCommand(args);
    return;
  }

  initDb();
  await ensureOptimizationTables();
  await ensureJobTables();

  switch (command) {
    case "profile":
      await profileCommand(args);
      break;
    case "process": {
      if (!process.env.FASTMAIL_API_TOKEN) throw new Error("Missing FASTMAIL_API_TOKEN");
      const session = await getSession();
      await processJobAlerts({
        session,
        days: flag(args, "--days", 3),
        limit: flag(args, "--limit", 100),
        dryRun: args.includes("--dry-run"),
      });
      if (args.includes("--dry-run")) console.log("Dry run: nothing saved.");
      break;
    }
    case "research": {
      const count = await runPendingResearch(flag(args, "--limit", 3));
      console.log(count === 0 ? "No research queued." : `Researched ${count} job(s).`);
      break;
    }
    case "nays":
      await reviewNays();
      break;
    case "connections": {
      const [action, file] = args;
      if (action !== "import" || !file) throw new Error(USAGE);
      const connections = parseConnectionsCsv(await readFile(file, "utf8"));
      const imported = await importConnections(connections);
      console.log(`Imported ${imported} of ${connections.length} connections.`);
      break;
    }
    case "pipeline":
      await pipelineCommand(args);
      break;
    case "stats":
      await statsCommand();
      break;
    default:
      throw new Error(USAGE);
  }
}

main()
  .then(async () => {
    try {
      await closeDb();
    } catch {}
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await closeDb();
    } catch {}
    process.exit(1);
  });
