# Fastmail Email Triage

Classifies unread Fastmail inbox emails into four tiers through OpenRouter, then acts on them
automatically via JMAP. Every classification is persisted to Postgres, so runs are
resumable, correctable, and measurable.

Two halves:

- **Triage** (`npm run triage`) — the automated pass. Classifies unread mail and applies
  actions. Runs hourly under launchd.
- **Attention processing** (`npm run act`, or the web UI) — the human pass. Works through
  the `attention` pile one email at a time: archive it, snooze it, or reclassify it.
- **Unsubscribe review** (web UI) — groups recurring List-Unsubscribe senders for explicit
  bulk approval. It uses no model calls and only executes verified RFC 8058 one-click requests.

## Tiers

| Tier | Action | Typical senders |
|------|--------|-----------------|
| `auto-delete` | Move to Trash | Spam, phishing, cold marketing |
| `auto-archive` | Move to Archive, mark as read | Newsletters, notifications, receipts |
| `confirm` | Mark as read, keep in Inbox | Ambiguous — read it when convenient |
| `attention` | **No action** (stays unread in Inbox) | Real people, bills, medical, orders |

`attention` is deliberately inert. Nothing touches those emails until a human processes
them via `npm run act` or the web UI.

---

## Setting up on a new machine

### 1. Prerequisites

