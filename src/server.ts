import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pathToFileURL } from "node:url";
import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  ensureOptimizationTables,
  getRecentClassifications,
  insertCorrection,
  ensureAttentionActionsTable,
  getAttentionQueue,
  getAttentionQueueCount,
  recordAttentionAction,
  ensureUnsubscribeActionsTable,
  getUnsubscribeCandidates,
  startUnsubscribeAction,
  finishUnsubscribeAction,
  keepUnsubscribeSender,
} from "./db.js";
import {
  getSession,
  getMailboxIds,
  fetchEmailBodies,
  archiveEmail,
  applyTierAction,
  fetchUnsubscribeHeaders,
} from "./jmap.js";
import {
  hasAuthenticatedOneClick,
  selectOneClickUrl,
  unsubscribeOneClick,
} from "./unsubscribe.js";
import type { Tier, JMAPSession, MailboxIds } from "./types.js";

const TIERS: Tier[] = ["auto-delete", "auto-archive", "confirm", "attention"];
export const app = new Hono();

let jmapSession: JMAPSession | null = null;
let jmapMailboxIds: MailboxIds | null = null;

async function getJmap() {
  if (!jmapSession) {
    jmapSession = await getSession();
    jmapMailboxIds = await getMailboxIds(jmapSession);
  }
  return { session: jmapSession!, mailboxIds: jmapMailboxIds! };
}

// API: Get recent classifications
app.get("/api/classifications", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");
  const rows = await getRecentClassifications(limit + offset);
  return c.json(rows.slice(offset));
});

// API: Record a correction
app.post("/api/corrections", async (c) => {
  const body = await c.req.json();
  const { emailId, tier } = body;

  if (!emailId || !TIERS.includes(tier)) {
    return c.json({ error: "Invalid emailId or tier" }, 400);
  }

  const result = await insertCorrection(emailId, tier as Tier);
  if (!result) {
    return c.json({ error: "Classification not found" }, 404);
  }

  return c.json({
    emailId,
    originalTier: result.originalTier,
    correctedTier: tier,
    subject: result.subject,
    from: result.from,
  });
});

// API: Get attention queue with email bodies
app.get("/api/attention", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "10"), 50);
  const queue = await getAttentionQueue(limit);

  if (queue.length === 0) return c.json([]);

  const jmap = await getJmap();
  const bodies = await fetchEmailBodies(jmap.session, queue.map((r) => r.emailId));

  return c.json(queue.map((r) => ({
    ...r,
    body: bodies.get(r.emailId) ?? "",
  })));
});

// API: Get attention queue count
app.get("/api/attention/count", async (c) => {
  const count = await getAttentionQueueCount();
  return c.json({ count });
});

// API: Act on attention email (archive + record)
app.post("/api/attention/act", async (c) => {
  const { emailId, runId, note } = await c.req.json();
  if (!emailId || !runId) return c.json({ error: "Missing emailId or runId" }, 400);

  const jmap = await getJmap();
  await recordAttentionAction(emailId, runId, "acted", note);
  await archiveEmail(jmap.session, jmap.mailboxIds, emailId);

  return c.json({ success: true });
});

// API: Snooze attention email
app.post("/api/attention/snooze", async (c) => {
  const { emailId, runId, days } = await c.req.json();
  if (!emailId || !runId || ![1, 3, 7].includes(days)) {
    return c.json({ error: "Missing fields or invalid days" }, 400);
  }

  const snoozedUntil = new Date();
  snoozedUntil.setDate(snoozedUntil.getDate() + days);
  await recordAttentionAction(emailId, runId, "snoozed", undefined, snoozedUntil);

  return c.json({ success: true });
});

// API: Reclassify attention email
app.post("/api/attention/reclassify", async (c) => {
  const { emailId, runId, tier } = await c.req.json();
  const validTiers = ["auto-delete", "auto-archive", "confirm"];
  if (!emailId || !runId || !validTiers.includes(tier)) {
    return c.json({ error: "Missing fields or invalid tier" }, 400);
  }

  const correction = await insertCorrection(emailId, tier as Tier);
  if (!correction) return c.json({ error: "Classification not found" }, 404);

  const jmap = await getJmap();
  await applyTierAction(jmap.session, jmap.mailboxIds, emailId, tier);
  await recordAttentionAction(emailId, runId, "acted");

  return c.json({ success: true });
});

const UNSUBSCRIBE_REVIEW_DAYS = 90;
const UNSUBSCRIBE_MINIMUM_MESSAGES = 2;
const UNSUBSCRIBE_LIMIT = 200;
const UNSUBSCRIBE_BATCH_LIMIT = 25;

async function currentUnsubscribeCandidates() {
  return getUnsubscribeCandidates(
    UNSUBSCRIBE_REVIEW_DAYS,
    UNSUBSCRIBE_MINIMUM_MESSAGES,
    UNSUBSCRIBE_LIMIT
  );
}

function describeUnsubscribeMethod(
  urls: string[] | null,
  listUnsubscribePost: string | null,
  authenticated: boolean
): { eligible: boolean; method: string; targetHost: string | null } {
  const oneClickUrl = selectOneClickUrl(urls, listUnsubscribePost);
  if (oneClickUrl && authenticated) {
    return {
      eligible: true,
      method: "one-click",
      targetHost: new URL(oneClickUrl).hostname.toLowerCase(),
    };
  }

  if (oneClickUrl) {
    return {
      eligible: false,
      method: "unverified",
      targetHost: new URL(oneClickUrl).hostname.toLowerCase(),
    };
  }

  for (const rawUrl of urls ?? []) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === "https:") {
        return { eligible: false, method: "web-manual", targetHost: url.hostname.toLowerCase() };
      }
      if (url.protocol === "mailto:") {
        return { eligible: false, method: "email-manual", targetHost: null };
      }
    } catch {
      // Ignore malformed header alternatives.
    }
  }

  return { eligible: false, method: "unavailable", targetHost: null };
}

// API: List recurring unsubscribe candidates; URLs and embedded tokens never leave the server.
app.get("/api/unsubscribe/candidates", async (c) => {
  const candidates = await currentUnsubscribeCandidates();
  if (candidates.length === 0) return c.json([]);

  const jmap = await getJmap();
  const headers = await fetchUnsubscribeHeaders(
    jmap.session,
    candidates.map((candidate) => candidate.emailId)
  );

  return c.json(
    candidates.map((candidate) => {
      const header = headers.get(candidate.emailId);
      const method = header
        ? describeUnsubscribeMethod(
            header.urls,
            header.listUnsubscribePost,
            hasAuthenticatedOneClick(header.authenticationResults, header.dkimSignatures)
          )
        : { eligible: false, method: "unavailable", targetHost: null };
      return { ...candidate, ...method };
    })
  );
});

