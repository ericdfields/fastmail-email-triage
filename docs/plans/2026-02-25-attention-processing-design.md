# Attention Processing TUI — Design

## Overview

A new `npm run act` command lets the user work through `attention`-tier emails in focused batches. The goal is inbox zero: every attention email eventually gets acted on and archived.

## Command

```
npm run act              # default batch of 5
npm run act -- --batch 10
```

New file: `src/act.ts`. New script entry in `package.json`. Existing `correct.ts` and `accuracy.ts` are untouched.

## Email Selection

Query the DB for `attention`-tier emails where:
- No row in `attention_actions` → show (never processed)
- `action = 'snoozed'` and `snoozed_until <= now()` → show (snooze expired)
- `action = 'snoozed'` and `snoozed_until > now()` → hide
- `action = 'acted'` → hide (done)

Ordered by `received_at ASC` (oldest first, work through backlog). Fetch N emails (default 5) per batch. Before rendering, make one JMAP `Email/get` call for all emails in the batch to fetch bodies.

## Database Schema

New table, auto-created on first run:

```sql
CREATE TABLE attention_actions (
  action_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id      TEXT NOT NULL,
  run_id        BIGINT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('acted', 'snoozed')),
  note          TEXT,
  snoozed_until TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id)
);
```

Notes are nullable — stored on `acted` rows for future introspection (e.g. query patterns over time).

## TUI Layout

```
 Attention Queue   3 of 47 remaining   Batch 1 of 5
─────────────────────────────────────────────────────
▸ attention  eric@example.com          Feb 20
  Invoice #1234 due Friday
  attention  noreply@bank.com          Feb 18
  Your statement is ready
  ...
─────────────────────────────────────────────────────
Body:   Hi Eric, please find your invoice attached...
Reason: Sender is a known vendor, financial action needed
─────────────────────────────────────────────────────
↑/↓ Navigate   a Act   s Snooze   q Quit
```

## Keybindings

| Key | Action |
|-----|--------|
| `j` / `↓` | Navigate down |
| `k` / `↑` | Navigate up |
| `a` | Open inline note prompt → confirm → archive via JMAP → remove from list |
| `s` | Show snooze submenu: `1` Tomorrow  `2` Three days  `3` One week |
| `q` | Quit (unprocessed emails stay for next session) |

**Act flow:** Inline prompt at bottom: `Note (optional, enter to skip):` — type or press enter → records `acted` row with optional note → archives email via JMAP (move to archive + mark read) → removes from list.

**Snooze flow:** Help bar changes to `1 Tomorrow  2 Three days  3 One week` → pick → records `snoozed` row with `snoozed_until` → removes from list.

**Batch complete message:** `Batch complete. 42 attention emails remain. Press any key to load next batch or q to quit.`

## Body Fetching

One JMAP `Email/get` call per batch, requesting `textBody`, `htmlBody`, `bodyValues`.

Display preference:
1. `textBody` — trim to ~500 chars
2. `htmlBody` — strip tags, trim to ~500 chars
3. Fallback: `(no body preview)`

Bodies held in memory for the batch duration — no per-keypress JMAP calls.

## Archive Action

Reuses existing JMAP `Email/set` pattern from `jmap.ts` — move to archive mailbox + mark read (same as `auto-archive` tier).

## Future Introspection

The `attention_actions` table with notes enables queries like:
- All acted emails with notes in the last 30 days
- Most common action patterns by sender
- Average time between classification and action
