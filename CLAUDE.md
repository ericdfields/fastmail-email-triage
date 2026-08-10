# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

## Read this first

- **This repo is public.** Never commit secrets, connection strings, or real email
  content. `.claude/settings.local.json` is gitignored because approved-command entries
  can capture connection strings — leave it that way.
- **Secrets come from Doppler, not `.env`.** Every npm script is wrapped in
  `doppler run --`. Running `tsx src/foo.ts` bare will fail on missing env vars.
- **This system deletes and archives real mail.** Use `--dry-run` when testing triage
  changes. `--dry-run` records model-call accounting but writes no classifications and
  applies no JMAP actions.
- **The database is the valuable asset**, not the code. It holds the full classification
  and correction history that makes the classifier good. Don't run destructive SQL against
  it, and don't point the app at a fresh DB without saying so.

## Project overview

Automated email triage: fetches unread mail from a Fastmail inbox over JMAP, classifies it
into four tiers through OpenRouter, applies tier actions, and persists everything to Postgres for
resumability and accuracy tracking. A second, human-driven pass works through the
`attention` pile.

## Architecture

```
src/
  index.ts      — Triage entry point, CLI flags, orchestration loop
  jmap.ts       — Fastmail JMAP client (session, queries, batch fetching, actions)
  classifier.ts — OpenRouter structured classification with primary/backup routing
  routing.ts    — deterministic sender and List-Unsubscribe routing
  db.ts         — Postgres persistence, deduplication, rules, and model accounting
  types.ts      — Shared TypeScript interfaces (EmailSummary, Tier, Classification, ...)
  server.ts     — Hono web server + inline mobile UI (port 3100)
  act.ts        — Attention-queue TUI: act / snooze / reclassify
  correct.ts    — Classification review TUI
  accuracy.ts   — Accuracy stats CLI
  cleanup.ts    — Standalone inbox cleanup (archive read mail older than 1 month)
  *.test.ts     — Vitest unit tests for jmap, db, classifier
db/schema.sql   — Full schema, idempotent
launchd/        — launchd plists for scheduled services
docs/plans/     — Design + implementation notes for shipped features
bin/restart-server — Reload the launchd server job
```

`server.ts` is ~1400 lines because the entire mobile UI (HTML, CSS, JS) is a template
literal inside it. There is no frontend build step. Expect to scroll.

### Triage data flow

1. Connect to Fastmail JMAP, resolve inbox / archive / trash mailbox IDs
2. Check for an incomplete run to resume; retry pending actions first
3. Fetch unread emails in batches of 50 via async generator
4. Skip IDs classified in any prior run; route exact senders and List-Unsubscribe locally
5. Classify the remainder with GPT-5.6 Luna; retry once with Claude Haiku 4.5
6. Persist classifications and per-attempt token/cost/latency accounting
7. Apply tier actions via a single JMAP `Email/set` per batch
8. Print summary; ping `UPTIME_KUMA_PUSH_URL` up or down

### Tier system

| Tier | Action | Use case |
|------|--------|----------|
| `auto-delete` | Move to Trash | Spam, phishing, marketing |
| `auto-archive` | Move to Archive + mark read | Newsletters, notifications, receipts |
| `confirm` | Mark as read, keep in Inbox | Ambiguous messages needing human review |
| `attention` | No action (keep unread) | Real people, bills, medical, orders |

`attention` is intentionally inert during triage. Those emails are handled later by
`npm run act` or the web UI's Attention tab, and `attention_actions` records the outcome.

## Running the project

```bash
npm install

npm run triage                    # classify + act on unread inbox mail
npm run triage -- --dry-run       # classify + report, no classifications or JMAP actions
npm run triage -- --watch         # poll every 60s; SIGINT finishes the batch

npm run act                       # attention-queue TUI (default 5 per batch)
npm run act -- --batch 10         # larger sitting

npm run correct                   # review classifications (j/k navigate, 1-4 set tier, q quit)
npm run correct -- <email_id> <corrected_tier>   # record one correction directly
npm run accuracy                  # correction-rate stats

npm run server                    # web UI + JSON API on port 3100
npm run restart                   # reload the launchd server job (macOS)

npm run cleanup                   # archive read inbox mail older than 1 month
npm run cleanup -- --dry-run

npm test                          # vitest run
npm run test:watch
npm run test:coverage
npx tsc --noEmit                  # typecheck; should be silent
```

`tsx` runs the TypeScript directly — there is no build step.

## Environment variables