app.get("/api/unsubscribe/count", async (c) => {
  const candidates = await currentUnsubscribeCandidates();
  return c.json({ count: candidates.length });
});

type UnsubscribeApproval = { sender: string; emailId: string };

function parseUnsubscribeApprovals(body: unknown): UnsubscribeApproval[] | null {
  if (!body || typeof body !== "object" || !("items" in body)) return null;
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > UNSUBSCRIBE_BATCH_LIMIT) {
    return null;
  }
  if (
    items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof (item as UnsubscribeApproval).sender !== "string" ||
        typeof (item as UnsubscribeApproval).emailId !== "string"
    )
  ) {
    return null;
  }
  return items as UnsubscribeApproval[];
}

// API: Execute an explicitly approved batch of RFC 8058 one-click requests.
app.post("/api/unsubscribe/process", async (c) => {
  const approvals = parseUnsubscribeApprovals(await c.req.json());
  if (!approvals) return c.json({ error: "Select between 1 and 25 valid candidates" }, 400);

  const current = await currentUnsubscribeCandidates();
  const allowed = new Map(
    current.map((candidate) => [`${candidate.sender}\n${candidate.emailId}`, candidate])
  );
  const approved = approvals
    .map((item) => allowed.get(`${item.sender.trim().toLowerCase()}\n${item.emailId}`))
    .filter((item) => item !== undefined);
  if (approved.length !== approvals.length) {
    return c.json({ error: "One or more candidates are stale or invalid; refresh and try again" }, 409);
  }

  const jmap = await getJmap();
  const headers = await fetchUnsubscribeHeaders(
    jmap.session,
    approved.map((candidate) => candidate.emailId)
  );
  const results: Array<{
    sender: string;
    emailId: string;
    success: boolean;
    httpStatus?: number;
    error?: string;
  }> = [];

  const processCandidate = async (candidate: (typeof approved)[number]): Promise<void> => {
    const header = headers.get(candidate.emailId);
    const authenticated = header
      ? hasAuthenticatedOneClick(header.authenticationResults, header.dkimSignatures)
      : false;
    const oneClickUrl = header && authenticated
      ? selectOneClickUrl(header.urls, header.listUnsubscribePost)
      : null;
    const targetHost = oneClickUrl ? new URL(oneClickUrl).hostname.toLowerCase() : undefined;
    const actionId = await startUnsubscribeAction(
      candidate.sender,
      candidate.emailId,
      "one-click",
      "rfc8058",
      targetHost
    );

    if (actionId === null) {
      results.push({
        sender: candidate.sender,
        emailId: candidate.emailId,
        success: false,
        error: "Already processed",
      });
      return;
    }

    if (!oneClickUrl) {
      const error = "No current RFC 8058 one-click HTTPS endpoint";
      await finishUnsubscribeAction(actionId, "failed", undefined, error);
      results.push({ sender: candidate.sender, emailId: candidate.emailId, success: false, error });
      return;
    }

    try {
      const result = await unsubscribeOneClick(oneClickUrl);
      await finishUnsubscribeAction(actionId, "success", result.httpStatus);
      results.push({
        sender: candidate.sender,
        emailId: candidate.emailId,
        success: true,
        httpStatus: result.httpStatus,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unsubscribe request failed";
      await finishUnsubscribeAction(actionId, "failed", undefined, message);
      results.push({ sender: candidate.sender, emailId: candidate.emailId, success: false, error: message });
    }
  };

  // Bounded batches finish within the proxy request window without flooding provider endpoints.
  for (let index = 0; index < approved.length; index += 5) {
    await Promise.all(approved.slice(index, index + 5).map(processCandidate));
  }

  return c.json({ results });
});

// API: Remember an explicit choice to keep a sender and stop suggesting it.
app.post("/api/unsubscribe/keep", async (c) => {
  const approvals = parseUnsubscribeApprovals(await c.req.json());
  if (!approvals || approvals.length !== 1) {
    return c.json({ error: "Choose exactly one sender to keep" }, 400);
  }

  const [approval] = approvals;
  const current = await currentUnsubscribeCandidates();
  const candidate = current.find(
    (item) => item.sender === approval!.sender.trim().toLowerCase() && item.emailId === approval!.emailId
  );
  if (!candidate) return c.json({ error: "Candidate is stale or invalid" }, 409);

  await keepUnsubscribeSender(candidate.sender, candidate.emailId);
  return c.json({ success: true });
});

// Frontend: Inline single-page app for mobile classification review
app.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0a0a0f">
<title>Email Triage</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --border: #1a1a2e;
    --border-hover: #2a2a40;
    --text: #e4e4eb;
    --text-muted: #6e6e82;
    --text-dim: #44445a;
    --tier-delete: #ef4444;
    --tier-archive: #eab308;
    --tier-confirm: #06b6d4;
    --tier-attention: #22c55e;
    --tier-delete-bg: rgba(239, 68, 68, 0.10);
    --tier-archive-bg: rgba(234, 179, 8, 0.10);
    --tier-confirm-bg: rgba(6, 182, 212, 0.10);
    --tier-attention-bg: rgba(34, 197, 94, 0.10);
    --radius: 10px;
    --radius-sm: 6px;
    --font: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    --font-mono: "SF Mono", ui-monospace, "Cascadia Code", "Fira Code", monospace;
  }

  html { font-size: 15px; }

  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    min-height: 100dvh;
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Header */
  .header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(10, 10, 15, 0.82);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    padding-top: calc(env(safe-area-inset-top, 8px) + 8px);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-title {
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  .header-title span {
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.8rem;
    margin-left: 8px;
  }

  .btn-refresh {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    width: 38px;
    height: 38px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .btn-refresh:active {
    background: var(--border);
    color: var(--text);
    transform: scale(0.94);
  }

  .btn-refresh.loading svg {
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Card list */
  .list {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Card */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }

  .card:active {
    background: #15151f;
    border-color: var(--border-hover);
  }

  .card-sender {
    font-weight: 600;
    font-size: 0.93rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
  }

  .card-subject {
    font-size: 0.87rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
    line-height: 1.4;
  }

  .card-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  /* Tier badge */
  .badge {
    display: inline-flex;
    align-items: center;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 4px;
    line-height: 1;
    transition: all 0.2s ease;
    white-space: nowrap;
  }

  .badge-auto-delete { color: var(--tier-delete); background: var(--tier-delete-bg); }
  .badge-auto-archive { color: var(--tier-archive); background: var(--tier-archive-bg); }
  .badge-confirm { color: var(--tier-confirm); background: var(--tier-confirm-bg); }
  .badge-attention { color: var(--tier-attention); background: var(--tier-attention-bg); }

  .badge-struck {
    text-decoration: line-through;
    opacity: 0.45;
  }

  .card-time {
    font-size: 0.73rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
    flex-shrink: 0;
  }

  .card-reason {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-top: 6px;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Expanded tier selection */
  .tier-select {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 10px;
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.25s ease;
  }

  .card.expanded .tier-select {
    max-height: 120px;
    opacity: 1;
  }

  .card:not(.expanded) .tier-select {
    margin-top: 0;
  }

  .tier-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    padding: 0;
    min-height: 44px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }

  .tier-btn:active {
    transform: scale(0.96);
  }

  .tier-btn[data-tier="auto-delete"] { border-color: rgba(239,68,68,0.25); }
  .tier-btn[data-tier="auto-delete"]:active,
  .tier-btn[data-tier="auto-delete"].active { background: var(--tier-delete-bg); color: var(--tier-delete); border-color: rgba(239,68,68,0.4); }

  .tier-btn[data-tier="auto-archive"] { border-color: rgba(234,179,8,0.25); }
  .tier-btn[data-tier="auto-archive"]:active,
  .tier-btn[data-tier="auto-archive"].active { background: var(--tier-archive-bg); color: var(--tier-archive); border-color: rgba(234,179,8,0.4); }

  .tier-btn[data-tier="confirm"] { border-color: rgba(6,182,212,0.25); }
  .tier-btn[data-tier="confirm"]:active,
  .tier-btn[data-tier="confirm"].active { background: var(--tier-confirm-bg); color: var(--tier-confirm); border-color: rgba(6,182,212,0.4); }

  .tier-btn[data-tier="attention"] { border-color: rgba(34,197,94,0.25); }
  .tier-btn[data-tier="attention"]:active,
  .tier-btn[data-tier="attention"].active { background: var(--tier-attention-bg); color: var(--tier-attention); border-color: rgba(34,197,94,0.4); }

  .tier-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tier-btn[data-tier="auto-delete"] .tier-dot { background: var(--tier-delete); }
  .tier-btn[data-tier="auto-archive"] .tier-dot { background: var(--tier-archive); }
  .tier-btn[data-tier="confirm"] .tier-dot { background: var(--tier-confirm); }
  .tier-btn[data-tier="attention"] .tier-dot { background: var(--tier-attention); }

  /* Load more */
  .load-more-wrap {
    padding: 12px 10px 24px;
    display: flex;
    justify-content: center;
  }

  .btn-load-more {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 0.82rem;
    font-weight: 500;
    padding: 10px 28px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .btn-load-more:active {
    background: var(--border);
    color: var(--text);
    transform: scale(0.97);
  }

  .btn-load-more:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Empty state */
  .empty {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-dim);
    font-size: 0.9rem;
  }

  /* Toast */
  .toast {
    position: fixed;
    bottom: calc(env(safe-area-inset-bottom, 16px) + 16px);
    left: 50%;
    transform: translateX(-50%) translateY(80px);
    background: #1e1e2e;
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 0.82rem;
    padding: 10px 18px;
    border-radius: var(--radius);
    box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    opacity: 0;
    transition: all 0.25s ease;
    z-index: 200;
    pointer-events: none;
    white-space: nowrap;
  }

  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .toast.error {
    border-color: rgba(239,68,68,0.3);
    color: var(--tier-delete);
  }

  /* Pulse on update */
  @keyframes badge-pulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.12); }
    100% { transform: scale(1); }
  }

  .badge-pulse {
    animation: badge-pulse 0.25s ease;
  }

  /* Stagger load */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .card {
    animation: fadeUp 0.3s ease both;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    padding: 8px 10px 4px;
    background: rgba(10, 10, 15, 0.65);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .tab {
    appearance: none;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font);
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    padding: 8px 16px;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.2s ease;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    justify-content: center;
    min-height: 40px;
  }

  .tab:active { transform: scale(0.97); }

  .tab.active {
    background: rgba(228, 228, 235, 0.08);
    color: var(--text);
    border-color: var(--border-hover);
  }

  .tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 10px;
    font-size: 0.68rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    background: rgba(34, 197, 94, 0.18);
    color: var(--tier-attention);
    line-height: 1;
  }

  .tab-badge:empty { display: none; }

  .view { display: none; }
  .view.active { display: block; }

  /* Attention card overrides */
  .attn-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    transition: border-color 0.15s ease, opacity 0.3s ease, transform 0.3s ease, max-height 0.3s ease;
    -webkit-tap-highlight-color: transparent;
    animation: fadeUp 0.3s ease both;
  }

  .attn-card.removing {
    opacity: 0;
    transform: translateY(-12px);
    max-height: 0 !important;
    padding-top: 0;
    padding-bottom: 0;
    margin-bottom: 0;
    overflow: hidden;
    border-width: 0;
  }

  .attn-card-sender {
    font-weight: 600;
    font-size: 0.93rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
  }

  .attn-card-subject {
    font-size: 0.87rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
    line-height: 1.4;
  }

  .attn-card-time {
    font-size: 0.73rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    margin-top: 6px;
  }

  .card-body {
    font-size: 0.8rem;
    color: var(--text-dim);
    margin-top: 8px;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .card-body.card-body-expanded {
    -webkit-line-clamp: 12;
  }

  /* Action buttons */
  .attn-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }

  .attn-btn {
    appearance: none;
    background: transparent;
    font-family: var(--font);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0 14px;
    min-height: 44px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    flex: 1;
  }

  .attn-btn:active { transform: scale(0.95); }

  .attn-btn-act {
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: var(--tier-attention);
  }
  .attn-btn-act:active {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.5);
  }

  .attn-btn-snooze {
    border: 1px solid rgba(234, 179, 8, 0.3);
    color: var(--tier-archive);
  }
  .attn-btn-snooze:active {
    background: rgba(234, 179, 8, 0.15);
    border-color: rgba(234, 179, 8, 0.5);
  }

  .attn-btn-reclass {
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: var(--tier-delete);
  }
  .attn-btn-reclass:active {
    background: rgba(239, 68, 68, 0.15);
    border-color: rgba(239, 68, 68, 0.5);
  }

  /* Sub-action panels */
  .attn-sub {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.25s ease;
    margin-top: 0;
  }

  .attn-sub.open {
    max-height: 60px;
    opacity: 1;
    margin-top: 8px;
  }

  .attn-sub-inner {
    display: flex;
    gap: 6px;
  }

  .attn-sub-btn {
    appearance: none;
    background: transparent;
    font-family: var(--font);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0 12px;
    min-height: 38px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
  }

  .attn-sub-btn:active { transform: scale(0.95); }

  .snooze-sub-btn {
    border: 1px solid rgba(234, 179, 8, 0.25);
    color: var(--tier-archive);
  }
  .snooze-sub-btn:active {
    background: rgba(234, 179, 8, 0.12);
    border-color: rgba(234, 179, 8, 0.45);
  }

  .reclass-sub-btn {
    border: 1px solid var(--border);
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .reclass-sub-btn:active {
    background: var(--border);
    color: var(--text);
  }

  .reclass-sub-btn[data-tier="auto-delete"] { border-color: rgba(239,68,68,0.25); color: var(--tier-delete); }
  .reclass-sub-btn[data-tier="auto-delete"]:active { background: var(--tier-delete-bg); }
  .reclass-sub-btn[data-tier="auto-archive"] { border-color: rgba(234,179,8,0.25); color: var(--tier-archive); }
  .reclass-sub-btn[data-tier="auto-archive"]:active { background: var(--tier-archive-bg); }
  .reclass-sub-btn[data-tier="confirm"] { border-color: rgba(6,182,212,0.25); color: var(--tier-confirm); }
  .reclass-sub-btn[data-tier="confirm"]:active { background: var(--tier-confirm-bg); }

  /* Note input */
  .note-input-wrap {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.25s ease, opacity 0.2s ease, margin-top 0.25s ease;
    margin-top: 0;
  }

  .note-input-wrap.open {
    max-height: 50px;
    opacity: 1;
    margin-top: 8px;
  }

  .note-input {
    width: 100%;
    appearance: none;
    border: 1px solid rgba(34, 197, 94, 0.25);
    background: rgba(34, 197, 94, 0.05);
    color: var(--text);
    font-family: var(--font);
    font-size: 0.82rem;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    outline: none;
    transition: border-color 0.15s ease;
  }

  .note-input::placeholder { color: var(--text-dim); }
  .note-input:focus { border-color: rgba(34, 197, 94, 0.5); }

  /* Note toggle icon in act button */
  .note-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    margin-left: 2px;
    opacity: 0.5;
    transition: opacity 0.15s ease;
  }

  .note-toggle:hover, .note-toggle.active { opacity: 1; }

  /* Unsubscribe review */
  .unsub-intro {
    padding: 18px 16px 14px;
    border-bottom: 1px solid var(--border);
  }

  .unsub-intro h2 {
    font-size: 1.05rem;
    letter-spacing: -0.02em;
    line-height: 1.25;
  }

  .unsub-intro p {
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1.5;
    margin-top: 5px;
    max-width: 70ch;
  }

  .unsub-toolbar {
    position: sticky;
    top: 63px;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 58px;
    padding: 8px 10px;
    background: rgba(10, 10, 15, 0.94);
    border-bottom: 1px solid var(--border);
  }

  .unsub-select-all,
  .unsub-process,
  .unsub-keep {
    appearance: none;
    font-family: var(--font);
    font-weight: 650;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }

  .unsub-select-all {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    padding: 0 12px;
    min-height: 42px;
    font-size: 0.76rem;
  }

  .unsub-process {
    border: 1px solid rgba(6, 182, 212, 0.42);
    background: rgba(6, 182, 212, 0.12);
    color: #67e8f9;
    border-radius: var(--radius-sm);
    padding: 0 15px;
    min-height: 42px;
    font-size: 0.78rem;
    margin-left: auto;
  }

  .unsub-process.confirming {
    background: #0891b2;
    border-color: #22d3ee;
    color: #041619;
  }

  .unsub-process:disabled,
  .unsub-select-all:disabled,
  .unsub-keep:disabled {
    opacity: 0.38;
    cursor: default;
  }

  .unsub-process:not(:disabled):active,
  .unsub-select-all:not(:disabled):active,
  .unsub-keep:not(:disabled):active { transform: scale(0.96); }

  .unsub-list {
    margin: 8px 10px 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .unsub-row {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 14px 12px;
    border-bottom: 1px solid var(--border);
    animation: fadeUp 0.3s ease both;
  }

  .unsub-row:last-child { border-bottom: 0; }
  .unsub-row.manual { opacity: 0.68; }
  .unsub-row.failed { background: rgba(239, 68, 68, 0.06); }

  .unsub-check {
    appearance: none;
    width: 22px;
    height: 22px;
    border: 1px solid var(--border-hover);
    border-radius: 5px;
    background: var(--bg);
    margin-top: 1px;
    cursor: pointer;
    display: grid;
    place-content: center;
  }

  .unsub-check::after {
    content: "";
    width: 10px;
    height: 6px;
    border-left: 2px solid #041619;
    border-bottom: 2px solid #041619;
    transform: rotate(-45deg) translateY(-1px) scale(0);
    transition: transform 0.12s ease;
  }

  .unsub-check:checked {
    background: #22d3ee;
    border-color: #22d3ee;
  }

  .unsub-check:checked::after { transform: rotate(-45deg) translateY(-1px) scale(1); }
  .unsub-check:disabled { opacity: 0.28; cursor: default; }

  .unsub-sender {
    font-size: 0.9rem;
    font-weight: 650;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .unsub-subject {
    margin-top: 3px;
    color: var(--text-muted);
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .unsub-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    margin-top: 8px;
    color: var(--text-dim);
    font-size: 0.72rem;
  }

  .unsub-method {
    padding: 3px 7px;
    border-radius: 4px;
    background: rgba(6, 182, 212, 0.1);
    color: #67e8f9;
    font-size: 0.67rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .manual .unsub-method { background: rgba(110, 110, 130, 0.12); color: var(--text-muted); }
  .unsub-error { color: var(--tier-delete); }

  .unsub-keep {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    min-height: 32px;
    padding: 0 6px;
    font-size: 0.72rem;
  }

  @media (min-width: 760px) {
    #app { max-width: 820px; margin: 0 auto; }
    .header { border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>

<div id="app">
  <header class="header">
    <div class="header-title">Triage<span id="count"></span></div>
    <button class="btn-refresh" id="refreshBtn" aria-label="Refresh">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
      </svg>
    </button>
  </header>
  <div class="tabs">
    <button class="tab active" data-tab="attention">Attention <span class="tab-badge" id="attnBadge"></span></button>
    <button class="tab" data-tab="review">Review</button>
    <button class="tab" data-tab="unsubscribe">Unsubscribe <span class="tab-badge" id="unsubBadge"></span></button>
  </div>
  <div class="view" id="reviewView">
    <div class="list" id="list"></div>
    <div class="load-more-wrap" id="loadMoreWrap" style="display:none">
      <button class="btn-load-more" id="loadMoreBtn">Load more</button>
    </div>
    <div class="empty" id="empty" style="display:none">No classifications yet.</div>
  </div>
  <div class="view active" id="attentionView">
    <div class="list" id="attnList"></div>
    <div class="load-more-wrap" id="attnLoadMoreWrap" style="display:none">
      <button class="btn-load-more" id="attnLoadMoreBtn">Load more</button>
    </div>
    <div class="empty" id="attnEmpty" style="display:none">No attention emails pending.</div>
  </div>
  <div class="view" id="unsubscribeView">
    <section class="unsub-intro">
      <h2>Quiet recurring senders</h2>
      <p>Recurring mail from the last 90 days. Only verified one-click senders can be selected; every request needs your approval.</p>
    </section>
    <div class="unsub-toolbar" id="unsubToolbar">
      <button class="unsub-select-all" id="unsubSelectAll" disabled>Select eligible</button>
      <button class="unsub-process" id="unsubProcess" disabled>Choose senders</button>
    </div>
    <div class="unsub-list" id="unsubList"></div>
    <div class="empty" id="unsubEmpty" style="display:none">No recurring senders to review.</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
(function() {
  const TIERS = ['auto-delete', 'auto-archive', 'confirm', 'attention'];
  const TIER_LABELS = { 'auto-delete': 'Delete', 'auto-archive': 'Archive', 'confirm': 'Confirm', 'attention': 'Attention' };
  const PAGE_SIZE = 50;
  let items = [];
  let offset = 0;
  let loading = false;
  let expandedId = null;
  let toastTimer = null;

  // Attention state
  let attnItems = [];
  let attnLoading = false;
  let activeTab = 'attention';
  let reviewLoaded = false;

  // Unsubscribe review state
  let unsubItems = [];
  let unsubLoading = false;
  let unsubscribeLoaded = false;
  let selectedUnsub = new Set();
  let unsubConfirmTimer = null;

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const loadMoreWrap = document.getElementById('loadMoreWrap');
  const toastEl = document.getElementById('toast');

  // Attention elements
  const attnListEl = document.getElementById('attnList');
  const attnEmptyEl = document.getElementById('attnEmpty');
  const attnBadgeEl = document.getElementById('attnBadge');
  const attnLoadMoreBtn = document.getElementById('attnLoadMoreBtn');
  const attnLoadMoreWrap = document.getElementById('attnLoadMoreWrap');
  const reviewView = document.getElementById('reviewView');
  const attentionView = document.getElementById('attentionView');
  const unsubscribeView = document.getElementById('unsubscribeView');
  const unsubListEl = document.getElementById('unsubList');
  const unsubEmptyEl = document.getElementById('unsubEmpty');
  const unsubBadgeEl = document.getElementById('unsubBadge');
  const unsubSelectAllBtn = document.getElementById('unsubSelectAll');
  const unsubProcessBtn = document.getElementById('unsubProcess');

  function showToast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { toastEl.className = 'toast'; }, 2200);
  }

  function timeAgo(iso) {
    const d = new Date(iso);
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function effectiveTier(item) {
    return item.correctedTier || item.tier;
  }

  function renderBadge(tier, struck) {
    var cls = 'badge badge-' + tier + (struck ? ' badge-struck' : '');
    return '<span class="' + cls + '">' + TIER_LABELS[tier] + '</span>';
  }

  function renderCard(item, index) {
    var et = effectiveTier(item);
    var expanded = expandedId === item.emailId;
    var delay = Math.min(index * 0.03, 0.4);

    var badges = '';
    if (item.correctedTier && item.correctedTier !== item.tier) {
      badges = renderBadge(item.tier, true) + ' ' + renderBadge(item.correctedTier, false);
    } else {
      badges = renderBadge(et, false);
    }

    var tierBtns = TIERS.map(function(t) {
      var active = (t === et) ? ' active' : '';
      return '<button class="tier-btn' + active + '" data-tier="' + t + '" data-email="' + item.emailId + '">'
        + '<span class="tier-dot"></span>' + TIER_LABELS[t] + '</button>';
    }).join('');

    return '<div class="card' + (expanded ? ' expanded' : '') + '" data-id="' + item.emailId + '" style="animation-delay:' + delay + 's">'
      + '<div class="card-sender">' + escHtml(item.from) + '</div>'
      + '<div class="card-subject">' + escHtml(item.subject) + '</div>'
      + '<div class="card-meta">' + badges + '<span class="card-time">' + timeAgo(item.receivedAt) + '</span></div>'
      + '<div class="card-reason">' + escHtml(item.reason) + '</div>'
      + '<div class="tier-select">' + tierBtns + '</div>'
      + '</div>';
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render() {
    if (items.length === 0) {
      listEl.innerHTML = '';
      emptyEl.style.display = '';
      loadMoreWrap.style.display = 'none';
      countEl.textContent = '';
      return;
    }
    emptyEl.style.display = 'none';
    countEl.textContent = items.length + ' emails';
    listEl.innerHTML = items.map(renderCard).join('');
    loadMoreWrap.style.display = '';
  }

  function updateCardInPlace(emailId, newTier) {
    var item = items.find(function(i) { return i.emailId === emailId; });
    if (!item) return;
    item.correctedTier = newTier;

    var cardEl = listEl.querySelector('[data-id="' + emailId + '"]');
    if (!cardEl) return;

    var metaEl = cardEl.querySelector('.card-meta');
    var timeSpan = metaEl.querySelector('.card-time').outerHTML;

    var badges = '';
    if (item.correctedTier !== item.tier) {
      badges = renderBadge(item.tier, true) + ' ' + renderBadge(item.correctedTier, false);
    } else {
      badges = renderBadge(item.tier, false);
    }
    metaEl.innerHTML = badges + timeSpan;

    var newBadge = metaEl.querySelector('.badge:not(.badge-struck)');
    if (newBadge) { newBadge.classList.add('badge-pulse'); }

    var btns = cardEl.querySelectorAll('.tier-btn');
    btns.forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tier') === newTier);
    });
  }

  async function loadClassifications(reset) {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add('loading');
    loadMoreBtn.disabled = true;

    try {
      if (reset) offset = 0;
      var res = await fetch('/api/classifications?limit=' + PAGE_SIZE + '&offset=' + offset);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      if (reset) {
        items = data;
      } else {
        var existing = new Set(items.map(function(i) { return i.emailId; }));
        data.forEach(function(d) { if (!existing.has(d.emailId)) items.push(d); });
      }
      offset = items.length;
      render();

      if (data.length < PAGE_SIZE) {
        loadMoreBtn.textContent = 'All loaded';
        loadMoreBtn.disabled = true;
      } else {
        loadMoreBtn.textContent = 'Load more';
        loadMoreBtn.disabled = false;
      }
    } catch (e) {
      showToast('Failed to load: ' + e.message, true);
    } finally {
      loading = false;
      refreshBtn.classList.remove('loading');
    }
  }

  async function submitCorrection(emailId, tier) {
    var prev = items.find(function(i) { return i.emailId === emailId; });
    var prevTier = prev ? (prev.correctedTier || prev.tier) : null;

    updateCardInPlace(emailId, tier);

    try {
      var res = await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: emailId, tier: tier }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      showToast('Corrected to ' + TIER_LABELS[tier], false);
    } catch (e) {
      if (prev && prevTier) updateCardInPlace(emailId, prevTier);
      showToast('Correction failed', true);
    }
  }

  // Event delegation for review list
  listEl.addEventListener('click', function(e) {
    var tierBtn = e.target.closest('.tier-btn');
    if (tierBtn) {
      e.stopPropagation();
      var emailId = tierBtn.getAttribute('data-email');
      var tier = tierBtn.getAttribute('data-tier');
      submitCorrection(emailId, tier);
      return;
    }

    var card = e.target.closest('.card');
    if (card) {
      var id = card.getAttribute('data-id');
      if (expandedId === id) {
        expandedId = null;
        card.classList.remove('expanded');
      } else {
        var prev = listEl.querySelector('.card.expanded');
        if (prev) prev.classList.remove('expanded');
        expandedId = id;
        card.classList.add('expanded');
      }
    }
  });

  refreshBtn.addEventListener('click', function() {
    if (activeTab === 'review') {
      loadClassifications(true);
    } else if (activeTab === 'unsubscribe') {
      loadUnsubscribe();
    } else {
      loadAttention(true);
    }
  });
  loadMoreBtn.addEventListener('click', function() { loadClassifications(false); });

  // --- Tab switching ---
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var target = tab.getAttribute('data-tab');
      if (target === activeTab) return;
      activeTab = target;
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-tab') === target); });
      reviewView.classList.toggle('active', target === 'review');
      attentionView.classList.toggle('active', target === 'attention');
      unsubscribeView.classList.toggle('active', target === 'unsubscribe');
      if (target === 'attention' && attnItems.length === 0) {
        loadAttention(true);
      }
      if (target === 'review' && !reviewLoaded) {
        reviewLoaded = true;
        loadClassifications(true);
      }
      if (target === 'unsubscribe' && !unsubscribeLoaded) {
        unsubscribeLoaded = true;
        loadUnsubscribe();
      }
    });
  });

  // --- Attention Queue ---
  function truncateBody(text, len) {
    if (!text) return '';
    if (text.length <= len) return text;
    return text.substring(0, len) + '...';
  }

  function renderAttnCard(item, index) {
    var delay = Math.min(index * 0.04, 0.5);
    var bodyPreview = truncateBody(item.body, 200);
    var bodyFull = truncateBody(item.body, 500);

    return '<div class="attn-card" data-email="' + escHtml(item.emailId) + '" data-run="' + item.runId + '" style="animation-delay:' + delay + 's">'
      + '<div class="attn-card-sender">' + escHtml(item.from) + '</div>'
      + '<div class="attn-card-subject">' + escHtml(item.subject) + '</div>'
      + '<div class="attn-card-time">' + timeAgo(item.receivedAt) + '</div>'
      + (bodyPreview ? '<div class="card-body" data-preview="' + escHtml(bodyPreview) + '" data-full="' + escHtml(bodyFull) + '">' + escHtml(bodyPreview) + '</div>' : '')
      + '<div class="attn-actions">'
      +   '<button class="attn-btn attn-btn-act" data-action="act">'
      +     '<span>Act</span>'
      +     '<span class="note-toggle" data-action="toggle-note" title="Add note">'
      +       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
      +     '</span>'
      +   '</button>'
      +   '<button class="attn-btn attn-btn-snooze" data-action="snooze">Snooze</button>'
      +   '<button class="attn-btn attn-btn-reclass" data-action="reclassify">Reclassify</button>'
      + '</div>'
      + '<div class="note-input-wrap" data-panel="note">'
      +   '<input class="note-input" type="text" placeholder="Optional note..." maxlength="280">'
      + '</div>'
      + '<div class="attn-sub" data-panel="snooze"><div class="attn-sub-inner">'
      +   '<button class="attn-sub-btn snooze-sub-btn" data-days="1">1 day</button>'
      +   '<button class="attn-sub-btn snooze-sub-btn" data-days="3">3 days</button>'
      +   '<button class="attn-sub-btn snooze-sub-btn" data-days="7">1 week</button>'
      + '</div></div>'
      + '<div class="attn-sub" data-panel="reclassify"><div class="attn-sub-inner">'
      +   '<button class="attn-sub-btn reclass-sub-btn" data-tier="auto-delete">Delete</button>'
      +   '<button class="attn-sub-btn reclass-sub-btn" data-tier="auto-archive">Archive</button>'
      +   '<button class="attn-sub-btn reclass-sub-btn" data-tier="confirm">Confirm</button>'
      + '</div></div>'
      + '</div>';
  }

  function renderAttnList() {
    if (attnItems.length === 0) {
      attnListEl.innerHTML = '';
      attnEmptyEl.style.display = '';
      attnLoadMoreWrap.style.display = 'none';
      return;
    }
    attnEmptyEl.style.display = 'none';
    attnListEl.innerHTML = attnItems.map(renderAttnCard).join('');
    attnLoadMoreWrap.style.display = '';
  }

  async function loadAttentionCount() {
    try {
      var res = await fetch('/api/attention/count');
      if (!res.ok) return;
      var data = await res.json();
      attnBadgeEl.textContent = data.count > 0 ? data.count : '';
    } catch (e) { /* silent */ }
  }

  async function loadAttention(reset) {
    if (attnLoading) return;
    attnLoading = true;
    refreshBtn.classList.add('loading');

    try {
      var limit = reset ? 10 : 10;
      var res = await fetch('/api/attention?limit=' + limit);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();

      if (reset) {
        attnItems = data;
      } else {
        var existing = new Set(attnItems.map(function(i) { return i.emailId; }));
        data.forEach(function(d) { if (!existing.has(d.emailId)) attnItems.push(d); });
      }
      renderAttnList();

      if (data.length < 10) {
        attnLoadMoreBtn.textContent = 'All loaded';
        attnLoadMoreBtn.disabled = true;
      } else {
        attnLoadMoreBtn.textContent = 'Load more';
        attnLoadMoreBtn.disabled = false;
      }
    } catch (e) {
      showToast('Failed to load attention queue: ' + e.message, true);
    } finally {
      attnLoading = false;
      refreshBtn.classList.remove('loading');
    }
  }

  function removeAttnCard(emailId) {
    var idx = attnItems.findIndex(function(i) { return i.emailId === emailId; });
    if (idx !== -1) attnItems.splice(idx, 1);

    var cardEl = attnListEl.querySelector('[data-email="' + emailId + '"]');
    if (cardEl) {
      cardEl.style.maxHeight = cardEl.offsetHeight + 'px';
      requestAnimationFrame(function() { cardEl.classList.add('removing'); });
      setTimeout(function() {
        cardEl.remove();
        if (attnItems.length === 0) {
          attnEmptyEl.style.display = '';
          attnLoadMoreWrap.style.display = 'none';
        }
      }, 350);
    }
    loadAttentionCount();
  }

  function revertAttnCard(emailId) {
    var cardEl = attnListEl.querySelector('[data-email="' + emailId + '"]');
    if (cardEl) {
      cardEl.style.opacity = '1';
      cardEl.style.pointerEvents = '';
    }
  }

  function fadeAttnCard(emailId) {
    var cardEl = attnListEl.querySelector('[data-email="' + emailId + '"]');
    if (cardEl) {
      cardEl.style.opacity = '0.4';
      cardEl.style.pointerEvents = 'none';
    }
  }

  async function submitAct(emailId, runId, note) {
    fadeAttnCard(emailId);
    try {
      var res = await fetch('/api/attention/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: emailId, runId: runId, note: note || undefined }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      removeAttnCard(emailId);
      showToast('Archived', false);
    } catch (e) {
      revertAttnCard(emailId);
      showToast('Action failed', true);
    }
  }

  async function submitSnooze(emailId, runId, days) {
    fadeAttnCard(emailId);
    try {
      var res = await fetch('/api/attention/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: emailId, runId: runId, days: days }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      removeAttnCard(emailId);
      showToast('Snoozed for ' + (days === 7 ? '1 week' : days + ' day' + (days > 1 ? 's' : '')), false);
    } catch (e) {
      revertAttnCard(emailId);
      showToast('Snooze failed', true);
    }
  }

  async function submitReclassify(emailId, runId, tier) {
    fadeAttnCard(emailId);
    try {
      var res = await fetch('/api/attention/reclassify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: emailId, runId: runId, tier: tier }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      removeAttnCard(emailId);
      showToast('Reclassified to ' + TIER_LABELS[tier], false);
    } catch (e) {
      revertAttnCard(emailId);
      showToast('Reclassify failed', true);
    }
  }

  // Event delegation for attention list
  attnListEl.addEventListener('click', function(e) {
    var card = e.target.closest('.attn-card');
    if (!card) return;
    var emailId = card.getAttribute('data-email');
    var runId = parseInt(card.getAttribute('data-run'));

    // Toggle body preview expansion
    var bodyEl = e.target.closest('.card-body');
    if (bodyEl) {
      if (bodyEl.classList.contains('card-body-expanded')) {
        bodyEl.classList.remove('card-body-expanded');
        bodyEl.textContent = bodyEl.getAttribute('data-preview');
      } else {
        bodyEl.classList.add('card-body-expanded');
        bodyEl.textContent = bodyEl.getAttribute('data-full');
      }
      return;
    }

    // Note toggle
    var noteToggle = e.target.closest('[data-action="toggle-note"]');
    if (noteToggle) {
      e.stopPropagation();
      var noteWrap = card.querySelector('[data-panel="note"]');
      noteWrap.classList.toggle('open');
      noteToggle.classList.toggle('active');
      if (noteWrap.classList.contains('open')) {
        setTimeout(function() { noteWrap.querySelector('.note-input').focus(); }, 100);
      }
      return;
    }

    // Act button
    var actBtn = e.target.closest('[data-action="act"]');
    if (actBtn) {
      e.stopPropagation();
      var noteInput = card.querySelector('.note-input');
      var note = noteInput ? noteInput.value.trim() : '';
      submitAct(emailId, runId, note);
      return;
    }

    // Snooze button - toggle sub-panel
    var snoozeBtn = e.target.closest('[data-action="snooze"]');
    if (snoozeBtn) {
      e.stopPropagation();
      var snoozePanel = card.querySelector('[data-panel="snooze"]');
      var reclassPanel = card.querySelector('[data-panel="reclassify"]');
      reclassPanel.classList.remove('open');
      snoozePanel.classList.toggle('open');
      return;
    }

    // Reclassify button - toggle sub-panel
    var reclassBtn = e.target.closest('[data-action="reclassify"]');
    if (reclassBtn) {
      e.stopPropagation();
      var reclassPanel2 = card.querySelector('[data-panel="reclassify"]');
      var snoozePanel2 = card.querySelector('[data-panel="snooze"]');
      snoozePanel2.classList.remove('open');
      reclassPanel2.classList.toggle('open');
      return;
    }

    // Snooze sub-buttons
    var snoozeSub = e.target.closest('.snooze-sub-btn');
    if (snoozeSub) {
      e.stopPropagation();
      var days = parseInt(snoozeSub.getAttribute('data-days'));
      submitSnooze(emailId, runId, days);
      return;
    }

    // Reclassify sub-buttons
    var reclassSub = e.target.closest('.reclass-sub-btn');
    if (reclassSub) {
      e.stopPropagation();
      var tier = reclassSub.getAttribute('data-tier');
      submitReclassify(emailId, runId, tier);
      return;
    }
  });

  // --- Unsubscribe Review ---
  function unsubscribeMethodLabel(item) {
    if (item.method === 'one-click') return 'One-click';
    if (item.method === 'web-manual') return 'Manual web';
    if (item.method === 'email-manual') return 'Manual email';
    if (item.method === 'unverified') return 'Unverified';
    return 'Unavailable';
  }

  function renderUnsubItem(item, index) {
    var selected = selectedUnsub.has(item.emailId);
    var selectable = item.eligible && (selected || selectedUnsub.size < 25);
    var rowClass = 'unsub-row' + (item.eligible ? '' : ' manual') + (item.error ? ' failed' : '');
    var delay = Math.min(index * 0.025, 0.35);
    var activity = item.messageCount + ' message' + (item.messageCount === 1 ? '' : 's') + ' · latest ' + timeAgo(item.lastReceivedAt);
    var target = item.targetHost ? ' · ' + escHtml(item.targetHost) : '';
    var error = item.error ? '<span class="unsub-error">' + escHtml(item.error) + '</span>' : '';

    return '<div class="' + rowClass + '" data-index="' + index + '" style="animation-delay:' + delay + 's">'
      + '<input class="unsub-check" type="checkbox" aria-label="Select ' + escHtml(item.sender) + '"'
      + (selected ? ' checked' : '') + (selectable ? '' : ' disabled') + '>'
      + '<div class="unsub-content">'
      +   '<div class="unsub-sender">' + escHtml(item.sender) + '</div>'
      +   '<div class="unsub-subject">' + escHtml(item.latestSubject) + '</div>'
      +   '<div class="unsub-meta"><span class="unsub-method">' + unsubscribeMethodLabel(item) + '</span>'
      +     '<span>' + activity + target + '</span>' + error + '</div>'
      + '</div>'
      + '<button class="unsub-keep" data-action="keep" aria-label="Keep mail from ' + escHtml(item.sender) + '">Keep</button>'
      + '</div>';
  }

  function resetUnsubConfirmation() {
    clearTimeout(unsubConfirmTimer);
    unsubConfirmTimer = null;
    unsubProcessBtn.classList.remove('confirming');
  }

  function updateUnsubToolbar() {
    resetUnsubConfirmation();
    var eligible = unsubItems.filter(function(item) { return item.eligible; });
    var selectable = eligible.slice(0, 25);
    var selectedCount = selectedUnsub.size;
    var allSelected = selectable.length > 0 && selectable.every(function(item) { return selectedUnsub.has(item.emailId); });

    unsubSelectAllBtn.disabled = unsubLoading || eligible.length === 0;
    unsubSelectAllBtn.textContent = allSelected ? 'Clear selection' : 'Select eligible';
    unsubProcessBtn.disabled = unsubLoading || selectedCount === 0;
    unsubProcessBtn.textContent = selectedCount === 0
      ? 'Choose senders'
      : 'Unsubscribe ' + selectedCount;
  }

  function renderUnsubscribe() {
    unsubBadgeEl.textContent = unsubItems.length > 0 ? unsubItems.length : '';
    if (unsubItems.length === 0) {
      unsubListEl.innerHTML = '';
      unsubListEl.style.display = 'none';
      unsubEmptyEl.style.display = '';
    } else {
      unsubEmptyEl.style.display = 'none';
      unsubListEl.style.display = '';
      unsubListEl.innerHTML = unsubItems.map(renderUnsubItem).join('');
    }
    updateUnsubToolbar();
  }

  async function loadUnsubscribeCount() {
    try {
      var res = await fetch('/api/unsubscribe/count');
      if (!res.ok) return;
      var data = await res.json();
      unsubBadgeEl.textContent = data.count > 0 ? data.count : '';
    } catch (e) { /* silent */ }
  }

  async function loadUnsubscribe() {
    if (unsubLoading) return;
    unsubLoading = true;
    selectedUnsub.clear();
    refreshBtn.classList.add('loading');
    updateUnsubToolbar();

    try {
      var res = await fetch('/api/unsubscribe/candidates');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      unsubItems = await res.json();
      renderUnsubscribe();
    } catch (e) {
      showToast('Failed to load unsubscribe review: ' + e.message, true);
    } finally {
      unsubLoading = false;
      refreshBtn.classList.remove('loading');
      updateUnsubToolbar();
    }
  }

  unsubListEl.addEventListener('change', function(e) {
    var checkbox = e.target.closest('.unsub-check');
    if (!checkbox) return;
    var row = checkbox.closest('.unsub-row');
    var item = unsubItems[parseInt(row.getAttribute('data-index'))];
    if (!item || !item.eligible) return;
    if (checkbox.checked) selectedUnsub.add(item.emailId);
    else selectedUnsub.delete(item.emailId);
    renderUnsubscribe();
  });

  unsubSelectAllBtn.addEventListener('click', function() {
    var eligible = unsubItems.filter(function(item) { return item.eligible; });
    var selectable = eligible.slice(0, 25);
    var allSelected = selectable.length > 0 && selectable.every(function(item) { return selectedUnsub.has(item.emailId); });
    selectedUnsub.clear();
    if (!allSelected) selectable.forEach(function(item) { selectedUnsub.add(item.emailId); });
    renderUnsubscribe();
  });

  async function processSelectedUnsubscribes() {
    var selectedItems = unsubItems.filter(function(item) { return selectedUnsub.has(item.emailId); });
    if (selectedItems.length === 0) return;
    unsubLoading = true;
    updateUnsubToolbar();

    try {
      var res = await fetch('/api/unsubscribe/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selectedItems.map(function(item) { return { sender: item.sender, emailId: item.emailId }; }),
        }),
      });
      if (!res.ok) {
        var failure = await res.json().catch(function() { return {}; });
        throw new Error(failure.error || 'HTTP ' + res.status);
      }

      var data = await res.json();
      var resultByEmail = new Map(data.results.map(function(result) { return [result.emailId, result]; }));
      var succeeded = 0;
      unsubItems = unsubItems.filter(function(item) {
        var result = resultByEmail.get(item.emailId);
        if (!result) return true;
        if (result.success) {
          succeeded++;
          return false;
        }
        item.error = result.error || 'Request failed';
        return true;
      });
      selectedUnsub.clear();
      renderUnsubscribe();
      var failed = data.results.length - succeeded;
      showToast(
        succeeded + ' unsubscribed' + (failed ? ', ' + failed + ' need review' : ''),
        failed > 0
      );
    } catch (e) {
      showToast('Bulk unsubscribe failed: ' + e.message, true);
    } finally {
      unsubLoading = false;
      updateUnsubToolbar();
    }
  }

  unsubProcessBtn.addEventListener('click', function() {
    if (!unsubProcessBtn.classList.contains('confirming')) {
      var count = selectedUnsub.size;
      unsubProcessBtn.classList.add('confirming');
      unsubProcessBtn.textContent = 'Confirm ' + count + ' unsubscribe' + (count === 1 ? '' : 's');
      unsubConfirmTimer = setTimeout(updateUnsubToolbar, 5000);
      return;
    }
    resetUnsubConfirmation();
    processSelectedUnsubscribes();
  });

  unsubListEl.addEventListener('click', async function(e) {
    var keepBtn = e.target.closest('[data-action="keep"]');
    if (!keepBtn) return;
    var row = keepBtn.closest('.unsub-row');
    var item = unsubItems[parseInt(row.getAttribute('data-index'))];
    if (!item) return;
    keepBtn.disabled = true;

    try {
      var res = await fetch('/api/unsubscribe/keep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ sender: item.sender, emailId: item.emailId }] }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      selectedUnsub.delete(item.emailId);
      unsubItems.splice(parseInt(row.getAttribute('data-index')), 1);
      renderUnsubscribe();
      showToast('Keeping ' + item.sender, false);
    } catch (e) {
      keepBtn.disabled = false;
      showToast('Could not save choice', true);
    }
  });

  attnLoadMoreBtn.addEventListener('click', function() { loadAttention(false); });

  // Initial load
  loadAttention(true);
  loadAttentionCount();
  loadUnsubscribeCount();
})();
</script>

</body>
</html>`);
});

// Start
async function start() {
  if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
  initDb();
  await ensureCorrectionsTable();
  await ensureOptimizationTables();
  await ensureAttentionActionsTable();
  await ensureUnsubscribeActionsTable();

  serve({ fetch: app.fetch, port: 3100 }, (info) => {
    console.log(`Email Triage server running on http://localhost:${info.port}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await closeDb();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
  });
}
