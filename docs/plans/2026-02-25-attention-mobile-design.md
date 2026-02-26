# Attention Queue in Mobile Web UI

**Date:** 2026-02-25

## Problem

The attention queue (npm run act) is only accessible via terminal TUI. Need to process attention emails from mobile.

## Solution

Add a second tab to the existing mobile web UI for the attention queue.

## UI Design

**Tab bar** at the top: "Review" and "Attention (N)" where N is the queue count badge.

**Attention tab cards:**
- Same dark card style as Review tab
- Each card: sender (bold), subject, timestamp, reason (muted), body preview (truncated, expandable on tap)
- Three action buttons always visible per card: Act, Snooze, Reclassify

**Actions:**
- **Act**: one tap archives immediately. Small note icon expands an input field if tapped.
- **Snooze**: tap reveals three options — Tomorrow, 3 days, 1 week
- **Reclassify**: tap reveals three tier pills — auto-delete, auto-archive, confirm

All actions use optimistic UI — card is removed from list immediately, reverted on failure. Queue count badge updates as items are processed. "Load more" at bottom for next batch.

## API Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/attention` | GET | Attention queue with body text. Params: `limit` (default 10) |
| `/api/attention/count` | GET | Returns `{ count }` for tab badge |
| `/api/attention/act` | POST | Archive + record action. Body: `{ emailId, runId, note? }` |
| `/api/attention/snooze` | POST | Record snooze. Body: `{ emailId, runId, days }` |
| `/api/attention/reclassify` | POST | Correction + tier action. Body: `{ emailId, runId, tier }` |

## File Changes

**Modified:** `src/server.ts` — add 5 API routes, update frontend HTML with tab UI and attention view
