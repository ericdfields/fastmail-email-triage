import { describe, expect, it } from "vitest";
import { filterNewProspects, renderDigestHtml } from "./jobsDigest.js";
import type { JobRow } from "./jobsDb.js";

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 1,
    title: "Engineer",
    company: "Acme",
    location: "Baltimore, MD",
    workplace: "hybrid",
    salaryMin: null,
    salaryMax: null,
    source: "linkedin",
    url: "https://example.com/job",
    verdict: "yay",
    modelVerdict: "yay",
    decidedBy: "model",
    fitScore: 80,
    reason: "Good fit",
    profileVersion: 2,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    sightingCount: 1,
    decision: null,
    decisionNote: null,
    inPipeline: false,
    warmConnections: [],
    research: null,
    ...overrides,
  };
}

describe("filterNewProspects", () => {
  it("keeps jobs first seen inside the window, highest fit first", () => {
    const old = row({ jobId: 1, fitScore: 99, firstSeenAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
    const a = row({ jobId: 2, fitScore: 70 });
    const b = row({ jobId: 3, fitScore: 90 });
    const result = filterNewProspects([old, a, b], 24);
    expect(result.map((j) => j.jobId)).toEqual([3, 2]);
  });

  it("returns an empty list when nothing is new", () => {
    const old = row({ firstSeenAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
    expect(filterNewProspects([old], 24)).toEqual([]);
  });
});

describe("renderDigestHtml", () => {
  it("escapes HTML in job fields", () => {
    const html = renderDigestHtml({
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      count: 1,
      prospects: [row({ title: "<script>alert(1)</script>", company: "A&B" })],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A&amp;B");
  });

  it("shows the empty state when there are no prospects", () => {
    const html = renderDigestHtml({
      generatedAt: new Date().toISOString(),
      windowHours: 24,
      count: 0,
      prospects: [],
    });
    expect(html).toContain("No new prospects");
  });
});
