# Mobile Web UI + Scheduled Triage + Correction Feedback

**Date:** 2026-02-25

## Problem

The triage system only runs manually via CLI, the correction TUI requires a terminal, and the classifier doesn't learn from corrections.

## Solution

Three features:

1. **Scheduled triage** on Mac Studio via launchd (every 60 minutes)
2. **Mobile web UI** for reviewing/correcting classifications (Hono server + Cloudflare Tunnel + Cloudflare Access)
3. **Correction feedback loop** — classifier reads recent corrections and uses them as in-context examples

## Architecture

```
Cloudflare Access (SSO/OTP)
  -> Cloudflare Tunnel (cloudflared)
    -> Hono Server :3100
      -> GET /              (static HTML frontend)
      -> GET /api/classifications?limit=50&offset=0
      -> POST /api/corrections  { emailId, tier }
      -> PostgreSQL (Neon, existing)

launchd (every 60 min)
  -> tsx src/index.ts
    -> reads corrections -> injects into classifier prompt
```

Three launchd-managed processes:
- Hono web server (KeepAlive, port 3100)
- cloudflared tunnel (KeepAlive)
- Triage job (StartInterval 3600, RunAtLoad)

## Web Server & API

Hono app in `src/server.ts`, three routes:

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves static HTML/CSS/JS page inline |
| `/api/classifications` | GET | Recent classifications with correction status. Params: `limit`, `offset` |
| `/api/corrections` | POST | Record correction. Body: `{ emailId, tier }` |

No auth in the app — Cloudflare Access handles authentication at the tunnel layer.

## Mobile Frontend

Single HTML file served inline by Hono. One screen:

- Vertical card list sorted by received_at descending
- Each card: sender, subject, timestamp, color-coded tier badge, muted reason text
- Corrected items show original tier struck through with corrected tier
- Tap tier badge row to reveal four pill buttons for correction, optimistic UI update
- Dark theme, system font stack, min 44px touch targets
- Tier colors: red (delete), yellow (archive), cyan (confirm), green (attention)
- Subtle card borders, smooth transitions on tier changes
- Responsive down to 320px width
- Refresh button at top, "Load more" button at bottom

## Correction Feedback Loop

Before each triage run, query recent corrections aggregated by sender:
- Group by sender, keep most recent correction per unique sender
- Cap at 50 unique senders
- Inject into classifier system prompt as a "Recent Corrections" section after Personal Rules

New DB function: `getRecentCorrections()` returns `{ sender, subject, hasListUnsubscribe, originalTier, correctedTier }`.

Prompt injection format:
```
## Recent Corrections (learn from these)

The following classifications were manually corrected. Apply these patterns:
- "Newsletter from sender@example.com" was corrected from confirm -> auto-archive
- "Payment reminder from billing@service.com" was corrected from auto-archive -> attention
```

## Scheduled Jobs (launchd)

Three plist files in `launchd/` directory (symlinked to `~/Library/LaunchAgents/`):

| Plist | Process | Restart Policy |
|---|---|---|
| `com.email-triage.server.plist` | Hono web server via Doppler | KeepAlive |
| `com.email-triage.triage.plist` | Triage job via Doppler | StartInterval 3600, RunAtLoad |
| `com.email-triage.tunnel.plist` | cloudflared tunnel run | KeepAlive |

Logs go to `~/Library/Logs/email-triage-*.log`.

## File Changes

**New dependency:** `hono`

**New files:**
- `src/server.ts` — Hono app, API routes, inline frontend HTML
- `launchd/com.email-triage.server.plist`
- `launchd/com.email-triage.triage.plist`
- `launchd/com.email-triage.tunnel.plist`

**Modified files:**
- `src/db.ts` — add `getRecentCorrections()`
- `src/classifier.ts` — accept corrections array, append to system prompt
- `src/index.ts` — call `getRecentCorrections()`, pass to `classifyBatch()`
- `package.json` — add `hono`, add `"server"` script
- `CLAUDE.md` — update with web server and launchd documentation
- `README.md` — setup instructions

**Unchanged:** `src/jmap.ts`, `src/correct.ts`, `src/accuracy.ts`, DB schema
