# Reclassify in Act TUI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `r` key to `npm run act` TUI so attention emails can be reclassified into a different tier, with the correct JMAP action applied immediately and the correction recorded for classifier training.

**Architecture:** Two files change. `src/jmap.ts` gains `applyTierAction` — a single-email version of the tier-action logic already in `applyActions`. `src/act.ts` gains a new `reclassify` TUI mode with `r` key entry, `1/2/3` tier selection, and esc cancel. Reclassifying calls `insertCorrection` + `applyTierAction` + `recordAttentionAction("acted")` in sequence.

**Tech Stack:** TypeScript (ES modules, tsx), Vitest, Fastmail JMAP, Node.js raw stdin

---

## Reference

Design doc: `docs/plans/2026-02-25-reclassify-in-act-design.md`

Key files:
- `src/jmap.ts` — add `applyTierAction` after `archiveEmail` (line ~338)
- `src/act.ts` — add reclassify mode throughout (TUIMode union, render, key handler)
- `src/jmap.test.ts` — add `applyTierAction` tests
- `src/db.ts` — no changes needed; `insertCorrection` already exists
- `src/types.ts` — no changes needed

Worktree: `.worktrees/reclassify-in-act/`
All edits in the worktree. Paths below are project-relative.

**Existing patterns to follow:**
- `archiveEmail` in `jmap.ts` shows the `jmapRequest` call pattern for `Email/set`
- Snooze mode in `act.ts` shows the full TUI mode pattern (enter on key, esc cancel, busy flag, try/catch/finally)
- `applyActions` in `jmap.ts` shows the per-tier JMAP update logic to replicate

---

## Task 1: `applyTierAction` in `src/jmap.ts` + tests

**Files:**
- Modify: `src/jmap.ts`
- Modify: `src/jmap.test.ts`

### Step 1: Write the failing tests first

In `src/jmap.test.ts`, add `applyTierAction` to the existing import:

```typescript
import { getSession, getMailboxIds, applyActions, fetchAllUnread, fetchEmailBodies, archiveEmail, applyTierAction } from "./jmap.js";
```

Then append these tests at the end of the file:

```typescript
// --- applyTierAction ---

describe("applyTierAction", () => {
  it("sends correct Email/set for auto-delete", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "auto-delete");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "mailboxIds/inbox-1": null,
      "mailboxIds/trash-1": true,
    });
  });

  it("sends correct Email/set for auto-archive", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "auto-archive");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "mailboxIds/inbox-1": null,
      "mailboxIds/archive-1": true,
      "keywords/$seen": true,
    });
  });

  it("sends correct Email/set for confirm", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "confirm");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][1].update["email-1"]).toEqual({
      "keywords/$seen": true,
    });
  });

  it("uses the correct JMAP method call ID 'tier0'", async () => {
    mockFetch.mockResolvedValue(
      makeJmapResponse([["Email/set", { updated: { "email-1": {} }, notUpdated: {} }, "tier0"]])
    );

    await applyTierAction(session, mailboxIds, "email-1", "confirm");

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, { body: string }])[1].body);
    expect(body.methodCalls[0][2]).toBe("tier0");
  });
});
```

### Step 2: Run tests to confirm they fail

```bash
cd /Users/ericbrookfield/dev/email-triage/.worktrees/reclassify-in-act
npm test 2>&1 | tail -15
```

Expected: 4 new failures — `applyTierAction is not a function` or similar

### Step 3: Implement `applyTierAction` in `src/jmap.ts`

Add this function at the end of `src/jmap.ts`, after `archiveEmail`:

