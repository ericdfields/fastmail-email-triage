# Triage review and inbox burndown: design

October 28, 2026. Draft for review.

## Problem

Triage archived mail the owner needed. In one week the owner flagged 15 archived emails
they wished they had seen. They fall into four groups:

| Group | Count | Kind of mail | What went wrong |
|-------|-------|--------------|-----------------|
| Missed must-see | 1 | A calendar invite from a real person, with an `.ics` file | Archived. The owner almost missed the event |
| Deadline inside a notice | 4 | Fee change with a start date; usage-limit alert; card delivery; a dated local event | Each needs one small act by a date. Archive hides the date |
| Useful to read | 8 | Newsletters, a venue calendar, a firmware beta note, a weekly service report | No act needed, but the content has value |
| Context | 2 | A social-network connection notice; an order-packed notice | Low value alone. Useful next to related mail |

The inbox has a second problem. It holds about 3,900 emails, about 400 unread. Mail stays
there because the owner meant to do something with it. Nothing makes the owner decide.

## Goals

1. Never archive a calendar invite or other must-see mail.
2. Pull dates and acts out of archived mail, so archive stops hiding them.
3. Compress read-worthy mail into one short daily brief.
4. Question each sender over time: keep, digest, unsubscribe, or delete.
5. Shrink the inbox with a daily, bounded set of decisions.

## Decisions

### 1. Guard rules run before every other route

Triage adds a guard step ahead of sender rules and the List-Unsubscribe route. A guard
can only raise a tier to `attention`. It never lowers one.

- **Shipped:** a `text/calendar` part or an `.ics` file anywhere in the message →
  `attention`. `fetchAllUnread` now asks JMAP for `bodyStructure`, limited to part
  `type`, `name`, and `subParts`. The missed invite would have reached `attention`.
- **Later:** a thread the owner has replied to → `attention`. This needs a `Thread/get`
  lookup per batch.
- **Later:** a sender in Fastmail contacts never takes the List-Unsubscribe route. This
  needs the contacts capability on the API token.

### 2. A flag on archived mail is a signal

The owner already flags mail they wish they had seen. The review job reads flagged mail
in Archive each run and records it in a new `review_signals` table. It does not move the
mail. A signal feeds the sender verdicts (decision 4) and the classifier prompt examples.
A flag is not a correction by default, because most flagged mail was "useful", not
"needs action".

### 3. A review job reads what triage archived

A new `npm run review` job runs once a day after the 6 a.m. triage run (launchd). It reads
every email archived in the last 24 hours, plus all flagged archived mail. It reads body
text, not only the 256-character preview. For each email the model returns one of:

- **act** — a dated act exists. Store the act, the due date, and the email ID in
  `review_items`. Due acts appear in the Attention tab until done.
- **brief** — content worth reading. Store a one- to three-line summary.
- **none** — nothing to keep.

Email text is untrusted. The review model gets text with links removed, the same way the
job pipeline does it. The app stores no URL the model wrote. Links in the brief point to
the email in Fastmail, built from the email ID.

Spend records `model_calls.purpose = 'review'` with its own `REVIEW_DAILY_BUDGET_USD`
(default $1.00). A spent budget stops the job; it never touches triage.

### 4. Sender verdicts question whether mail should arrive at all

Once a week the review job scores each sender with 4+ emails in 30 days. Inputs: count,
read rate, flags, brief/act results, and existing unsubscribe data. It proposes one verdict:

- **keep** — no change.
- **digest** — archive, and always include it in the brief.
- **unsubscribe** — feed the existing Unsub tab (it already handles the safe POST).
- **delete** — add an `auto-delete` sender rule.

Verdicts are proposals. The owner approves them in the web UI. Approval writes a
`sender_rules` row or an unsubscribe decision through the existing code paths.

### 5. Inbox burndown is a forcing function

A new Inbox tab in the web UI (and the MCP tools) shows a fixed daily set: the 10 oldest inbox emails not
yet decided, plus anything an act made due. For each one the model proposes one choice,
with one line of reason:

- **archive** — done or stale.
- **delete** — junk.
- **act** — create a dated item (decision 3) and archive the email.
- **keep** — stays, with a required "until" date. A kept email returns on that date.

The owner taps to accept or change each one. The set does not grow during the day. The
tab header shows inbox count and a 30-day trend. At 10 a day the current inbox takes
about 13 months; a "do 10 more" button lets the owner go faster.

Burndown decisions go to `inbox_decisions`. Accepted choices apply through JMAP the same
way `attention_actions` work today.

### 6. The brief is an MCP server

The owner's agent reads the brief. The app does not push it. A new MCP server
(`npm run mcp`, stdio, with an HTTP option behind Cloudflare Access) exposes:

- `get_brief` — acts due in 7 days, new acts, read-worthy summaries grouped by sender,
  and the burndown count.
- `list_acts`, `complete_act` — dated acts from decision 3.
- `list_sender_verdicts`, `decide_sender_verdict` — decision 4 proposals.
- `get_burndown`, `decide_inbox_email` — decision 5.
- `flag_missed` — record a "wish I had seen this" signal by email ID.

Tool results carry email text the review model produced from untrusted mail. Tool
descriptions say so, and results mark that text as data. Tools that change mail
(`decide_inbox_email`) apply the same JMAP actions as the web UI and accept only the
four burndown choices. No tool deletes mail outside the burndown.

## Safety

- No new path can delete mail without owner approval. Guards only raise tiers.
- The review job reads mail and writes the database. It changes nothing in Fastmail.
- The burndown applies JMAP actions only after an owner tap.
- `--dry-run` on `npm run review` makes model calls and prints results. It saves nothing.
- All model text is escaped in the web UI.

## Build order

1. Guard rules and the JMAP property change. Small, tested, fixes the worst miss.
2. Flag signals and the review job (act / brief / none).
3. MCP server with `get_brief` and the act tools.
4. Inbox burndown (web tab and MCP tools), 10 emails a day.
5. Weekly sender verdicts.

## Open questions

- Should the Brief also get a web tab, or is the MCP server enough?
- Should a flag on archived mail from an exact sender auto-create a `digest` rule, or
  wait for the weekly verdict?
