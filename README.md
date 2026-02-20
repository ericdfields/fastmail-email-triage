# Fastmail Email Triage

Classifies unread Fastmail inbox emails into four tiers using Claude, then acts on them automatically via JMAP.

## Tiers

| Tier | Action |
|------|--------|
| `auto-delete` | Move to Trash |
| `auto-archive` | Move to Archive, mark as read |
| `confirm` | Mark as read, keep in Inbox |
| `attention` | No action (keep unread in Inbox) |

## Setup

### Environment variables

Managed via [Doppler](https://doppler.com):

- `FASTMAIL_API_TOKEN` — Fastmail API token with mail read/write access
- `ANTHROPIC_API_KEY` — Anthropic API key for classification
- `DATABASE_URL` — PostgreSQL connection string

### Database

PostgreSQL with two tables:

```sql
CREATE TYPE tier AS ENUM ('auto-delete', 'auto-archive', 'confirm', 'attention');

CREATE TABLE triage_runs (
  run_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  total_processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE classifications (
  email_id             TEXT NOT NULL,
  run_id               BIGINT NOT NULL REFERENCES triage_runs(run_id),
  subject              TEXT NOT NULL,
  sender               TEXT NOT NULL,
  received_at          TIMESTAMPTZ NOT NULL,
  tier                 TIER NOT NULL,
  reason               TEXT NOT NULL,
  has_list_unsubscribe BOOLEAN NOT NULL DEFAULT false,
  classified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at             TIMESTAMPTZ,
  PRIMARY KEY (email_id, run_id)
);
```

### Install

```
npm install
```

## Usage

### Triage

Classify and act on all unread inbox emails:

```
npm run triage
```

This will:
1. Check for an incomplete run to resume (retries any classified-but-unacted emails first)
2. Fetch unread emails from Fastmail in batches of 50
3. Classify each batch with Claude
4. Apply tier actions via JMAP
5. Print a summary

If classification fails for a batch, those emails get a fallback `confirm` tier with no action applied.

### Replay

Apply actions to previously classified emails that were never acted on (e.g., from runs before action mode existed):

```
npm run replay
```

### Import

Import classifications from a JSONL file:

```
doppler run -- tsx src/import-jsonl.ts <path-to-jsonl>
```

## Project structure

```
src/
  index.ts       — Entry point, orchestrates triage/replay flow
  jmap.ts        — Fastmail JMAP client (session, mailbox queries, email fetching, actions)
  classifier.ts  — Claude-based email classification
  db.ts          — PostgreSQL persistence (runs, classifications, action tracking)
  types.ts       — Shared TypeScript interfaces
  import-jsonl.ts — One-off JSONL import utility
```

## Resumability

Runs are resumable. If the process crashes mid-run:
- The incomplete run is detected on next start
- Already-classified emails are skipped
- Classified-but-unacted emails get their actions retried
- New batches continue from where they left off
