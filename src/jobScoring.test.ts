import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findJobIdsByKey: vi.fn(),
  getCompanyContext: vi.fn(),
  getLatestJobProfile: vi.fn(),
  getScoringExamples: vi.fn(),
  getSettledAlertEmailIds: vi.fn(),
  insertJob: vi.fn(),
  recordAlertEmail: vi.fn(),
  recordSighting: vi.fn(),
  getTodayModelSpend: vi.fn(),
  recordModelCall: vi.fn(),
  queryEmailsFromSenders: vi.fn(),
  fetchEmailContent: vi.fn(),
}));

vi.mock("./jobsDb.js", () => ({
  findJobIdsByKey: mocks.findJobIdsByKey,
  getCompanyContext: mocks.getCompanyContext,
  getLatestJobProfile: mocks.getLatestJobProfile,
  getScoringExamples: mocks.getScoringExamples,
  getSettledAlertEmailIds: mocks.getSettledAlertEmailIds,
  insertJob: mocks.insertJob,
  recordAlertEmail: mocks.recordAlertEmail,
  recordSighting: mocks.recordSighting,
}));
vi.mock("./db.js", () => ({
  getTodayModelSpend: mocks.getTodayModelSpend,
  recordModelCall: mocks.recordModelCall,
}));
vi.mock("./jmap.js", () => ({
  queryEmailsFromSenders: mocks.queryEmailsFromSenders,
  fetchEmailContent: mocks.fetchEmailContent,
}));

import { processJobAlerts } from "./jobScoring.js";

const session = { apiUrl: "https://jmap.example", accountId: "acct" };
const email = (id: string) => ({
  id,
  threadId: `t-${id}`,
  subject: `Alert ${id}`,
  from: [{ name: "LinkedIn", email: "jobalerts-noreply@linkedin.com" }],
  receivedAt: "2026-09-16T12:00:00Z",
  preview: "",
  hasListUnsubscribe: false,
  listUnsubscribeUrls: null,
});

const scored = (title: string, company: string, verdict: string, link: string | null = null) => ({
  title, company, location: "Remote", workplace: "remote", salary_min: null, salary_max: null,
  link, verdict, fit: 70, reason: `${verdict} reason`,
});

function modelResponse(jobs: object[]) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ jobs }) } }], usage: { cost: 0.001 } }),
    { status: 200 }
  );
}

const html = (id: string) => `<a href="https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=x">Job</a>`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "test-key";
  mocks.getLatestJobProfile.mockResolvedValue({
    version: 3,
    text: "Profile",
    rules: { minBaseSalaryUsd: 150000, nayTitlePatterns: ["\\bproduct manager\\b"], avoidCompanies: [],
      highInterestCompanies: [], jobAlertSenders: [], bannedPhrases: [] },
  });
  mocks.getScoringExamples.mockResolvedValue([]);
  mocks.getSettledAlertEmailIds.mockResolvedValue(new Set(["old"]));
  mocks.getTodayModelSpend.mockResolvedValue(0);
  mocks.getCompanyContext.mockResolvedValue({
    warm: new Map([["beta", ["Pat Lee (CTO)"]]]),
    pipeline: new Set(["gamma"]),
  });
  mocks.findJobIdsByKey.mockResolvedValue(new Map([["known|staff engineer", 41]]));
  mocks.insertJob.mockResolvedValueOnce(101).mockResolvedValueOnce(102).mockResolvedValueOnce(103).mockResolvedValueOnce(104);
  mocks.queryEmailsFromSenders.mockResolvedValue([email("old"), email("e1")]);
  mocks.fetchEmailContent.mockResolvedValue(new Map([["e1", { text: null, html: html("111111111") }]]));
});

