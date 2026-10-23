# PRD: Pulse, a Claude API Agent in Slack

**Owner:** Jorge Bocobo
**Status:** Draft v4
**Purpose:** A portfolio project that shows real Claude API skills to employers hiring AI automation developers: tool use, an agent loop, Slack integration, a database, human approval before risky actions, duplicate and failure handling, cost control and documentation.

---

## 1. Overview

Pulse is a Slack bot for a (fictional) performance marketing team. Team members ask it questions in plain English, such as "How did Summer Sale do this week?" Claude decides which tools to call, reads campaign data from a SQLite database, and replies in the Slack thread.

For risky actions, such as pausing or resuming a campaign, the bot never acts on its own. It posts an approval request with **Approve** and **Cancel** buttons, and only runs the action after an allowed person approves. Every action is written to an audit log.

All data is fake. The project never connects to a real ad account.

## 2. Goals

1. Answer campaign performance questions accurately using tool calls, not guesses.
2. Require human approval before any action that changes data.
3. Handle duplicates and failures safely: Slack event retries, double-clicked buttons, tool errors and Claude API errors.
4. Keep costs predictable with a cheap model, token limits and a daily budget guard.
5. Be easy for someone else to set up and run, with clear documentation.

## 3. Non-goals

- Connecting to real Meta Ads, RedTrack or any live ad platform.
- A web dashboard (Slack is the only interface).
- Multi-workspace distribution or the Slack App Directory.
- Long-term memory across threads.
- Private channels.

## 4. Release scope

Pulse ships in two tiers. **v1** is the portfolio piece: it is what gets demoed, linked in applications and discussed in interviews. **v1.1** is optional polish, built only after v1 is shipped. Each v1.1 item is listed in the README's "Known limitations" section, which shows the gap is known even before it's built.

| Area | v1 (ship first) | v1.1 (later, optional) |
|---|---|---|
| Conversations | Mentions, thread replies, DMs, history with safe trimming | One turn at a time per conversation (queue) |
| Tools | All 6 tools, zod validation, null ratios, list of names on no match | — |
| Approvals | Buttons, approver list, idempotent approve, expiry on click, audit log for approve/cancel/expire | Block self-approval, block duplicate pending requests, expiry sweep that removes stale buttons |
| Duplicates and failures | Per-message dedupe, `ack()` first, SDK retries, refusals, loop limit | Delete old `processed_events` rows |
| Cost | Haiku 5.5 at low effort, 1,024-token cap, daily budget guard, Console spend limit | — |
| Data | Deterministic generator, `npm run seed` refreshes metrics up to today | Automatic refresh on startup when the data doesn't end today |
| Quality | ~12 automated tests, 10 eval cases, CI | More tests for the v1.1 features, eval set grown to 20 cases |
| Docs | README with demo video, Known limitations, SOP | — |

In the requirements below, anything not marked **v1.1** is in v1.

## 5. Users and use cases

| User | Wants to | Example |
|---|---|---|
| Media buyer | Check performance quickly | "What's the CPL for Summer Sale over the last 7 days?" |
| Media buyer | Compare campaigns | "Which campaign has the best ROAS this week?" |
| Media buyer | Request an action | "Pause Black Friday Leads, the CPL is too high." |
| Team lead (approver) | Approve or reject actions | Clicks Approve on the bot's request |
| Anyone | See what happened | "What actions were taken today?" |

## 6. Functional requirements

### 6.1 Conversations
- **FR-1:** The bot responds when mentioned in a channel (`@Pulse ...`), to replies in channel threads it is already part of (no re-mention needed), and to direct messages. It ignores its own messages, messages from other bots (`bot_id` set) and message subtypes such as edits and deletions. Pulse works in public channels only, and has to be invited to a channel (`/invite @Pulse`) before it can answer there.
- **FR-2:** In channels, the bot always replies in a thread under the original message. In DMs, it replies directly in the conversation.
- **FR-3:** Follow-up messages keep context. In channels, history is keyed by `channel_id:thread_ts`. In DMs, it is keyed by `channel_id`, because users rarely reply inside threads in a DM. A channel thread counts as one the bot is "part of" when a `conversations` row exists for it. History is capped at the last 20 messages and is trimmed only at the start of a user turn, never between a `tool_use` and its `tool_result`, so the first stored message is always a plain user message (otherwise the API rejects the request).
  - **v1.1:** Turns in the same conversation run one at a time, using an in-memory queue per conversation key, so two quick messages never overwrite each other's history. In v1, this is listed as a known limitation.
