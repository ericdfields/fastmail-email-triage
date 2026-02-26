# Mobile Web UI + Scheduled Triage + Correction Feedback — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a mobile-friendly web UI for reviewing classifications, schedule triage to run automatically, and feed corrections back into the classifier.

**Architecture:** Hono web server on port 3100 serves a REST API and inline HTML frontend. Cloudflare Tunnel + Access provides HTTPS and auth. launchd manages the server, tunnel, and hourly triage job. The classifier reads aggregated corrections from the DB and includes them as in-context examples.

**Tech Stack:** Hono, vanilla HTML/CSS/JS, launchd, Cloudflare Tunnel, Cloudflare Access, PostgreSQL (existing)

**Design doc:** `docs/plans/2026-02-25-mobile-web-ui-design.md`

---

### Task 1: Install Hono and add server script

**Files:**
- Modify: `package.json`

**Step 1: Install hono**

Run: `npm install hono @hono/node-server`

**Step 2: Add server script to package.json**

Add to `"scripts"`:
```json
"server": "doppler run -- tsx src/server.ts"
```

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add hono dependency and server script"
```

---

### Task 2: Add getRecentCorrections to db.ts

**Files:**
- Modify: `src/db.ts` (after `getAccuracyStats` function, ~line 278)

**Step 1: Add the function**

Add to the end of `src/db.ts` (before the closing of the module):

```typescript
/** Get recent corrections aggregated by sender (most recent per unique sender, capped at 50). */
export async function getRecentCorrections(limit: number = 50) {
  const result = await pool.query<{
    sender: string;
    subject: string;
    has_list_unsubscribe: boolean;
    original_tier: Tier;
    corrected_tier: Tier;
  }>(
    `SELECT DISTINCT ON (c.sender)
            c.sender, c.subject, c.has_list_unsubscribe,
            cr.original_tier, cr.corrected_tier
     FROM corrections cr
     JOIN classifications c ON cr.email_id = c.email_id AND cr.run_id = c.run_id
     ORDER BY c.sender, cr.corrected_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map((r) => ({
    sender: r.sender,
    subject: r.subject,
    hasListUnsubscribe: r.has_list_unsubscribe,
    originalTier: r.original_tier,
    correctedTier: r.corrected_tier,
  }));
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat: add getRecentCorrections aggregated by sender"
```

---

### Task 3: Wire correction feedback into classifier

**Files:**
- Modify: `src/classifier.ts` (lines 52-77, `classifyBatch` function)
- Modify: `src/index.ts` (line 117, `classifyBatch` call)

**Step 1: Update classifyBatch to accept corrections**

In `src/classifier.ts`, add a `Correction` type and update the function signature:

```typescript
export interface CorrectionExample {
  sender: string;
  subject: string;
  hasListUnsubscribe: boolean;
  originalTier: string;
  correctedTier: string;
}

export async function classifyBatch(
  emails: EmailSummary[],
  model: string = "claude-sonnet-4-6",
  corrections: CorrectionExample[] = []
): Promise<Classification[]> {
```

Build the corrections prompt section and append it to the system prompt:

```typescript
  let systemPrompt = SYSTEM_PROMPT;

  if (corrections.length > 0) {
    const lines = corrections.map(
      (c) =>
        `- "${c.subject}" from ${c.sender}${c.hasListUnsubscribe ? " (has List-Unsubscribe)" : ""} was corrected from ${c.originalTier} → ${c.correctedTier}`
    );
    systemPrompt += `\n\n## Recent Corrections (learn from these)\n\nThe following classifications were manually corrected. Apply these patterns:\n${lines.join("\n")}`;
  }
```

Update the `anthropic.messages.create` call to use `systemPrompt` instead of `SYSTEM_PROMPT`:

```typescript
    system: systemPrompt,
```

**Step 2: Update index.ts to fetch and pass corrections**

In `src/index.ts`, add `getRecentCorrections` to the imports from `./db.js` (line 3-12):

```typescript
import {
  initDb,
  closeDb,
  createRun,
  findIncompleteRun,
  insertClassifications,
  markActionsApplied,
  completeRun,
  getRunSummary,
  getRecentCorrections,
} from "./db.js";
```

Add `ensureCorrectionsTable` to that import as well, and call it after `initDb()` (line 29):

```typescript
  initDb();
  await ensureCorrectionsTable();
```

Before the batch loop (around line 90, after the watch mode SIGINT handler), fetch corrections:

```typescript
  const corrections = await getRecentCorrections();
  if (corrections.length > 0) {
    console.log(`Loaded ${corrections.length} correction patterns for classifier`);
  }
```

Update the `classifyBatch` call (line 117) to pass corrections:

```typescript
        classifications = await classifyBatch(newEmails, model, corrections);
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/classifier.ts src/index.ts
git commit -m "feat: feed correction history into classifier prompt"
```

---

### Task 4: Create the Hono API server

**Files:**
- Create: `src/server.ts`

**Step 1: Create the server**

Create `src/server.ts` with:

```typescript
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

// Frontend: Serve inline HTML (Task 5 will fill this in)
app.get("/", (c) => {
  return c.html("<h1>Email Triage</h1><p>Frontend placeholder</p>");
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
```

**Step 2: Test the server starts**

Run: `npm run server`
Expected: `Email Triage server running on http://localhost:3100`
Ctrl+C to stop.

**Step 3: Test the API endpoint**

Run in another terminal:
```bash
doppler run -- tsx src/server.ts &
sleep 2
curl -s http://localhost:3100/api/classifications?limit=5 | head -c 200
kill %1
```
Expected: JSON array of classification objects

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add Hono API server with classifications and corrections endpoints"
```

---

### Task 5: Build the mobile frontend

**Files:**
- Modify: `src/server.ts` (replace the placeholder `GET /` handler)

**Step 1: Replace the frontend placeholder**

Replace the `app.get("/", ...)` handler with one that returns the full inline HTML page. The HTML should be a template literal containing the complete single-page app.

Use the `@frontend-design` skill for this step to ensure high design quality.

**Design requirements:**
- Dark theme (#0a0a0f background, cards with subtle borders in #1a1a2e or similar)
- System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
- Tier badge colors: auto-delete=#ef4444, auto-archive=#eab308, confirm=#06b6d4, attention=#22c55e
- Card layout: sender bold at top, subject below, tier badge + timestamp on a row, reason in muted text
- Corrected items: original tier struck through, corrected badge next to it
- Tap a card to expand tier selection — four pill buttons, min 44px height
- Optimistic UI: update the badge immediately on tap, revert if API fails
- Refresh button in header, "Load more" button at bottom
- Smooth CSS transitions on tier changes (0.2s ease)
- Responsive: single column, works at 320px width, comfortable at 390px (iPhone)
- No external CSS/JS dependencies — everything inline
- Use `fetch()` for API calls

**Step 2: Test on mobile simulator or responsive mode**

Open `http://localhost:3100` in browser, use responsive/device mode to verify at 390px width.

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: add mobile-friendly classification review frontend"
```

---

### Task 6: Create launchd plist files

**Files:**
- Create: `launchd/com.email-triage.server.plist`
- Create: `launchd/com.email-triage.triage.plist`
- Create: `launchd/com.email-triage.tunnel.plist`

**Step 1: Create launchd directory**

Run: `mkdir -p launchd`

**Step 2: Create server plist**

Create `launchd/com.email-triage.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.email-triage.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/doppler</string>
        <string>run</string>
        <string>--</string>
        <string>/opt/homebrew/bin/tsx</string>
        <string>src/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/ericbrookfield/Development/fastmail-email-triage</string>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-server.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-server.log</string>
</dict>
</plist>
```

**Step 3: Create triage plist**

Create `launchd/com.email-triage.triage.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.email-triage.triage</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/doppler</string>
        <string>run</string>
        <string>--</string>
        <string>/opt/homebrew/bin/tsx</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/ericbrookfield/Development/fastmail-email-triage</string>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-triage.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-triage.log</string>
</dict>
</plist>
```

**Step 4: Create tunnel plist**

Create `launchd/com.email-triage.tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.email-triage.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/ericbrookfield/Development/fastmail-email-triage</string>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/ericbrookfield/Library/Logs/email-triage-tunnel.log</string>
</dict>
</plist>
```

Note: The tunnel plist assumes `cloudflared` is configured with a named tunnel via `~/.cloudflared/config.yml`. The setup instructions (Task 8) will cover this.

**Step 5: Verify plists are valid**

Run:
```bash
plutil -lint launchd/*.plist
```
Expected: All three show "OK"

**Step 6: Commit**

```bash
git add launchd/
git commit -m "feat: add launchd plist files for server, triage, and tunnel"
```

---

### Task 7: Verify the full system works locally

**Step 1: Start the server**

Run: `npm run server`
Expected: Server starts on 3100, frontend loads at http://localhost:3100

**Step 2: Verify classifications API**

Run: `curl -s http://localhost:3100/api/classifications?limit=3 | python3 -m json.tool`
Expected: JSON array with classification objects

**Step 3: Test a correction via API**

Pick an emailId from step 2, then:
```bash
curl -s -X POST http://localhost:3100/api/corrections \
  -H "Content-Type: application/json" \
  -d '{"emailId": "<id>", "tier": "attention"}' | python3 -m json.tool
```
Expected: JSON with originalTier and correctedTier

**Step 4: Verify correction appears in frontend**

Reload http://localhost:3100 — the corrected email should show the updated tier.

**Step 5: Test triage with corrections loaded**

Run: `npm run triage -- --dry-run`
Expected: Output includes "Loaded N correction patterns for classifier"

---

### Task 8: Update README.md and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Step 1: Update README.md**

Add sections for:

**Web UI** — explain `npm run server`, what it does, port 3100

**Scheduled Triage** — explain the launchd setup:
```bash
# Symlink plist files
ln -s "$(pwd)/launchd/com.email-triage.server.plist" ~/Library/LaunchAgents/
ln -s "$(pwd)/launchd/com.email-triage.triage.plist" ~/Library/LaunchAgents/
ln -s "$(pwd)/launchd/com.email-triage.tunnel.plist" ~/Library/LaunchAgents/

# Load them
launchctl load ~/Library/LaunchAgents/com.email-triage.server.plist
launchctl load ~/Library/LaunchAgents/com.email-triage.triage.plist
launchctl load ~/Library/LaunchAgents/com.email-triage.tunnel.plist

# Check status
launchctl list | grep email-triage

# View logs
tail -f ~/Library/Logs/email-triage-server.log
tail -f ~/Library/Logs/email-triage-triage.log

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.email-triage.server.plist
```

**Cloudflare Tunnel Setup** — one-time steps:
1. Install cloudflared: `brew install cloudflared`
2. Login: `cloudflared tunnel login`
3. Create tunnel: `cloudflared tunnel create email-triage`
4. Configure `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /Users/ericbrookfield/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: triage.yourdomain.com
       service: http://localhost:3100
     - service: http_status:404
   ```
5. Add DNS: `cloudflared tunnel route dns email-triage triage.yourdomain.com`
6. Set up Cloudflare Access policy in the Zero Trust dashboard for `triage.yourdomain.com`

**Cleanup command** — document `npm run cleanup` and `npm run cleanup -- --dry-run`

**Correction feedback** — note that the classifier automatically learns from corrections

Update the project structure section to include `server.ts` and `cleanup.ts`.

**Step 2: Update CLAUDE.md**

Add to the Architecture section:
- `src/server.ts` — Hono web server for mobile classification review UI
- `src/cleanup.ts` — Standalone inbox cleanup (archive stale read emails)
- `launchd/` — launchd plist files for scheduled services

Add to Running the Project:
```bash
# Start web UI server
npm run server

# Archive read emails older than 1 month
npm run cleanup
npm run cleanup -- --dry-run
```

Add a new "Web UI & Scheduled Services" section covering the launchd setup.

**Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add web UI, scheduled triage, and cleanup documentation"
```
