# Reclassify in Act TUI — Design

## Overview

Add `r` key to the `npm run act` TUI to reclassify an attention email into a different tier, immediately applying the correct JMAP action and recording the correction for classifier training.

## Trigger & Submenu

`r` in list mode opens a reclassify submenu in the status line:

```
Reclassify: 1 auto-delete  2 auto-archive  3 confirm  esc Cancel
```

## Actions on Selection

Three steps in sequence:
1. `insertCorrection(emailId, newTier)` — records in `corrections` table for training
2. `applyTierAction(session, mailboxIds, emailId, tier)` — applies JMAP action for the tier
3. `recordAttentionAction(emailId, runId, "acted")` — hides from attention queue permanently

## Tier Actions

| Tier | JMAP Action |
|------|-------------|
| `auto-delete` | Move to Trash |
| `auto-archive` | Move to Archive + mark read |
| `confirm` | Mark read, keep in Inbox |

## Changes Required

### `src/jmap.ts`
New export:
```typescript
export async function applyTierAction(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  emailId: string,
  tier: "auto-delete" | "auto-archive" | "confirm"
): Promise<void>
```
Reuses the same JMAP update logic from `applyActions`.

### `src/act.ts`
- New `TUIMode` variant: `{ type: "reclassify" }`
- `r` key → enter reclassify mode
- `1/2/3` in reclassify mode → apply tier + record correction + advance
- `esc` → cancel back to list
- Import `insertCorrection` from `./db.js`
- Import `applyTierAction` from `./jmap.js`
- Help bar updated: adds `r Reclassify`

## No New DB Tables

`insertCorrection` and `recordAttentionAction` already exist. No schema changes needed.
