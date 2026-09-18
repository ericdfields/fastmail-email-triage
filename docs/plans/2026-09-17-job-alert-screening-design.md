# Job-alert screening: design

September 17, 2026.

## Goal

Turn LinkedIn and Indeed job-alert email into a short list of roles worth pursuing. For
each role the candidate confirms, find a named person to contact and draft a note.

## Decisions

- **A side pipeline, not a new tier.** Triage keeps archiving alert emails through the
  List-Unsubscribe route. The job pipeline finds alerts by exact sender in any mailbox,
  so it does not change triage behavior. Its failures are logged and never fail a run.
- **One model call per alert.** The triage model lists and screens every job in one alert.
  Repeats are merged after the call by normalized company and title. This keeps one call
  per alert, at the cost of re-reading repeated listings.
- **The model judges; code enforces.** Hard profile rules (title lane, avoided companies,
  base-pay floor) run in code after the model, and they only move a job toward nay.
  Missing pay never causes a nay. A warm path (a LinkedIn connection at the company) is the
  only lift, from maybe to yay.
- **Nays are hidden, not discarded.** Each keeps its reason, whether a rule or the model
  decided it, and the profile version. `npm run jobs -- nays` and the Hidden nays filter
  let the candidate un-nay with one action.
- **Decisions train the screen.** Recent decisions that overrule the screen go into the
  scoring prompt. Profiles are versioned, and every job records its version, so
  `npm run jobs -- stats` stays meaningful after edits.
- **Research runs only on a confirmed yay**, in this order:
  1. Check whether the posting is open. Stop if it is closed.
  2. Research the company. The result is cached for 30 days, because alerts show many
     roles at one employer.
  3. Draft a note only when a named contact exists.
- **Separate budget.** Job calls record `model_calls.purpose = 'jobs'` and use
  `JOB_DAILY_BUDGET_USD`, so job work cannot stop triage. A spent budget returns
  research to the queue instead of failing it.

## Safety

- **The profile is private.** It lives in the database, never in the repo.
- **Tracking links are dropped.** Alert text reaches the model with job links replaced by
  `[J#]` references to canonical job URLs. All other links are removed. The app stores
  no URL the model wrote.
- **Web search runs through OpenRouter's web plugin, not LinkedIn.** A named person is
  kept only when the plugin's citations include that person's source URL.
- **Posting and web text are untrusted.** Postings have carried hidden instructions for AI
  tools. The drafting call receives structured research only, never raw posting or web
  text. Research calls report suspicious source text, and the app shows those reports.
  Drafts are checked against the voice rules and for injected instructions. The app flags
  problems and does not rewrite the draft.
- **The web UI escapes all model and web text.** Links render only for http(s) URLs.

## Not done

- **No rescoring after a profile edit.** Existing jobs keep the verdict from the version
  that screened them.
- **Alert sender addresses are defaults.** Confirm them against real mail. Override them
  with `jobAlertSenders` in the profile rules.
- **No automatic outreach.** The app sends nothing. Drafts are for the candidate to edit
  and send.