| Tool | Notes |
|------|-------|
| Node.js 22+ | The launchd plists pin `nodejs 22.14.0` via asdf — see [launchd](#scheduled-services-macos-launchd) |
| [Doppler CLI](https://docs.doppler.com/docs/install-cli) | `brew install dopplerhq/cli/doppler` — all secrets come from here, there is no `.env` |
| PostgreSQL | Any Postgres 14+ host. Currently a managed instance; connection string lives in Doppler |
| `psql` | Only needed once, to bootstrap the schema |
| `cloudflared` | Optional — only for remote access to the web UI |

### 2. Clone and install

```bash
git clone https://github.com/ericdfields/fastmail-email-triage.git
cd fastmail-email-triage
npm install
```

There is no build step — `tsx` runs the TypeScript directly.

### 3. Wire up Doppler

```bash
doppler login
doppler setup   # select the project + config for this app
doppler secrets --only-names   # sanity check: should list the vars below
```

Every `npm run` script is wrapped in `doppler run --`, so if this step is skipped every
command fails with `Missing FASTMAIL_API_TOKEN` (or similar).

### 4. Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `FASTMAIL_API_TOKEN` | yes | Fastmail API token with **mail read/write** scope. Create at Fastmail → Settings → Privacy & Security → Integrations → API tokens |
| `OPENROUTER_API_KEY` | yes | Used for primary and backup classification models |
| `OPENROUTER_DAILY_BUDGET_USD` | no | Daily model-call circuit breaker for triage; defaults to `$1.00` |
| `JOB_DAILY_BUDGET_USD` | no | Separate daily circuit breaker for job-alert scoring and research; defaults to `$2.00` |
| `DATABASE_URL` | yes | `postgresql://user:password@host:port/db` — SSL is enabled with `rejectUnauthorized: false` |
| `UPTIME_KUMA_PUSH_URL` | no | Push-monitor URL. Pinged after a successful triage run so a missed run raises an alert |

### 5. Bootstrap the database

Pointing at an existing database? Skip this — the data is already there.

For a fresh one:

```bash
doppler run -- bash -c 'psql "$DATABASE_URL" -f db/schema.sql'
```

`db/schema.sql` is idempotent and creates all six tables plus the `tier` enum. (The
`corrections`, `attention_actions`, `sender_rules`, `model_calls`, and `unsubscribe_actions`
tables are also auto-created at runtime, but
`triage_runs` and `classifications` are not — they must exist before the first run.)

### 6. Verify before letting it loose

```bash
npm test                    # unit tests, no network or DB needed
npx tsc --noEmit            # should be silent
npm run triage -- --dry-run # classifies + reports, writes no classifications or mail actions
```

A clean `--dry-run` confirms the Fastmail token, the OpenRouter key, and the database all
work. Then run the real thing:

```bash
npm run triage
```

---

## Commands

| Command | What it does |
|---------|-------------|
| `npm run triage` | Classify and act on all unread inbox mail |
| `npm run triage -- --dry-run` | Classify and report, but persist no classifications or JMAP actions |
| `npm run triage -- --watch` | Poll continuously every 60s (Ctrl-C finishes the batch; twice force-quits) |
| `npm run act` | Terminal TUI for working the attention queue |
| `npm run act -- --batch 10` | Same, 10 emails per sitting (default 5) |
| `npm run correct` | Terminal TUI for reviewing recent classifications |
| `npm run correct -- <email_id> <tier>` | Record one correction non-interactively |
| `npm run accuracy` | Correction-rate stats, overall and per tier |
| `npm run server` | Web UI + JSON API on port 3100 |
| `npm run restart` | Reload the launchd server job (macOS only) |
| `npm run cleanup` | Archive read inbox mail older than 1 month (`-- --dry-run` supported) |
| `npm run jobs -- help` | Job-alert pipeline commands (see [Job alerts](#job-alerts)) |
| `npm test` | Vitest suite (`test:watch`, `test:coverage` also available) |

### Attention queue TUI (`npm run act`)

| Key | Action |
|-----|--------|
| `j` / `k` or ↓ / ↑ | Navigate |
| `g` / `G` | Jump to first / last |
| `a` | Mark acted — archives the email and records it |
| `s` | Snooze — then `1`/`2`/`3` for 1, 3, or 7 days |
| `r` | Reclassify — then `1`/`2`/`3` for auto-delete / auto-archive / confirm. Records a correction *and* applies the tier action |
| `q` / Ctrl-C | Quit |

Reclassifying here creates an exact-sender rule. Future messages from that sender bypass
the model; domain-wide rules are never inferred automatically.

### Web UI

```bash
npm run server   # http://localhost:3100
```

Mobile-friendly dark UI with four tabs — **Attention** (the default; act / snooze /
reclassify from your phone), **Review** (browse and correct recent classifications),
**Jobs** (yay or nay on screened job alerts, and research for each yay), and
**Unsub** (review recurring senders and approve one-click requests in batches of 25).

The unsubscribe review is deliberately human-gated. Candidates need at least two messages
in the last 90 days. The browser never receives the full unsubscribe URL, HTTPS targets are
re-fetched from Fastmail at approval time, private-network destinations and redirects are
rejected, and only `List-Unsubscribe-Post: List-Unsubscribe=One-Click` endpoints with passing
DKIM authentication covering both unsubscribe headers are executed.
Choosing **Keep** suppresses future suggestions for that exact sender.

API routes, all JSON:

| Method | Route |
|--------|-------|
| `GET` | `/api/classifications` |
| `POST` | `/api/corrections` |
| `GET` | `/api/attention` |
| `GET` | `/api/attention/count` |
| `POST` | `/api/attention/act` |
| `POST` | `/api/attention/snooze` |
| `POST` | `/api/attention/reclassify` |
| `GET` | `/api/unsubscribe/count` |
| `GET` | `/api/unsubscribe/candidates` |
| `POST` | `/api/unsubscribe/process` |
| `POST` | `/api/unsubscribe/keep` |
| `GET` | `/api/jobs?view=review\|yay\|nay\|in-process\|passed` |
| `GET` | `/api/jobs/counts` |
| `POST` | `/api/jobs/decision` |
| `POST` | `/api/jobs/research/retry` |

The server has **no authentication** — it is meant to sit behind Cloudflare Access. Do
not expose port 3100 directly.

---

## How triage works

1. Connect to Fastmail JMAP; resolve inbox / archive / trash mailbox IDs
2. Look for an incomplete run to resume; retry any classified-but-unacted emails
3. Fetch unread emails in batches of 50 and skip IDs genuinely classified in any prior run
4. Apply exact-sender rules, then auto-archive remaining `List-Unsubscribe` mail locally
5. Classify only the remaining mail with GPT-5.6 Luna through OpenRouter
6. Retry a failed model request once with Claude Haiku 4.5, then abort the run
7. Persist classifications and apply tier actions in one `Email/set` call per batch
8. Record token/cost/latency usage, print a summary, and ping the Uptime Kuma heartbeat

If both model attempts fail, the run stops, sends a failed heartbeat, and writes no fake
classification. The affected emails remain unread for the next scheduled retry.

### Resumability

`acted_at` is only stamped after JMAP confirms the action, so a crash anywhere in the
loop is recoverable. On the next start:

- The incomplete run (`completed_at IS NULL`) is detected and reused
- Already-classified email IDs are skipped across all runs, so attention mail stays queued
  without being repeatedly sent to a model
- Classified-but-unacted emails get their actions retried first
- New batches continue from where they left off

---

## Job alerts

A side pipeline turns LinkedIn and Indeed job-alert emails into a short list of roles
worth a look. Triage still archives the alert emails; the job pipeline reads them from any
mailbox. It runs after each triage run (every 15 minutes in watch mode), and a failure in
it never fails triage.

1. Find alert emails from exact job-board senders received in the last 3 days
2. Convert each body to text. Job links become `[J1]`-style references to canonical
   LinkedIn or Indeed URLs; tracking tokens and all other links are dropped
3. Ask the triage model to list each job and screen it against the saved profile as
   yay, maybe, or nay. Recent decisions where you overruled the screen go into the prompt
4. Apply the profile's hard rules in code: out-of-lane titles, avoided companies, and a
   base-pay ceiling below the floor force nay. Missing pay never does. A LinkedIn
   connection at the company lifts a maybe to yay
5. Merge repeats by company and title, and store each sighting
6. Show yay and maybe in the **Jobs** tab. Nays are hidden but kept, with a reason, under
   **Hidden nays**. Companies in the active pipeline appear under **In process** instead
7. When you mark a job yay, research runs with Claude Sonnet 5 and OpenRouter web search:
   - check whether the posting is still open, and stop if it is closed
   - research the company, cached for 30 days. A named person is kept only when the
     search actually returned the cited page
   - draft an outreach note only when a named contact exists. The drafting call gets
     structured research, never posting or web text. The note is checked against the
     voice rules and for text aimed at AI tools, and the checks are shown, not auto-fixed

The profile is private and lives in the `job_profiles` table, never in this repo. Write it
as markdown with a fenced `json job-rules` block (`minBaseSalaryUsd`, `nayTitlePatterns`,
`avoidCompanies`, `highInterestCompanies`, `bannedPhrases`, and optionally `jobAlertSenders`). Each save
creates a new version, and every job records the version that screened it.

```bash
npm run jobs -- profile check ~/private/job-profile.md   # parse only, no database
npm run jobs -- profile set ~/private/job-profile.md     # save a new version
npm run jobs -- process --days 14 --dry-run              # screen recent alerts, save nothing
npm run jobs -- process --days 14                        # backfill
npm run jobs -- connections import ~/Downloads/Connections.csv
npm run jobs -- pipeline add "Example Co" --stage "Applied"
npm run jobs -- nays                                     # y un-nays, n confirms
npm run jobs -- research                                 # run queued research now
npm run jobs -- stats                                    # screen vs. your decisions
```

The LinkedIn export comes from LinkedIn → Settings → Data privacy → Get a copy of your
data → Connections.

---

## Database

Sixteen tables plus a `tier` enum — see [`db/schema.sql`](db/schema.sql) for the full DDL.

| Table | Holds |
|-------|-------|
| `triage_runs` | One row per invocation; `completed_at IS NULL` means "resume me" |
| `classifications` | One row per (email, run) — tier, reason, `acted_at` |
| `corrections` | Human overrides and the audit trail for sender rules |
| `attention_actions` | Which attention emails were acted on or snoozed, and until when |
| `sender_rules` | Exact normalized sender decisions learned from explicit corrections |
| `model_calls` | Per-attempt model, token, cache, cost, latency, and failure accounting |
| `unsubscribe_actions` | Human keep/unsubscribe decisions and one-click outcomes; full URLs are never retained |
| `job_profiles` | Versioned private job profile text and parsed rules |
| `job_alert_emails` | Each job-alert email processed, with attempt count and error |
| `jobs` | One row per distinct role: screen verdict, reason, rule or model, profile version |
| `job_sightings` | Each alert email that listed a job |
| `job_decisions` | Your yay or nay, with an optional note |
| `job_research` | Research status, posting check, outreach draft, and warnings per yay |
| `company_research` | Cached company research and cited contacts |
| `linkedin_connections` | Imported LinkedIn connections, keyed by normalized company |
| `active_pipeline` | Companies where an application or conversation is in progress |

---

## Scheduled services (macOS launchd)

Three jobs run the system unattended:

| Service | What it does | Restart policy |
|---------|-------------|----------------|
| `com.email-triage.server` | Web UI on port 3100 | Always running (KeepAlive) |
| `com.email-triage.triage` | Triage run every 60 minutes | RunAtLoad + StartInterval |
| `com.email-triage.tunnel` | Cloudflare Tunnel | Always running (KeepAlive) |

> **The plists contain absolute paths for one specific machine.** Before loading them on
> a new box, edit all three files in `launchd/` and update:
>
> - `WorkingDirectory` → wherever the repo is cloned
> - the `node` path (currently `/Users/ericbrookfield/.asdf/installs/nodejs/22.14.0/bin/node`)
> - `/opt/homebrew/bin/doppler` and `/opt/homebrew/bin/cloudflared` (Intel Macs use `/usr/local/bin`)
> - `StandardOutPath` / `StandardErrorPath`
>
> The absolute node path is deliberate: launchd doesn't run a login shell, so asdf shims
> aren't on `PATH`. Find yours with `asdf which node`.

```bash
# Symlink
ln -s "$(pwd)/launchd/com.email-triage.server.plist" ~/Library/LaunchAgents/
ln -s "$(pwd)/launchd/com.email-triage.triage.plist" ~/Library/LaunchAgents/
ln -s "$(pwd)/launchd/com.email-triage.tunnel.plist" ~/Library/LaunchAgents/

# Load (start)
launchctl load ~/Library/LaunchAgents/com.email-triage.server.plist
launchctl load ~/Library/LaunchAgents/com.email-triage.triage.plist
launchctl load ~/Library/LaunchAgents/com.email-triage.tunnel.plist

# Status — second column is the last exit code; 0 is healthy
launchctl list | grep email-triage

# Logs
tail -f ~/Library/Logs/email-triage-server.log
tail -f ~/Library/Logs/email-triage-triage.log

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.email-triage.server.plist
```

After editing `src/server.ts`, `npm run restart` reloads the server job.

### Cloudflare Tunnel (one-time)

1. `brew install cloudflared`
2. `cloudflared tunnel login`
3. `cloudflared tunnel create email-triage`
4. Configure `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: ~/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: triage.yourdomain.com
       service: http://localhost:3100
     - service: http_status:404
   ```
5. `cloudflared tunnel route dns email-triage triage.yourdomain.com`
6. Add a Cloudflare Access policy for `triage.yourdomain.com` — the app itself has no auth

Tunnel credentials live in `~/.cloudflared/` and are **not** in this repo. Moving to a new
machine means re-running steps 1–2 and copying the credentials file (or creating a new
tunnel).

---

## Project structure

```
src/
  index.ts      — Triage entry point: CLI flags, orchestration loop
  jmap.ts       — Fastmail JMAP client (session, queries, batch fetch, actions)
  classifier.ts — OpenRouter structured classification with one backup attempt
  routing.ts    — deterministic sender and List-Unsubscribe routing
  db.ts         — Postgres persistence, deduplication, rules, and model accounting
  types.ts      — Shared interfaces (EmailSummary, Tier, Classification, ...)
  server.ts     — Hono web server + embedded mobile UI (port 3100)
  act.ts        — Attention-queue TUI (act / snooze / reclassify)
  correct.ts    — Classification review TUI
  accuracy.ts   — Accuracy stats CLI
  cleanup.ts    — Archive stale read inbox mail
  unsubscribe.ts — RFC 8058 parsing and pinned-address one-click requests
  openrouter.ts — Shared structured-output OpenRouter call with web search option
  jobs.ts       — Job-alert parsing, profile rules, prompts, and output checks (pure)
  jobsDb.ts     — Job tables and queries
  jobScoring.ts — Job-alert pipeline: find, split, screen, store
  jobResearch.ts — Posting check, company research, and outreach drafts for yays
  jobsCli.ts    — `npm run jobs` commands and the hidden-nay review TUI
  *.test.ts     — Vitest unit tests
db/schema.sql   — Full schema; idempotent bootstrap
launchd/        — launchd plists (machine-specific paths — see above)
docs/plans/     — Design + implementation notes for shipped features
bin/restart-server — Reload the launchd server job
```

## What lives outside this repo

Taking the project over means bringing these along:

- **Doppler project** — runtime secrets. Nothing here works without it.
- **Job profile** — kept outside the repo (for example in a local `private/` folder,
  which is gitignored) and loaded into `job_profiles`.
- **Postgres database** — the entire classification and correction history. The
  exact-sender routing gets meaningfully better from accumulated corrections; a fresh DB starts cold.
- **Fastmail API token** — machine-agnostic, but scoped to one account.
- **Cloudflare Tunnel credentials** — `~/.cloudflared/`.
- **launchd jobs** — per-machine, and the plists need path edits.
