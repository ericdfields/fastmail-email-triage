# CLAUDE.md

## Project Overview

Fastmail Email Triage is an automated email classification system that uses Claude AI to triage unread emails from a Fastmail inbox via the JMAP protocol. It classifies emails into four tiers and applies corresponding actions automatically, with full run tracking and resumability via PostgreSQL.

## Architecture

```
src/
  index.ts      — Entry point, CLI flags, orchestration loop
  jmap.ts       — Fastmail JMAP API client (session, queries, batch fetching, actions)
  classifier.ts — Claude-based email classification with detailed system prompt
  db.ts         — PostgreSQL persistence (runs, classifications, corrections, action tracking)
  types.ts      — Shared TypeScript interfaces (EmailSummary, Tier, Classification, etc.)
  correct.ts    — CLI for reviewing classifications and recording corrections
  accuracy.ts   — CLI for viewing classification accuracy stats
```

### Data Flow

1. Connect to Fastmail JMAP, get mailbox IDs (inbox, archive, trash)
2. Check for incomplete runs to resume (retry pending actions)
3. Fetch unread emails in batches of 50 via async generator
4. Classify each batch with Claude (sonnet default, haiku via `--haiku`)
5. Persist classifications to PostgreSQL
6. Apply tier-based actions via JMAP `Email/set`
7. Print summary stats

### Tier System

| Tier | Action | Use Case |
|------|--------|----------|
| `auto-delete` | Move to Trash | Spam, phishing, marketing |
| `auto-archive` | Move to Archive + mark read | Newsletters, notifications, receipts |
| `confirm` | Mark as read, keep in Inbox | Ambiguous messages needing human review |
| `attention` | No action (keep unread) | Real people, bills, medical, orders |

## Running the Project

```bash
# Install dependencies
npm install

# Run triage (uses Doppler for env vars)
npm run triage

# Use cheaper/faster model
npm run triage -- --haiku

# Continuous polling mode (60s interval)
npm run triage -- --watch

# Dry run — classify but don't apply any actions
npm run triage -- --dry-run

# Review classifications (interactive TUI — j/k navigate, 1-4 set tier, q quit)
npm run correct

# Record a correction directly
npm run correct -- <email_id> <corrected_tier>

# View classification accuracy stats
npm run accuracy
```

The project uses `tsx` to run TypeScript directly — there is no build step for development.

## Environment Variables

Managed via [Doppler](https://doppler.com). The `npm run triage` script wraps execution with `doppler run --`:

- `FASTMAIL_API_TOKEN` — Fastmail API token with mail read/write access
- `ANTHROPIC_API_KEY` — Anthropic API key for Claude classification
- `DATABASE_URL` — PostgreSQL connection string (`postgresql://user:password@host:port/db`)

## Database Schema

PostgreSQL with a custom `tier` ENUM type and two tables:

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

CREATE TABLE corrections (
  correction_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id             TEXT NOT NULL,
  run_id               BIGINT NOT NULL,
  original_tier        TIER NOT NULL,
  corrected_tier       TIER NOT NULL,
  corrected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, run_id) REFERENCES classifications(email_id, run_id),
  UNIQUE (email_id, run_id)
);
```

Note: The `corrections` table is auto-created on first use by `npm run correct` or `npm run accuracy`.

## Code Conventions

### TypeScript

- **Strict mode** enabled with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **ES modules** — `"type": "module"` in package.json, `verbatimModuleSyntax` in tsconfig
- **Import extensions** — Always use `.js` extensions in imports (e.g., `from "./jmap.js"`)
- **Type-only imports** — Use `import type { ... }` for type-only imports
- Target: ES2022, Module: nodenext

### Style

- Async/await throughout, no raw Promise chains
- Explicit type annotations on exported functions
- Destructuring for imports and object access
- `try/catch` error handling with contextual error messages
- Functional patterns (map/filter/reduce) over imperative loops where appropriate
- No linter or formatter configured — follow existing code style
- Console logging for progress tracking (batch counts, tier summaries)

### Error Handling Patterns

- Classification failures fall back to `confirm` tier (safe default, no auto-actions applied)
- JMAP requests retry up to 3 times with linear backoff (2s, 4s, 6s) on `ETIMEDOUT`
- Database inserts use `ON CONFLICT DO NOTHING` for idempotent classification storage
- Watch mode supports graceful shutdown via SIGINT (finishes current batch)

## Key Technical Details

- **Batch size**: 50 emails per JMAP fetch, 500ms rate-limiting pause between batches
- **Resumability**: Incomplete runs are detected and resumed — classified-but-unacted emails get retried
- **Models**: `claude-sonnet-4-6` (default) or `claude-haiku-4-5-20251001` (via `--haiku` flag)
- **Max tokens**: 4096 per classification request
- **Dry run**: `--dry-run` flag classifies and persists to DB but skips all JMAP actions
- **Watch mode**: 60-second polling interval, double SIGINT to force exit
- **Corrections**: Record classification corrections via `npm run correct`, view accuracy via `npm run accuracy`
- **DB connection**: SSL enabled with `rejectUnauthorized: false`

## Dependencies

**Runtime**: `@anthropic-ai/sdk`, `pg`, `tsx`, `typescript`
**Dev**: `@types/node`, `@types/pg`

## Testing

No test framework is configured. The `test` script is a placeholder.
