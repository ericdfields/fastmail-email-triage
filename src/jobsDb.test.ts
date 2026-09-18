import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function (this: Record<string, unknown>) {
      this.query = mockQuery;
      this.end = vi.fn();
    }),
  },
}));

import { initDb } from "./db.js";
import {
  claimResearch,
  ensureJobTables,
  getJobs,
  getSettledAlertEmailIds,
  importConnections,
  recordJobDecision,
  saveJobProfile,
  setPipelineCompany,
} from "./jobsDb.js";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgresql://test:test@localhost/test";
  initDb();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("ensureJobTables", () => {
  it("creates every job table idempotently", async () => {
    await ensureJobTables();
    const sql = mockQuery.mock.calls.map((call) => call[0] as string).join("\n");
    for (const table of [
      "job_profiles", "job_alert_emails", "jobs", "job_sightings", "job_decisions",
      "company_research", "job_research", "linkedin_connections", "active_pipeline",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(sql).not.toMatch(/DROP|TRUNCATE|DELETE/);
  });
});

describe("saveJobProfile", () => {
  it("stores text and parsed rules as a new version", async () => {
    mockQuery.mockResolvedValue({ rows: [{ version: 2 }] });
    await expect(saveJobProfile('Profile\n```json job-rules\n{"minBaseSalaryUsd": 1}\n```')).resolves.toBe(2);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("Profile");
    expect(JSON.parse(params[1] as string)).toMatchObject({ minBaseSalaryUsd: 1 });
  });
});

describe("getSettledAlertEmailIds", () => {
  it("treats repeatedly failed alerts as settled", async () => {
    mockQuery.mockResolvedValue({ rows: [{ email_id: "e1" }] });
    const ids = await getSettledAlertEmailIds(["e1", "e2"]);
    expect([...ids]).toEqual(["e1"]);
    expect(mockQuery.mock.calls[0]![0]).toContain("attempts >= $2");
    expect(mockQuery.mock.calls[0]![1]).toEqual([["e1", "e2"], 3]);
  });
});

describe("recordJobDecision", () => {
  it("queues research on yay", async () => {
    await expect(recordJobDecision(5, "yay", "good fit")).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]![1]).toEqual([5, "yay", "good fit"]);
    expect(mockQuery.mock.calls[1]![0]).toContain("INSERT INTO job_research");
  });

  it("cancels unstarted research on nay", async () => {
    await recordJobDecision(5, "nay");
    expect(mockQuery.mock.calls[0]![1]).toEqual([5, "nay", null]);
    expect(mockQuery.mock.calls[1]![0]).toContain("DELETE FROM job_research WHERE job_id = $1 AND status = 'pending'");
  });

  it("reports a missing job", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(recordJobDecision(404, "yay")).resolves.toBe(false);
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});

describe("getJobs", () => {
  it("filters hidden nays and maps rows", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        job_id: "9", title: "Head of AI", company: "Acme", location: null, workplace: "remote",
        salary_min: null, salary_max: 250000, source: "linkedin", url: "https://www.linkedin.com/jobs/view/1/",
        verdict: "nay", model_verdict: "yay", decided_by: "rule", fit_score: 60, reason: "Rule",
        profile_version: 1, first_seen_at: new Date("2026-09-01T00:00:00Z"), last_seen_at: new Date("2026-09-02T00:00:00Z"),
        sighting_count: 2, decision: null, decision_note: null, in_pipeline: false,
        warm_connections: ["Pat Lee (CTO)"], research_status: null,
      }],
    });

    const rows = await getJobs("nay", 10, 0);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("d.job_id IS NULL AND NOT in_pipeline AND j.verdict = 'nay'");
    expect(params).toEqual([10, 0]);
    expect(rows[0]).toMatchObject({
      jobId: 9, verdict: "nay", modelVerdict: "yay", firstSeenAt: "2026-09-01T00:00:00.000Z",
      warmConnections: ["Pat Lee (CTO)"], research: null,
    });
  });
});

describe("claimResearch", () => {
  it("claims pending and stale running rows without double-claiming", async () => {
    await claimResearch(2);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'running' AND started_at < now() - interval '15 minutes'");
    expect(params).toEqual([2]);
  });
});

describe("connections and pipeline", () => {
  it("imports connections with normalized company keys", async () => {
    await importConnections([
      { firstName: "Pat", lastName: "Lee", profileUrl: null, company: "Acme, Inc.", position: "CTO", connectedOn: "2024-08-03" },
    ]);
    expect(mockQuery.mock.calls[0]![1]).toEqual(["Pat", "Lee", "Acme, Inc.", "acme", "CTO", null, "2024-08-03"]);
  });

  it("keys pipeline companies the same way as jobs", async () => {
    await setPipelineCompany("Example.com", true, "Applied");
    expect(mockQuery.mock.calls[0]![1]).toEqual(["example", "Example.com", "Applied", true]);
  });
});