```typescript
/** Apply the standard tier action to a single email. */
export async function applyTierAction(
  session: JMAPSession,
  mailboxIds: MailboxIds,
  emailId: string,
  tier: "auto-delete" | "auto-archive" | "confirm"
): Promise<void> {
  const update: Record<string, object> = {};

  switch (tier) {
    case "auto-delete":
      update[emailId] = {
        [`mailboxIds/${mailboxIds.inbox}`]: null,
        [`mailboxIds/${mailboxIds.trash}`]: true,
      };
      break;
    case "auto-archive":
      update[emailId] = {
        [`mailboxIds/${mailboxIds.inbox}`]: null,
        [`mailboxIds/${mailboxIds.archive}`]: true,
        "keywords/$seen": true,
      };
      break;
    case "confirm":
      update[emailId] = {
        "keywords/$seen": true,
      };
      break;
  }

  await jmapRequest(session, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [
      [
        "Email/set",
        {
          accountId: session.accountId,
          update,
        },
        "tier0",
      ],
    ],
  });
}
```

### Step 4: Run tests — must pass

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass including the 4 new ones

### Step 5: Commit

```bash
git add src/jmap.ts src/jmap.test.ts
git commit -m "feat: add applyTierAction to jmap client"
```

---

## Task 2: Reclassify mode in `src/act.ts`

**Files:**
- Modify: `src/act.ts`

This task has several small edits across the file. Make each change carefully, then verify compile.

### Step 1: Add imports

In the db import block (lines 1-8), add `insertCorrection`:

```typescript
import {
  initDb,
  closeDb,
  ensureAttentionActionsTable,
  getAttentionQueue,
  getAttentionQueueCount,
  recordAttentionAction,
  insertCorrection,
} from "./db.js";
```

In the jmap import block (lines 9-14), add `applyTierAction`:

```typescript
import {
  getSession,
  getMailboxIds,
  fetchEmailBodies,
  archiveEmail,
  applyTierAction,
} from "./jmap.js";
```

### Step 2: Add reclassify to the TUIMode union

Find the TUIMode union (around line 96):

```typescript
type TUIMode =
  | { type: "list" }
  | { type: "note"; note: string }
  | { type: "snooze" }
  | { type: "batch-complete"; remaining: number };
```

Add the new variant:

```typescript
type TUIMode =
  | { type: "list" }
  | { type: "note"; note: string }
  | { type: "snooze" }
  | { type: "reclassify" }
  | { type: "batch-complete"; remaining: number };
```

### Step 3: Add reclassify status line in `renderList`

Find the status/mode line block (around lines 196-204):

```typescript
    if (statusMsg) {
      s += `${ESC.bold}  ${statusMsg}${ESC.reset}\n`;
    } else if (mode.type === "note") {
      s += `${ESC.bold}  Note (enter to skip, ctrl+c to cancel): ${mode.note}\u2588${ESC.reset}\n`;
    } else if (mode.type === "snooze") {
      s += `${ESC.bold}  Snooze: ${ESC.reset}${ESC.cyan}1${ESC.reset} Tomorrow  ${ESC.cyan}2${ESC.reset} Three days  ${ESC.cyan}3${ESC.reset} One week  ${ESC.dim}esc Cancel${ESC.reset}\n`;
    } else {
      s += "\n";
    }
```

Add the reclassify branch after snooze:

```typescript
    if (statusMsg) {
      s += `${ESC.bold}  ${statusMsg}${ESC.reset}\n`;
    } else if (mode.type === "note") {
      s += `${ESC.bold}  Note (enter to skip, ctrl+c to cancel): ${mode.note}\u2588${ESC.reset}\n`;
    } else if (mode.type === "snooze") {
      s += `${ESC.bold}  Snooze: ${ESC.reset}${ESC.cyan}1${ESC.reset} Tomorrow  ${ESC.cyan}2${ESC.reset} Three days  ${ESC.cyan}3${ESC.reset} One week  ${ESC.dim}esc Cancel${ESC.reset}\n`;
    } else if (mode.type === "reclassify") {
      s += `${ESC.bold}  Reclassify: ${ESC.reset}${ESC.red}1${ESC.reset} auto-delete  ${ESC.yellow}2${ESC.reset} auto-archive  ${ESC.cyan}3${ESC.reset} confirm  ${ESC.dim}esc Cancel${ESC.reset}\n`;
    } else {
      s += "\n";
    }
```

Note: `ESC.red` was removed in the last feature but is needed here. Add it back to the ESC object:

```typescript
const ESC = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
```