describe("processJobAlerts", () => {
  it("skips work when no profile is saved", async () => {
    mocks.getLatestJobProfile.mockResolvedValue(null);
    const summary = await processJobAlerts({ session, days: 3, limit: 10, dryRun: false, log: () => {} });
    expect(summary.alerts).toBe(0);
    expect(mocks.queryEmailsFromSenders).not.toHaveBeenCalled();
  });

  it("scores new alerts, applies rules and warm paths, and records repeats as sightings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(modelResponse([
      scored("Director of Engineering", "Acme", "yay", "J1"),
      scored("Senior Product Manager, AI", "Acme", "yay"),
      scored("Head of Platform", "Beta", "maybe"),
      scored("Engineering Manager", "Gamma", "yay"),
      scored("Staff Engineer", "Known", "yay"),
    ])));

    const summary = await processJobAlerts({ session, days: 3, limit: 10, dryRun: false, log: () => {} });

    expect(mocks.fetchEmailContent).toHaveBeenCalledWith(session, ["e1"]);
    expect(summary).toMatchObject({ alerts: 1, newJobs: 4, repeats: 1, inPipeline: 1, failed: 0,
      verdicts: { yay: 3, maybe: 0, nay: 1 } });

    const inserted = mocks.insertJob.mock.calls.map((call) => [call[1].title, call[1].verdict, call[1].decidedBy]);
    expect(inserted).toEqual([
      ["Director of Engineering", "yay", "model"],
      ["Senior Product Manager, AI", "nay", "rule"],
      ["Head of Platform", "yay", "warm-path"],
      ["Engineering Manager", "yay", "model"],
    ]);
    expect(mocks.insertJob.mock.calls[0]![1].url).toBe("https://www.linkedin.com/jobs/view/111111111/");
    expect(mocks.insertJob.mock.calls[0]!.slice(2)).toEqual(["openai/gpt-5.6-luna", 3, "2026-09-16T12:00:00Z"]);
    expect(mocks.recordSighting).toHaveBeenCalledWith(41, "e1", null, null, "2026-09-16T12:00:00Z");
    expect(mocks.recordAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      emailId: "e1", status: "processed", jobsFound: 5, profileVersion: 3,
    }));
    expect(mocks.recordModelCall).toHaveBeenCalledWith(null, expect.anything(), "jobs");
  });

  it("writes nothing on a dry run and counts cross-alert repeats", async () => {
    mocks.queryEmailsFromSenders.mockResolvedValue([email("e1"), email("e2")]);
    mocks.getSettledAlertEmailIds.mockResolvedValue(new Set());
    mocks.findJobIdsByKey.mockResolvedValue(new Map());
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
      modelResponse([scored("Director of Engineering", "Acme", "yay")])
    ));
    mocks.fetchEmailContent.mockResolvedValue(new Map([
      ["e1", { text: "Director of Engineering, Acme", html: null }],
      ["e2", { text: "Director of Engineering, Acme", html: null }],
    ]));

    const summary = await processJobAlerts({ session, days: 3, limit: 10, dryRun: true, log: () => {} });

    expect(summary).toMatchObject({ newJobs: 1, repeats: 1 });
    expect(mocks.insertJob).not.toHaveBeenCalled();
    expect(mocks.recordSighting).not.toHaveBeenCalled();
    expect(mocks.recordAlertEmail).not.toHaveBeenCalled();
  });

  it("falls back to the backup model, then records a failed alert", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const summary = await processJobAlerts({ session, days: 3, limit: 10, dryRun: false, log: () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).model).toBe("anthropic/claude-haiku-4.5");
    expect(summary.failed).toBe(1);
    expect(mocks.recordAlertEmail).toHaveBeenCalledWith(expect.objectContaining({ emailId: "e1", status: "failed" }));
  });

  it("stops without marking the alert failed when the job budget is spent", async () => {
    mocks.getTodayModelSpend.mockResolvedValue(50);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const summary = await processJobAlerts({ session, days: 3, limit: 10, dryRun: false, log: () => {} });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.failed).toBe(0);
    expect(mocks.recordAlertEmail).not.toHaveBeenCalled();
  });
});
