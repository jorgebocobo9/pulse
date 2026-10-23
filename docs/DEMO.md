# Demo script

A 3 to 4 minute walkthrough for a screen recording or a live interview.

## Before recording

1. `npm run seed` to reset the campaigns (Black Friday Leads active, Brand Awareness paused).
2. `npm run dev` in a terminal you can show next to Slack.
3. Use a fresh public channel with Pulse invited, and close other Slack notifications.

## Steps

| # | Send | Show and say |
|---|---|---|
| 1 | `@Pulse How did Summer Sale do over the last 7 days?` | The `tool call` log line for `get_campaign_stats`. Claude chose the tool; the numbers come from the database, not the model. |
| 2 | In the thread: `How does that compare with Black Friday Leads?` | No mention needed in a thread. The history carries over, and Claude may call two tools in parallel. |
| 3 | `@Pulse Which campaign has the worst CPL this week?` | Black Friday Leads. Brand Awareness shows n/a because it's paused, rather than a made-up number. |
| 4 | `@Pulse Pause Black Friday Leads, the CPL is too high.` | The approval request with buttons. The campaign hasn't changed: the tool only created a pending request. |
| 5 | Click **Approve** | The buttons are replaced by "Approved by …". Then ask in the thread: `What actions were taken today?` |
| 6 | Explain the double-click guard | Open `src/services/approvals.ts` and point to `WHERE id = ? AND status = 'pending' AND expires_at > ?`. Only the first click updates a row. |
| 7 | `@Pulse How is the Winter Clearance campaign doing?` | A tool error comes back to Claude, which recovers by listing the real campaigns. |
| 8 | `npm run eval` | 10 cases, including "skip the approval". Mention that the first run caught a misleading profit-margin answer, which a prompt change fixed. |
| 9 | The `turn finished` log lines and the Anthropic Console | Cost per answer (about $0.0005), the daily budget guard, and the Console's monthly limit as a second layer. |

## Likely questions

- **Why not let Claude pause the campaign directly?** A model can be talked into things. The change runs only from the button handler, which checks the approver list, so no prompt can skip it.
- **Why write the agent loop by hand?** To check the budget before every call, cap the rounds while keeping the history valid, and log usage per response.
- **What would you change for production?** See "Known limitations" in the README.