### Step 4: Update the help bar

Find the help bar block (around lines 206-213):

```typescript
    if (mode.type === "list") {
      s += `${ESC.dim}\u2191/\u2193${ESC.reset} Navigate  `;
      s += `${ESC.green}a${ESC.reset}${ESC.dim} Act${ESC.reset}  `;
      s += `${ESC.yellow}s${ESC.reset}${ESC.dim} Snooze${ESC.reset}  `;
      s += `${ESC.dim}q${ESC.reset} Quit`;
    }
```

Add `r Reclassify` between Snooze and Quit:

```typescript
    if (mode.type === "list") {
      s += `${ESC.dim}\u2191/\u2193${ESC.reset} Navigate  `;
      s += `${ESC.green}a${ESC.reset}${ESC.dim} Act${ESC.reset}  `;
      s += `${ESC.yellow}s${ESC.reset}${ESC.dim} Snooze${ESC.reset}  `;
      s += `${ESC.red}r${ESC.reset}${ESC.dim} Reclassify${ESC.reset}  `;
      s += `${ESC.dim}q${ESC.reset} Quit`;
    }
```

### Step 5: Update Ctrl+C to cancel reclassify mode

Find the Ctrl+C handler (around lines 302-312):

```typescript
    // Ctrl+C
    if (key === "\x03") {
      if (mode.type === "note") {
        mode = { type: "list" };
        render();
        return;
      }
      cleanup();
      await closeDb();
      process.exit(0);
    }
```

Add `reclassify` to the cancel-to-list condition:

```typescript
    // Ctrl+C
    if (key === "\x03") {
      if (mode.type === "note" || mode.type === "reclassify") {
        mode = { type: "list" };
        render();
        return;
      }
      cleanup();
      await closeDb();
      process.exit(0);
    }
```

### Step 6: Add the reclassify mode key handler

Find the `// --- Snooze mode ---` block. After the snooze block ends (around line 350, before `// --- Note capture mode ---`), insert:

```typescript
    // --- Reclassify mode ---
    if (mode.type === "reclassify") {
      if (key === "\x1b") {
        mode = { type: "list" };
        render();
        return;
      }
      if (key === "1" || key === "2" || key === "3") {
        const tier =
          key === "1" ? "auto-delete" : key === "2" ? "auto-archive" : "confirm";
        const row = queue[idx]!;
        busy = true;
        try {
          await insertCorrection(row.emailId, tier);
          await applyTierAction(session, mailboxIds, row.emailId, tier);
          await recordAttentionAction(row.emailId, row.runId, "acted");
          showStatus(`Reclassified \u2192 ${tier}`);
          removeCurrentAndAdvance();
        } catch (err) {
          showStatus(`Error: ${err}`);
          mode = { type: "list" };
        } finally {
          busy = false;
        }
        return;
      }
      return;
    }
```

### Step 7: Add `r` key handler in list mode

Find the `s` key handler at the bottom of the input handler (around lines 401-404):

```typescript
    if (key === "s") {
      mode = { type: "snooze" };
      render();
      return;
    }
```

Add `r` handler immediately after:

```typescript
    if (key === "r") {
      mode = { type: "reclassify" };
      render();
      return;
    }
```

### Step 8: Verify TypeScript compiles

```bash
cd /Users/ericbrookfield/dev/email-triage/.worktrees/reclassify-in-act
npx tsc --noEmit
```

Expected: no errors

### Step 9: Run all tests

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass (no new tests for the TUI — it's interactive stdin/stdout)

### Step 10: Commit

```bash
git add src/act.ts
git commit -m "feat: add reclassify mode to act TUI"
```

---

## Task 3: Commit docs and finish

### Step 1: Commit design and plan docs

```bash
git add docs/plans/2026-02-25-reclassify-in-act-design.md docs/plans/2026-02-25-reclassify-in-act-plan.md
git commit -m "docs: add reclassify-in-act design and plan"
```

### Step 2: Verify final state

```bash
git log --oneline -5
git status
```

Expected: clean working tree, 3 new commits on `feature/reclassify-in-act`