Managed via [Doppler](https://doppler.com). `doppler login && doppler setup` once per
machine.

- `FASTMAIL_API_TOKEN` — Fastmail API token with mail read/write access
- `OPENROUTER_API_KEY` — OpenRouter key for primary and backup models
- `OPENROUTER_DAILY_BUDGET_USD` — optional daily cost ceiling; defaults to $1.00
- `DATABASE_URL` — Postgres connection string
- `UPTIME_KUMA_PUSH_URL` — optional heartbeat pinged after a successful triage run

## Database schema

Postgres, a `tier` ENUM, and six tables. The authoritative DDL is
[`db/schema.sql`](db/schema.sql) — **update that file when you change the schema.**

| Table | Purpose |
|-------|---------|
| `triage_runs` | One row per invocation. `completed_at IS NULL` marks a resumable run |
| `classifications` | PK `(email_id, run_id)`. `acted_at` stamped only after JMAP succeeds |
| `corrections` | Human override audit trail |
| `attention_actions` | `acted` / `snoozed` per attention email, with optional note and `snoozed_until` |
| `sender_rules` | Exact normalized sender rules learned from corrections |
| `model_calls` | Token, cache, cost, latency, and failure data for each model attempt |

`corrections`, `attention_actions`, `sender_rules`, and `model_calls` are auto-created at runtime.
`triage_runs` and
`classifications` are not — a fresh database needs `db/schema.sql` first.

The attention queue query takes the latest classification per `email_id`
(`DISTINCT ON ... ORDER BY classified_at DESC`), then excludes anything with an
`attention_actions` row unless it is a snooze whose `snoozed_until` has passed.

## Code conventions

### TypeScript

- **Strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — hence
  the `!` and `?? null` noise around indexed access; keep it rather than loosening tsconfig
- **ES modules** — `"type": "module"`, `verbatimModuleSyntax`
- **Import extensions** — always `.js` in imports (e.g. `from "./jmap.js"`)
- **Type-only imports** — `import type { ... }`
- Target ES2022, module nodenext

### Style

- Async/await throughout, no raw Promise chains
- Explicit type annotations on exported functions
- Destructuring for imports and object access
- `try/catch` with contextual error messages
- Functional patterns (map/filter/reduce) where they read better
- No linter or formatter configured — match the surrounding code
- Console logging for progress (batch counts, tier summaries)

### Error handling

- Classification failures fall back to `confirm` and **skip actions entirely** — a bad
  batch can never delete mail
- JMAP requests retry 3× with linear backoff (2s, 4s, 6s) on `ETIMEDOUT` only; other
  errors fail fast
- Classification inserts use `ON CONFLICT DO NOTHING` for idempotency
- Watch mode: SIGINT finishes the current batch; a second SIGINT force-exits
- `src/index.ts` calls `process.exit(0)` explicitly — the pg pool otherwise keeps the
  event loop alive and the launchd job never ends

## Testing

Vitest tests across `jmap.test.ts`, `db.test.ts`, `routing.test.ts`, and `classifier.test.ts`. They
mock `fetch` and the pg pool — **no network, no database, no API keys required**, so
`npm test` is safe to run anywhere and should be run before every commit.

Not covered: `server.ts`, `act.ts`, `correct.ts`, `cleanup.ts`, and the end-to-end loop in
`index.ts`. Changes there need manual verification — `npm run triage -- --dry-run` for
triage, and the running server for UI work.

## Key technical details

- **Batch size**: 50 emails per JMAP fetch, 500ms pause between batches
- **Models**: `openai/gpt-5.6-luna` primary, `anthropic/claude-haiku-4.5` one-time backup
- **Max tokens**: dynamic by model batch size, capped at 2500
- **Correction feedback**: corrections recorded via `act`, `correct`, or the web UI upsert
  an exact normalized sender rule. Future mail from that sender bypasses the model
- **Deterministic routing**: explicit sender rules win; otherwise List-Unsubscribe mail
  auto-archives without a model call
- **Failure behavior**: both model failures abort the run without writing classifications;
  mail remains unread and the failed heartbeat is sent
- **Web UI**: Hono on port 3100, dark mobile UI, Attention tab default, Review lazy-loaded.
  **No authentication** — it is meant to sit behind Cloudflare Access, not be exposed
- **DB connection**: SSL with `rejectUnauthorized: false`, pool `max: 3` (keeps the hourly
  launchd job from exhausting connections on the managed instance)
- **Scheduled services**: launchd plists for server, hourly triage, and Cloudflare Tunnel.
  They hardcode absolute paths for one machine — see the README before loading them
  elsewhere. The absolute node path exists because launchd doesn't load asdf shims

## Gotchas

- Editing `src/server.ts` while the launchd server job is running does nothing until
  `npm run restart`
- `launchctl list | grep email-triage` — the middle column is the last exit code, not a
  health check. `0` is good; anything else means look at the log
- `npm run act` and `npm run correct` need a TTY. `act` has a plain-list fallback for
  non-TTY, `correct` does not
- Fastmail API tokens are scoped per account and are not transferable between accounts
- Don't confuse `corrections` (the classifier's training signal) with `attention_actions`
  (queue bookkeeping). Reclassifying in `act` writes both
