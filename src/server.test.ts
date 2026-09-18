import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUnsubscribeCandidates: vi.fn(),
  startUnsubscribeAction: vi.fn(),
  finishUnsubscribeAction: vi.fn(),
  keepUnsubscribeSender: vi.fn(),
  getSession: vi.fn(),
  getMailboxIds: vi.fn(),
  fetchUnsubscribeHeaders: vi.fn(),
  unsubscribeOneClick: vi.fn(),
  getJobs: vi.fn(),
  getJobCounts: vi.fn(),
  recordJobDecision: vi.fn(),
  retryJobResearch: vi.fn(),
  runPendingResearch: vi.fn(),
}));

vi.mock("./db.js", () => ({
  initDb: vi.fn(),
  closeDb: vi.fn(),
  ensureCorrectionsTable: vi.fn(),
  ensureOptimizationTables: vi.fn(),
  getRecentClassifications: vi.fn(),
  insertCorrection: vi.fn(),
  ensureAttentionActionsTable: vi.fn(),
  getAttentionQueue: vi.fn(),
  getAttentionQueueCount: vi.fn(),
  recordAttentionAction: vi.fn(),
  ensureUnsubscribeActionsTable: vi.fn(),
  getUnsubscribeCandidates: mocks.getUnsubscribeCandidates,
  startUnsubscribeAction: mocks.startUnsubscribeAction,
  finishUnsubscribeAction: mocks.finishUnsubscribeAction,
  keepUnsubscribeSender: mocks.keepUnsubscribeSender,
}));

vi.mock("./jmap.js", () => ({
  getSession: mocks.getSession,
  getMailboxIds: mocks.getMailboxIds,
  fetchEmailBodies: vi.fn(),
  archiveEmail: vi.fn(),
  applyTierAction: vi.fn(),
  fetchUnsubscribeHeaders: mocks.fetchUnsubscribeHeaders,
}));

vi.mock("./unsubscribe.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./unsubscribe.js")>();
  return { ...original, unsubscribeOneClick: mocks.unsubscribeOneClick };
});

vi.mock("./jobsDb.js", () => ({
  ensureJobTables: vi.fn(),
  getJobs: mocks.getJobs,
  getJobCounts: mocks.getJobCounts,
  recordJobDecision: mocks.recordJobDecision,
  retryJobResearch: mocks.retryJobResearch,
  JOB_VIEWS: ["review", "yay", "nay", "in-process", "passed"],
}));

vi.mock("./jobResearch.js", () => ({
  runPendingResearch: mocks.runPendingResearch,
}));

import { app } from "./server.js";

const candidate = {
  sender: "news@example.com",
  emailId: "email-9",
  messageCount: 4,
  latestSubject: "Latest issue",
  recentSubjects: ["Latest issue", "Earlier issue"],
  lastReceivedAt: "2026-08-01T12:00:00.000Z",
};

const authenticatedHeaders = {
  emailId: "email-9",
  urls: ["https://news.example.com/leave?token=private"],
  listUnsubscribePost: "List-Unsubscribe=One-Click",
  authenticationResults: ["mx.fastmail.com; dkim=pass header.d=example.com"],
  dkimSignatures: [
    "v=1; d=example.com; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=abc",
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUnsubscribeCandidates.mockResolvedValue([candidate]);
  mocks.getSession.mockResolvedValue({ apiUrl: "https://api.fastmail.com/jmap", accountId: "a1" });
  mocks.getMailboxIds.mockResolvedValue({ inbox: "inbox", archive: "archive", trash: "trash" });
  mocks.fetchUnsubscribeHeaders.mockResolvedValue(
    new Map([[candidate.emailId, authenticatedHeaders]])
  );
  mocks.startUnsubscribeAction.mockResolvedValue(11);
  mocks.unsubscribeOneClick.mockResolvedValue({ httpStatus: 204, targetHost: "news.example.com" });
  mocks.getJobs.mockResolvedValue([]);
  mocks.recordJobDecision.mockResolvedValue(true);
  mocks.runPendingResearch.mockResolvedValue(0);
});

