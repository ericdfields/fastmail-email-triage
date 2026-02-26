import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  initDb,
  closeDb,
  ensureCorrectionsTable,
  getRecentClassifications,
  insertCorrection,
} from "./db.js";
import type { Tier } from "./types.js";

const TIERS: Tier[] = ["auto-delete", "auto-archive", "confirm", "attention"];
const app = new Hono();

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
  <div class="list" id="list"></div>
  <div class="load-more-wrap" id="loadMoreWrap" style="display:none">
    <button class="btn-load-more" id="loadMoreBtn">Load more</button>
  </div>
  <div class="empty" id="empty" style="display:none">No classifications yet.</div>
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

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const loadMoreWrap = document.getElementById('loadMoreWrap');
  const toastEl = document.getElementById('toast');

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

  // Event delegation
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

  refreshBtn.addEventListener('click', function() { loadClassifications(true); });
  loadMoreBtn.addEventListener('click', function() { loadClassifications(false); });

  // Initial load
  loadClassifications(true);
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

  serve({ fetch: app.fetch, port: 3100 }, (info) => {
    console.log(`Email Triage server running on http://localhost:${info.port}`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await closeDb();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
