import { BACKUP_MODEL, PRIMARY_MODEL } from "./classifier.js";
import { getTodayModelSpend, recordModelCall } from "./db.js";
import { fetchEmailContent, queryEmailsFromSenders } from "./jmap.js";
import {
  alertToText,
  applyJobRules,
  buildScoringSystemPrompt,
  buildScoringUserPrompt,
  jobAlertSenders,
  jobKey,
  normalizeCompany,
  parseScoringResponse,
  SCORING_SCHEMA,
} from "./jobs.js";
import type { AlertText, JobProfile, RuledJob, ScoredJob } from "./jobs.js";
import {
  findJobIdsByKey,
  getCompanyContext,
  getLatestJobProfile,
  getScoringExamples,
  getSettledAlertEmailIds,
  insertJob,
  recordAlertEmail,
  recordSighting,
} from "./jobsDb.js";
import { callJson } from "./openrouter.js";
import type { CallHooks } from "./openrouter.js";
import type { EmailSummary, JMAPSession } from "./types.js";

const DEFAULT_JOB_BUDGET_USD = 2;

export function jobBudgetUsd(): number {
  const configured = Number(process.env.JOB_DAILY_BUDGET_USD ?? DEFAULT_JOB_BUDGET_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_JOB_BUDGET_USD;
}

/** Accounting hooks shared by scoring and research: separate budget, purpose = jobs. */
export function jobCallHooks(log: (line: string) => void): CallHooks {
  return {
    beforeAttempt: async () => {
      const spent = await getTodayModelSpend("jobs");
      const budget = jobBudgetUsd();
      if (spent >= budget) {
        const error = new Error(`Daily job budget reached ($${spent.toFixed(4)} of $${budget.toFixed(2)})`);
        error.name = "DailyBudgetExceededError";
        throw error;
      }
    },
    onAttempt: async (attempt) => {
      await recordModelCall(null, attempt, "jobs");
      log(
        `    ${attempt.model} ${attempt.success ? "ok" : "failed"}: ` +
          `${attempt.usage.inputTokens} in, ${attempt.usage.outputTokens} out, ` +
          `$${attempt.usage.costUsd.toFixed(5)}, ${attempt.latencyMs}ms`
      );
    },
  };
}

async function scoreAlert(
  profile: JobProfile,
  alert: AlertText,
  hooks: CallHooks
): Promise<{ jobs: ScoredJob[]; model: string }> {
  const examples = await getScoringExamples();
  const request = {
    system: buildScoringSystemPrompt(profile.text),
    user: buildScoringUserPrompt(alert, examples),
    schemaName: "job_alert_screen",
    schema: SCORING_SCHEMA,
    maxTokens: 4000,
    timeoutMs: 90_000,
  };

  let primaryError: unknown;
  for (const [index, model] of [PRIMARY_MODEL, BACKUP_MODEL].entries()) {
    try {
      const { content } = await callJson({ ...request, model, attempt: index + 1 }, hooks);
      return { jobs: parseScoringResponse(content, alert), model };
    } catch (error) {
      if (error instanceof Error && error.name === "DailyBudgetExceededError") throw error;
      if (index === 0) {
        primaryError = error;
        continue;
      }
      throw new AggregateError([primaryError, error], "Job scoring failed with both models");
    }
  }
  throw new Error("unreachable");
}

export interface JobPipelineOptions {
  session: JMAPSession;
  days: number;
  limit: number;
  dryRun: boolean;
  log?: (line: string) => void;
}

export interface JobPipelineSummary {
  alerts: number;
  newJobs: number;
  repeats: number;
  verdicts: Record<"yay" | "maybe" | "nay", number>;
  inPipeline: number;
  failed: number;
}

/** Find new job-alert emails, split them into jobs, score new jobs, and store the results. */
export async function processJobAlerts(options: JobPipelineOptions): Promise<JobPipelineSummary> {
  const log = options.log ?? console.log;
  const summary: JobPipelineSummary = {
    alerts: 0,
    newJobs: 0,
    repeats: 0,
    verdicts: { yay: 0, maybe: 0, nay: 0 },
    inPipeline: 0,
    failed: 0,
  };

  const profile = await getLatestJobProfile();
  if (!profile) {
    log("Jobs: no profile saved; skipping (npm run jobs -- profile set <file>)");
    return summary;
  }

  const since = new Date(Date.now() - options.days * 86_400_000).toISOString();
  const found = await queryEmailsFromSenders(options.session, jobAlertSenders(profile.rules), since, options.limit);
  const settled = await getSettledAlertEmailIds(found.map((email) => email.id));
  const pending = found.filter((email) => !settled.has(email.id));
  log(`Jobs: ${found.length} alert emails in ${options.days} days, ${pending.length} new (profile v${profile.version})`);

  const hooks = jobCallHooks(log);
  // Dry runs write nothing, so remember keys here to count cross-alert repeats correctly.
  const seenThisRun = new Map<string, number>();

  for (let start = 0; start < pending.length; start += 10) {
    const chunk = pending.slice(start, start + 10);
    const bodies = await fetchEmailContent(options.session, chunk.map((email) => email.id));

    for (const email of chunk) {
      summary.alerts++;
      try {
        const alert = alertToText(bodies.get(email.id) ?? { text: null, html: null });
        const jobs = await processAlert(email, alert, profile, hooks, options, summary, seenThisRun, log);
        if (!options.dryRun) {
          await recordAlertEmail({
            ...alertMeta(email),
            status: "processed",
            jobsFound: jobs,
            profileVersion: profile.version,
          });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "DailyBudgetExceededError") {
          log(`Jobs: ${error.message}; stopping`);
          return summary;
        }
        summary.failed++;
        const message = error instanceof Error ? error.message : String(error);
        log(`  Failed: ${email.subject}: ${message}`);
        if (!options.dryRun) {
          await recordAlertEmail({
            ...alertMeta(email),
            status: "failed",
            jobsFound: 0,
            profileVersion: profile.version,
            error: message,
          });
        }
      }
    }
  }

  log(
    `Jobs: ${summary.newJobs} new (${summary.verdicts.yay} yay, ${summary.verdicts.maybe} maybe, ` +
      `${summary.verdicts.nay} nay), ${summary.repeats} repeats, ${summary.inPipeline} already in process, ` +
      `${summary.failed} failed`
  );
  return summary;
}

function alertMeta(email: EmailSummary) {
  return {
    emailId: email.id,
    sender: email.from.map((from) => from.email.toLowerCase()).join(", "),
    subject: email.subject.slice(0, 300),
    receivedAt: email.receivedAt,
  };
}

async function processAlert(
  email: EmailSummary,
  alert: AlertText,
  profile: JobProfile,
  hooks: CallHooks,
  options: JobPipelineOptions,
  summary: JobPipelineSummary,
  seenThisRun: Map<string, number>,
  log: (line: string) => void
): Promise<number> {
  log(`  ${email.subject} (${alert.links.size} job links)`);
  if (alert.text.length === 0) return 0;

  const { jobs, model } = await scoreAlert(profile, alert, hooks);
  const keys = jobs.map((job) => jobKey(job.company, job.title));
  const known = await findJobIdsByKey(keys);
  const context = await getCompanyContext(jobs.map((job) => normalizeCompany(job.company)));

  for (const [index, job] of jobs.entries()) {
    const key = keys[index]!;
    const companyKey = normalizeCompany(job.company);
    const existing = known.get(key) ?? seenThisRun.get(key);

    if (existing !== undefined) {
      summary.repeats++;
      if (!options.dryRun) await recordSighting(existing, email.id, job.source, job.url, email.receivedAt);
      continue;
    }

    const ruled: RuledJob = applyJobRules(job, profile.rules, {
      warmConnections: context.warm.get(companyKey) ?? [],
      inPipeline: context.pipeline.has(companyKey),
    });
    summary.newJobs++;
    summary.verdicts[ruled.verdict]++;
    if (context.pipeline.has(companyKey)) summary.inPipeline++;

    log(`    ${ruled.verdict.padEnd(5)} ${String(ruled.fitScore).padStart(3)}  ${ruled.title} at ${ruled.company}: ${ruled.reason}`);
    if (options.dryRun) {
      seenThisRun.set(key, -1);
      continue;
    }

    const jobId = await insertJob(key, ruled, model, profile.version, email.receivedAt);
    seenThisRun.set(key, jobId);
    await recordSighting(jobId, email.id, ruled.source, ruled.url, email.receivedAt);
  }
  return jobs.length;
}