describe("unsubscribe API", () => {
  it("returns audit-safe candidates without tokenized URLs", async () => {
    const response = await app.request("/api/unsubscribe/candidates");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        sender: "news@example.com",
        emailId: "email-9",
        eligible: true,
        method: "one-click",
        targetHost: "news.example.com",
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("token=private");
    expect(JSON.stringify(body)).not.toContain("urls");
  });

  it("rejects empty and stale approval batches before an outbound request", async () => {
    const empty = await app.request("/api/unsubscribe/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    const stale = await app.request("/api/unsubscribe/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ sender: "other@example.com", emailId: "wrong" }] }),
    });

    expect(empty.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(mocks.unsubscribeOneClick).not.toHaveBeenCalled();
    expect(mocks.startUnsubscribeAction).not.toHaveBeenCalled();
  });

  it("re-fetches and executes a valid approval, then completes its audit row", async () => {
    const response = await app.request("/api/unsubscribe/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ sender: candidate.sender, emailId: candidate.emailId }] }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.fetchUnsubscribeHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "a1" }),
      ["email-9"]
    );
    expect(mocks.unsubscribeOneClick).toHaveBeenCalledWith(
      "https://news.example.com/leave?token=private"
    );
    expect(mocks.finishUnsubscribeAction).toHaveBeenCalledWith(11, "success", 204);
    expect(body.results).toEqual([
      expect.objectContaining({ emailId: "email-9", success: true, httpStatus: 204 }),
    ]);
  });

  it("does not execute one-click when DKIM does not cover both headers", async () => {
    mocks.fetchUnsubscribeHeaders.mockResolvedValue(
      new Map([
        [
          candidate.emailId,
          { ...authenticatedHeaders, dkimSignatures: ["v=1; d=example.com; h=from:list-unsubscribe"] },
        ],
      ])
    );

    const response = await app.request("/api/unsubscribe/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ sender: candidate.sender, emailId: candidate.emailId }] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.unsubscribeOneClick).not.toHaveBeenCalled();
    expect(mocks.finishUnsubscribeAction).toHaveBeenCalledWith(
      11,
      "failed",
      undefined,
      "No current RFC 8058 one-click HTTPS endpoint"
    );
  });

  it("records Keep only for a current exact candidate", async () => {
    const response = await app.request("/api/unsubscribe/keep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ sender: " NEWS@EXAMPLE.COM ", emailId: "email-9" }] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.keepUnsubscribeSender).toHaveBeenCalledWith("news@example.com", "email-9");
  });
});

function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("jobs API", () => {
  it("lists a known view and rejects unknown views", async () => {
    const ok = await app.request("/api/jobs?view=nay&limit=500&offset=-4");
    const bad = await app.request("/api/jobs?view=everything");

    expect(ok.status).toBe(200);
    expect(mocks.getJobs).toHaveBeenCalledWith("nay", 100, 0);
    expect(bad.status).toBe(400);
  });

  it("records a yay and starts research", async () => {
    const response = await postJson("/api/jobs/decision", { jobId: 5, decision: "yay", note: "  warm intro  " });

    expect(response.status).toBe(200);
    expect(mocks.recordJobDecision).toHaveBeenCalledWith(5, "yay", "warm intro");
    await vi.waitFor(() => expect(mocks.runPendingResearch).toHaveBeenCalled());
  });

  it("records a nay without starting research", async () => {
    const response = await postJson("/api/jobs/decision", { jobId: 5, decision: "nay" });

    expect(response.status).toBe(200);
    expect(mocks.recordJobDecision).toHaveBeenCalledWith(5, "nay", undefined);
    expect(mocks.runPendingResearch).not.toHaveBeenCalled();
  });

  it("validates decisions", async () => {
    expect((await postJson("/api/jobs/decision", { jobId: "5", decision: "yay" })).status).toBe(400);
    expect((await postJson("/api/jobs/decision", { jobId: 5, decision: "maybe" })).status).toBe(400);
    mocks.recordJobDecision.mockResolvedValue(false);
    expect((await postJson("/api/jobs/decision", { jobId: 99, decision: "nay" })).status).toBe(404);
  });

  it("retries research only when there is something to retry", async () => {
    mocks.retryJobResearch.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await postJson("/api/jobs/research/retry", { jobId: 5 })).status).toBe(200);
    expect((await postJson("/api/jobs/research/retry", { jobId: 5 })).status).toBe(409);
  });
});

describe("web UI", () => {
  it("serves a page whose inline script parses", async () => {
    const html = await (await app.request("/")).text();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(html).toContain('data-tab="jobs"');
  });
});
