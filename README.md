# Pulse

[![CI](https://github.com/jorgebocobo9/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/jorgebocobo9/pulse/actions/workflows/ci.yml)

A Slack assistant for a (fictional) performance marketing team. Ask it about campaign performance in plain English. Claude picks the right tools, reads the numbers from a database and answers in the thread. Risky actions, such as pausing a campaign, only run after a team lead clicks **Approve**.

> 🚧 Work in progress. See [`slack-agent-PRD.md`](slack-agent-PRD.md) for the full spec and milestones.

## Setup

Requires Node.js 22 or newer.

1. **Install dependencies:** `npm install`
2. **Create the Slack app:** go to <https://api.slack.com/apps>, click **Create New App → From a manifest**, pick your workspace and paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
3. **Get the tokens:**
   - **Basic Information → App-Level Tokens:** generate a token with the `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-…`).
   - **Install App:** install it to your workspace. The Bot User OAuth Token is `SLACK_BOT_TOKEN` (`xoxb-…`).
4. **Find your Slack user ID:** in Slack, click your profile picture → **Profile** → **⋮** → **Copy member ID**. Put it in `APPROVER_USER_IDS`.
5. **Configure:** `cp .env.example .env` and fill in the values above.
6. **Load the demo data:** `npm run seed` creates 5 fake campaigns with 90 days of metrics ending today (UTC). Re-run it before a demo to refresh the numbers; it never deletes approvals or the audit log.
7. **Run:** `npm run dev`
8. **Try it:** in a public channel, run `/invite @Pulse`, then send `@Pulse hello`. Pulse replies in a thread.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs Pulse with auto-reload and readable logs |
| `npm start` | Runs Pulse |
| `npm run seed` | Loads or refreshes the demo campaign data |
| `npm run typecheck` | Type-checks the project |
| `npm test` | Runs the tests |
