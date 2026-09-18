import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJobs } from "./jobsDb.js";
import type { JobRow } from "./jobsDb.js";

export interface JobDigest {
  generatedAt: string;
  windowHours: number;
  count: number;
  prospects: JobRow[];
}

/** Digest snapshots live here, relative to the repo root. Not committed. */
export function defaultDigestDir(): string {
  return join(process.cwd(), "data", "digest");
}

/** Keep review-queue jobs first seen inside the window, highest fit first. */
export function filterNewProspects(jobs: JobRow[], windowHours: number): JobRow[] {
  const cutoff = Date.now() - windowHours * 3600_000;
  return jobs
    .filter((job) => Date.parse(job.firstSeenAt) >= cutoff)
    .sort((a, b) => b.fitScore - a.fitScore);
}

/** Prospects first seen within the window, highest fit first. */
export async function buildDigest(windowHours = 24): Promise<JobDigest> {
  const prospects = filterNewProspects(await getJobs("review", 200), windowHours);
  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    count: prospects.length,
    prospects,
  };
}

function esc(value: string | null | undefined): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function prospectCard(job: JobRow): string {
  const location = job.location ? ` · ${esc(job.location)}` : "";
  const salary =
    job.salaryMin || job.salaryMax
      ? ` · $${(job.salaryMin ?? 0).toLocaleString()}–$${(job.salaryMax ?? 0).toLocaleString()}`
      : "";
  const warm =
    job.warmConnections.length > 0
      ? `<p class="warm">Warm: ${job.warmConnections.map(esc).join(", ")}</p>`
      : "";
  const link = job.url
    ? `<p><a href="${esc(job.url)}">View posting</a></p>`
    : "";
  return `<article class="card">
  <div class="score">${job.fitScore}</div>
  <div>
    <h2>${esc(job.title)}</h2>
    <p class="meta">${esc(job.company)}${location}${salary}</p>
    <p>${esc(job.reason)}</p>
    ${warm}
    ${link}
  </div>
</article>`;
}

/** Simple mobile-friendly page for the morning report. */
export function renderDigestHtml(digest: JobDigest): string {
  const date = new Date(digest.generatedAt).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const body =
    digest.count === 0
      ? `<p class="empty">No new prospects in the last ${digest.windowHours} hours.</p>`
      : digest.prospects.map(prospectCard).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job prospects — ${esc(date)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0 auto; max-width: 640px; padding: 16px; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .sub { color: #666; margin-top: -0.5rem; }
  .card { display: flex; gap: 12px; border: 1px solid #e2e2e2; border-radius: 10px; padding: 12px; margin: 12px 0; }
  .score { flex: none; width: 44px; height: 44px; border-radius: 50%; background: #1a1a1a; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
  h2 { font-size: 1.05rem; margin: 0 0 4px; }
  .meta { color: #555; margin: 0 0 6px; font-size: 0.9rem; }
  p { margin: 6px 0; font-size: 0.95rem; }
  .warm { color: #0a6b2d; }
  .empty { color: #666; }
</style>
</head>
<body>
<h1>Job prospects</h1>
<p class="sub">${esc(date)} · ${digest.count} new in the last ${digest.windowHours} hours</p>
${body}
</body>
</html>
`;
}

/** Write latest.json + latest.html. Returns the paths written. */
export async function writeDigestFiles(
  digest: JobDigest,
  outDir: string = defaultDigestDir()
): Promise<{ jsonPath: string; htmlPath: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "latest.json");
  const htmlPath = join(outDir, "latest.html");
  await writeFile(jsonPath, JSON.stringify(digest, null, 2) + "\n");
  await writeFile(htmlPath, renderDigestHtml(digest));
  return { jsonPath, htmlPath };
}

/** The most recent snapshot, or null when none has been written yet. */
export async function readLatestDigest(
  outDir: string = defaultDigestDir()
): Promise<JobDigest | null> {
  try {
    return JSON.parse(await readFile(join(outDir, "latest.json"), "utf8")) as JobDigest;
  } catch {
    return null;
  }
}