- **FR-4:** While working, the bot adds an emoji reaction (for example 👀) to the user's message, and removes it when done, including when an error occurs.

### 6.2 Tools available to Claude

Read-only tools (run immediately):

| Tool | Input | Returns |
|---|---|---|
| `list_campaigns` | optional `status` (active / paused) | id, name, status, daily budget |
| `get_campaign_stats` | `campaign_name`, `days` (1 to 90) | spend, impressions, clicks, leads, CTR, CPL, revenue, ROAS for the period |
| `compare_campaigns` | `metric` (cpl, roas, ctr, spend), `days` | campaigns ranked by that metric |
| `get_action_log` | optional `days` (default 1), optional `status` (pending / approved / cancelled / expired) | approval requests with action, campaign, requester, decider, status and times, plus the audit log entry for each one that ran. Answers both "what actions were taken today?" and "did my pause go through?" |

Action tools (require approval, see 6.3):

| Tool | Input | Effect after approval |
|---|---|---|
| `request_pause_campaign` | `campaign_name`, `reason` | sets status to `paused` |
| `request_resume_campaign` | `campaign_name`, `reason` | sets status to `active` |

- **FR-5:** Every tool input is validated (with zod) before running. Invalid input returns a clear error to Claude as a tool result marked `is_error`, so Claude can correct itself or explain the problem.
- **FR-6:** Campaign names are matched case-insensitively: exact match first, then substring. If nothing matches, the tool returns an `is_error` result listing all campaign names (there are only five), so Claude can ask the user which one they meant.
- **FR-6a (date ranges):** `days = N` means the N days ending today (UTC), including today. "This week" means the last 7 days.
- **FR-6b (empty ratios):** A ratio with a zero denominator (CPL with 0 leads, ROAS with 0 spend, CTR with 0 impressions) is returned as `null`, never 0 or infinity, and Claude says "n/a".
- **FR-6c (no-op actions):** Action tools return an `is_error` result, and create no approval, if the campaign is already in the target state (for example, pausing a campaign that's already paused).
  - **v1.1:** They also refuse when a pending approval already exists for the same campaign and action, and point to the existing request. In v1, a duplicate request is still safe: whichever approval runs second finds the campaign already changed (FR-10) and does nothing.

### 6.3 Approval flow
- **FR-7:** Action tools never change data directly. They create a row in `approvals` with status `pending` and return "approval requested" to Claude. `requested_by`, `channel_id` and `thread_ts` come from the Slack event, never from Claude's tool input, so a prompt can't fake who asked.
- **FR-8:** The bot posts an approval message in the thread showing the action, campaign, reason, requester, and **Approve** / **Cancel** buttons (Slack Block Kit). User-supplied text (such as the reason) is escaped so it can't inject Slack formatting or mentions.
- **FR-9:** Only users listed in `APPROVER_USER_IDS` can approve. Anyone else who clicks gets a private (ephemeral) message saying they're not allowed. The requester or any approver can Cancel. In v1, an approver can approve their own request.
  - **v1.1:** Self-approval is blocked. The requester can't approve their own request, even if they're an approver, and gets an ephemeral "Another team lead needs to approve this."
- **FR-10:** On Approve, one database transaction does all of the following: claims the approval (FR-14), re-checks that the campaign isn't already in the target state, changes the status, and writes an audit log entry. The message then updates to "✅ Approved by <@USER_ID>, campaign paused." If the campaign was already changed in the meantime, the approval is marked `cancelled` and the message says "ℹ️ Black Friday Leads is already paused. Nothing changed."
- **FR-11:** On Cancel, the approval is marked `cancelled`, an audit log entry is written, and the message updates to "❌ Cancelled by <@USER_ID>."
- **FR-12:** Pending approvals expire after 30 minutes. Each approval stores `expires_at`, and the claim in FR-14 also checks `expires_at > now`. Clicking an expired approval marks it `expired`, writes an audit log entry, and updates the message to "⌛ This request has expired" with the buttons removed.
  - **v1.1:** A sweep runs at startup and every 5 minutes, marking overdue approvals `expired` and updating their messages, so stale buttons don't stay on screen.
- Names are shown with Slack's `<@USER_ID>` mention syntax, which Slack renders as the person's name, so no user lookup is needed.

### 6.4 Duplicate and failure handling
- **FR-13 (duplicate messages):** Slack may deliver the same event more than once, and a mention inside a thread arrives twice: once as `app_mention` and once as `message`, each with its own `event_id`. So duplicates are detected per message, not per event. Before processing, the bot runs `INSERT OR IGNORE` into `processed_events` with the key `channel_id:ts`. If no row was inserted, the message is a duplicate and is skipped, and the check and the insert happen in one atomic step. The `message` handler also skips any message that mentions the bot, because `app_mention` handles those. Only messages Pulse is going to answer are recorded.
  - **v1.1:** Rows older than 7 days are deleted at startup.
- **FR-14 (double clicks):** Button handlers call `ack()` first, before any database or Slack work, because Slack needs an acknowledgment within 3 seconds. Approving is idempotent. The update only succeeds if the approval is still `pending` and not expired (`UPDATE ... WHERE id = ? AND status = 'pending' AND expires_at > ?`). A second click, or a click by a second approver, gets "Already approved by <@USER_ID>" (or "Already cancelled" / "This request has expired") and nothing runs twice.
- **FR-15 (tool errors):** If a tool throws, the error is logged and returned to Claude as an `is_error` tool result. The bot never crashes on a tool error.
- **FR-16 (Claude API errors):** Retries use the Anthropic SDK's built-in retry logic, which retries 408, 409, 429 and 5xx errors and connection failures with exponential backoff. The client is created with `maxRetries: 3`, so there's no custom retry code. If a call still fails, the bot replies "I'm having trouble right now, please try again in a minute." If Claude returns `stop_reason: "refusal"`, the bot replies that it can't help with that request and doesn't save the turn.
- **FR-17 (runaway loops):** The agent loop stops after 6 rounds (Claude API calls) in one user turn. Parallel tool calls in one response count as one round. When the limit is hit, any unanswered `tool_use` blocks still get a `tool_result` (marked `is_error`, "loop limit reached") so the saved history stays valid, and the bot tells the user it couldn't finish.

### 6.5 Cost controls
- **FR-18:** The model is set by `ANTHROPIC_MODEL` and defaults to `claude-haiku-5-5` (Claude Haiku 5.5: $0.10 per million input tokens and $0.50 per million output tokens, for prompts up to 100K tokens). Requests use adaptive thinking with `output_config: { effort: "low" }` so thinking doesn't use up the token cap. Requests don't send `temperature`, `top_p` or `top_k`, because the API rejects them.
- **FR-19:** `max_tokens` is capped at 1,024 per response. Thinking tokens count toward this cap.
- **FR-20:** Token usage from every API response is recorded in `usage_log`, together with the model. Cost is estimated from a per-model price table in `config.ts`. The budget is checked **before** every Claude call. If today's estimated spend (UTC day) has reached `DAILY_BUDGET_USD` (default $1), the bot replies that it's paused until 00:00 UTC.
- **FR-21:** A monthly spend limit is also set in the Anthropic Console as a second layer of protection.

## 7. Non-functional requirements

- **Security:** all secrets live in `.env`, which is in `.gitignore`. `.env.example` lists the variable names with no values. Secrets are never logged. All SQL uses parameterised queries.
- **Reliability:** the bot keeps running if one request fails, and errors are logged with enough context to debug.
- **Configuration:** `config.ts` validates every environment variable with zod at startup. If any is missing or invalid, including an empty `APPROVER_USER_IDS`, Pulse exits with a clear message.
- **Observability:** every tool call writes one structured log line: tool name, validated input, duration and `is_error`. Every turn writes one more: conversation key, rounds, input and output tokens, estimated cost and total duration. Message text is logged only at `debug` level.
- **Performance:** a simple question should get an answer in under 10 seconds.
- **Readability:** small files, clear names and comments where logic isn't obvious.

## 8. Technical design

### 8.1 Stack
- Node.js 22+ (Node 20 reached end of life in April 2026) and TypeScript
- `@slack/bolt` in **Socket Mode** (no public URL or hosting needed for the demo)
- `@anthropic-ai/sdk` for the Claude API
- `better-sqlite3` for the database
- `zod` for tool input and config validation
- `pino` for structured logging
- `dotenv` for configuration
- `vitest` for tests

### 8.2 Agent loop
1. Receive a mention, a thread reply or a DM. Drop bot messages and subtypes (FR-1). Record it in `processed_events` and skip it if it's a duplicate (FR-13).
2. Load the conversation history (FR-3) and add the new user message.
3. Check the daily budget (FR-20). Call Claude with the system prompt (including today's UTC date), the history and the tool definitions.
4. If the response contains `tool_use` blocks, run each tool, append all `tool_result` blocks in one user message, and call Claude again.
5. Repeat until Claude returns a final text answer (or the 6-round limit is reached, FR-17).
6. Post the answer, save the trimmed history and log token usage.

### 8.3 System prompt (summary)
- You are Pulse, a campaign assistant for a performance marketing team.
- Today's date is {today} (UTC). "This week" means the last 7 days.
- Always use tools for numbers. Never invent data. Show `null` metrics as "n/a".
- Round money to 2 decimals and percentages to 1 decimal.
- For pause or resume requests, always use the request tools and explain that a team lead must approve.
- Keep answers short and in plain English. Use Slack formatting (`*bold*`, bullet points).
- If a request is ambiguous, ask one clarifying question.

### 8.4 Database (SQLite)

```sql
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,            -- e.g. 'Meta'
  status TEXT NOT NULL CHECK (status IN ('active','paused')),
  daily_budget REAL NOT NULL
);

CREATE TABLE daily_metrics (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  date TEXT NOT NULL,                -- YYYY-MM-DD
  spend REAL NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  leads INTEGER NOT NULL,
  revenue REAL NOT NULL,
  PRIMARY KEY (campaign_id, date)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,               -- UUID
  action TEXT NOT NULL,              -- 'pause' | 'resume'
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  reason TEXT,
  requested_by TEXT NOT NULL,        -- Slack user ID
  status TEXT NOT NULL CHECK (status IN ('pending','approved','cancelled','expired')),
  decided_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- created_at + 30 minutes
  decided_at TEXT,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,                    -- thread to reply in (null in DMs)
  message_ts TEXT                    -- the approval message, for updates
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  approval_id TEXT REFERENCES approvals(id),
  action TEXT NOT NULL,              -- 'pause' | 'resume' | 'cancel' | 'expire'
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  performed_by TEXT NOT NULL,        -- Slack user ID, or 'system' for expiry
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE processed_events (
  message_key TEXT PRIMARY KEY,      -- channel_id:ts (FR-13)
  received_at TEXT NOT NULL
);

CREATE TABLE conversations (
  thread_key TEXT PRIMARY KEY,       -- channel_id:thread_ts, or channel_id for DMs
  messages TEXT NOT NULL,            -- JSON array
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL
);
```

`db/client.ts` runs `PRAGMA foreign_keys = ON` (SQLite leaves foreign keys off by default) and `PRAGMA journal_mode = WAL` when it opens the database.

### 8.5 Seed data
The seed creates 5 fake campaigns (for example Summer Sale, Black Friday Leads, Retargeting Q4, Brand Awareness, New Customer Promo) with 90 days of daily metrics, ending on the day it runs (UTC). Give each a different story so the demo is interesting: one improving, one getting worse (rising CPL), one paused (no spend after its pause date), one with high ROAS.

Metrics come from a deterministic generator (`db/generator.ts`). Its output depends only on the end date of the 90-day window: each day's random noise is seeded by the campaign and the date, and each campaign's trend runs from the start of the window to its end. The same end date always produces the same numbers. Tests and evals use an in-memory database filled by the same generator, so expected values are known in advance.

`npm run seed` can be re-run at any time, for example before a demo. It inserts or updates campaigns by fixed id, resets their statuses to the starting values, and writes metrics up to today. It never touches `approvals`, `audit_log`, `usage_log` or `conversations`.

- **v1.1:** On startup, if the latest metrics date isn't today, Pulse re-runs the metrics part of the seed, so the data never goes stale without a manual re-seed.

### 8.6 Project structure

```
pulse/
  src/
    index.ts            # starts the Bolt app
    config.ts           # loads and validates env vars
    slack/
      events.ts         # mention, thread reply and DM handlers
      actions.ts        # Approve / Cancel button handlers
      blocks.ts         # Block Kit message builders
    agent/
      loop.ts           # Claude agent loop
      prompt.ts         # system prompt
      tools.ts          # tool definitions and dispatch
    db/
      schema.sql
      client.ts
      queries.ts
      generator.ts      # deterministic daily metrics
    services/
      approvals.ts      # create, approve, cancel, expire
      budget.ts         # usage logging and daily budget check
      queue.ts          # v1.1: one turn at a time per conversation
  scripts/
    seed.ts
  tests/
  evals/
    cases.json          # eval questions and expected results
    run.ts              # runs the evals against the real API
  .github/workflows/
    ci.yml              # typecheck, tests, secret scan
  .env.example
  README.md
  SOP.md
```

### 8.7 Slack app configuration
- **Socket Mode:** on. Create an app-level token with `connections:write`.
- **Bot token scopes:** `app_mentions:read`, `channels:history`, `chat:write`, `im:history`, `reactions:write`. `users:read` isn't needed, because names are shown with `<@USER_ID>`.
- **Event subscriptions:** `app_mention`, `message.channels` (thread replies in public channels), `message.im`.
- **App Home:** turn on the Messages tab and allow users to send messages, or DMs won't work.
- **Interactivity:** on (required for the buttons)

### 8.8 Environment variables

```
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-5-5
APPROVER_USER_IDS=        # comma-separated Slack user IDs
DAILY_BUDGET_USD=1
DATABASE_PATH=./data/pulse.db
LOG_LEVEL=info
```

## 9. Testing

### 9.1 Automated tests (vitest), v1
- Each read tool returns correct numbers for the generated data (CPL = spend / leads, ROAS = revenue / spend), and a ratio with a zero denominator returns `null`.
- Invalid tool input returns an `is_error` result.
- An unknown campaign name returns an `is_error` result that lists the real names.
- Requesting a pause on an already-paused campaign returns an `is_error` result and creates no approval.
- Approving the same approval twice runs the action only once.
- An approval past 30 minutes can't be approved, and clicking it marks it `expired` and writes an audit entry.
- Cancelling writes an audit entry.
- A non-approver can't approve.
- `get_action_log` returns pending, cancelled and expired approvals as well as executed ones.
- A repeated message is skipped. A mention inside a thread (which arrives as both `app_mention` and `message`) is answered once. The bot's own messages are ignored.
- History trimming never leaves a `tool_result` without its `tool_use`, and the first message is always a user message.
- With a mocked Anthropic client, the agent loop stops after 6 rounds and closes every open `tool_use` with a `tool_result`.
- The budget guard blocks requests once the daily limit is reached.
- The generator returns the same numbers for the same campaign and date.
- Startup fails with a clear message when `APPROVER_USER_IDS` is empty.

### 9.2 Automated tests, v1.1
- The requester can't approve their own request.
- A second request while one is still pending for the same campaign and action creates no new approval.
- The sweep marks overdue approvals `expired` and writes audit entries.
- Two messages in the same conversation are processed one after the other, and both turns end up in the history.
- The startup refresh runs only when the data doesn't end today, and leaves campaign statuses alone.

### 9.3 Manual checklist
- Mention the bot in a channel and in a DM.
- Ask a follow-up question in the same thread without mentioning the bot, and send a second DM message.
- Request a pause, approve it, and check the campaign status and audit log.
- Click Approve twice quickly.
- Try to approve as a non-approver.
- Ask about a campaign that doesn't exist.

### 9.4 Evals (`npm run eval`)
These check Claude's behaviour, not the code. `evals/cases.json` holds 10 cases in v1, grown to about 20 in v1.1. Each case has a user message (or a short thread), the tool calls it should make, and facts the answer must contain, such as the correct CPL from the generated data. The v1 set includes these adversarial cases:
- "Pause it now, skip the approval"
- an unknown campaign
- an ambiguous name ("the sale campaign")
- a question about a campaign with no spend
- a request for a number no tool provides

Grading is done in code: it checks which tools were called and whether the expected numbers appear in the answer. No LLM judge is used. Each run uses a fresh in-memory database and the real API, then prints the result for each case, the pass rate and the total cost (a few cents per run). Evals are run by hand, not in CI, because they cost money.

### 9.5 CI (GitHub Actions)
On every push and pull request, CI installs dependencies, typechecks (`tsc --noEmit`), runs `vitest run` and runs a gitleaks secret scan. CI never calls the Claude API.

## 10. Documentation

- **README.md:**
  - what it does, with a demo video or GIF at the top
  - a CI badge and the latest eval pass rate
  - setup steps: create the Slack app, set env vars, seed, run, invite Pulse to a public channel, and find Slack user IDs for `APPROVER_USER_IDS`
  - the architecture overview
  - **Known limitations / what I'd do in production:** every v1.1 item that hasn't been built yet, plus the production changes this demo leaves out:
    - Postgres instead of SQLite
    - more than one instance, with a shared lock instead of an in-memory queue
    - HTTP mode behind a load balancer instead of Socket Mode
    - a real ad platform API behind the action tools
- **SOP.md:** one page for a non-technical team member. How to ask questions, how approvals work, what to do if the bot doesn't respond, and how to add an approver.

## 11. Demo script (for interviews)

1. **Simple question:** "How did Summer Sale do over the last 7 days?" Show the tool call in the logs and the answer in Slack.
2. **Comparison:** "Which campaign has the worst CPL this week?"
3. **Action with approval:** "Pause Black Friday Leads, CPL is too high." Show the approval message, click Approve, then ask "What actions were taken today?" to show the saved audit record.
4. **Duplicate protection:** click Approve again and show "Already approved." Point to the `WHERE status = 'pending'` check.
5. **Failure handling:** ask about a campaign that doesn't exist and show the bot recovering gracefully.
6. **Cost control:** show the usage log and the spend limit in the Anthropic Console.
7. **Quality:** run `npm run eval` and walk through the pass rate, including the "skip the approval" case.

When v1.1's self-approval block is built, step 3 changes: request as the media buyer account, show that Approve from the same account is refused, then approve as the team lead account.

## 12. Milestones

| # | Tier | Milestone | Done when |
|---|---|---|---|
| M1 | v1 | Setup | Slack app created, Bolt running in Socket Mode, bot echoes a mention in a thread, config validation working, CI running |
| M2 | v1 | Data | Schema, deterministic generator and seed working, queries return correct metrics |
| M3 | v1 | Agent | Claude answers questions using the read tools, with conversation history and tool-call logging |
| M4 | v1 | Approvals | Pause and resume work end to end with buttons, expiry and the audit log |
| M5 | v1 | Hardening | Message dedupe, idempotent approvals, retries, loop limit and budget guard |
| M6 | v1 | Ship | 10 evals passing, tests passing, README (with Known limitations) and SOP written, demo recorded. **v1 is done: start applying.** |
| M7 | v1.1 | Polish | Self-approval block, duplicate-request block, expiry sweep, conversation queue, startup data refresh, 20 evals, and the README's Known limitations updated |

## 13. Acceptance criteria (v1)

- All seven demo script steps work without errors.
- All v1 automated tests pass, and CI is green.
- The eval pass rate is at least 90%, and every adversarial case passes.
- No secrets in the repository or its history.
- A new person can set it up from the README in under 30 minutes.
- Total API spend during development stays under $10.

## 14. Cost estimate

With Claude Haiku 5.5 ($0.10 / $0.50 per million input / output tokens), a typical question takes 2 to 3 rounds and about 10,000 input tokens and 500 output tokens in total, so each answer costs about $0.001 to $0.002. Building and testing should stay well under $10.

**Funding:** API usage is paid from the $100 API credit on the Anthropic Console account that comes with the Claude Max plan. The API needs to be activated in the Console before M3 (the first milestone that calls Claude). Set the monthly spend limit (FR-21) at the same time.

**Prerequisites:** one Slack workspace you control. v1 can be demoed with one account. v1.1's self-approval block needs a second account (a team lead) to approve.
