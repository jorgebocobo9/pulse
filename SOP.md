# Pulse: how to use it

Pulse is the team's campaign assistant in Slack. Ask it about campaign performance in plain English, and it looks up the numbers for you. It can also ask a team lead to pause or resume a campaign.

## Asking questions

Mention **@Pulse** in a channel it has been invited to, or send it a direct message.

- "How did Summer Sale do over the last 7 days?"
- "Which campaign has the worst CPL this week?"
- "Compare Retargeting Q4 and New Customer Promo over the last 30 days."
- "Which campaigns are paused?"

Pulse answers in a thread under your message. To ask a follow-up, reply in that thread; you don't need to mention @Pulse again. While Pulse is working, you'll see 👀 on your message.

Good to know:

- "This week" means the last 7 days, including today. Dates follow UTC.
- Pulse only has ad data: spend, impressions, clicks, leads and revenue. It can't tell you profit or margins.
- When a number shows as "n/a", there was nothing to calculate it from (for example, no leads means no cost per lead).

## Pausing or resuming a campaign

Ask Pulse and give a reason:

> @Pulse Pause Black Friday Leads, the CPL is too high.

Pulse doesn't change anything itself. It posts a request with **Approve** and **Cancel** buttons, and the campaign changes only when a team lead clicks **Approve**.

- **Who can approve:** team leads on the approver list.
- **Who can cancel:** the person who asked, or a team lead.
- **Time limit:** a request expires after 30 minutes. If it expires, just ask again.
- **Clicked twice?** Nothing happens twice. You'll see a private note saying it was already approved.

To check what happened, ask: "What actions were taken today?" or "Did my pause go through?"

## If Pulse doesn't respond

1. **No 👀 on your message:** make sure you mentioned @Pulse, or that you're replying in a thread Pulse started. In a new channel, invite it first with `/invite @Pulse`.
2. **"I'm having trouble right now":** the AI service had a problem. Wait a minute and try again.
3. **"I've reached today's spending limit":** Pulse has a daily budget and is paused until 00:00 UTC.
4. **Still nothing:** tell the person who runs Pulse. Pulse may need restarting, which they do with `npm start` on the machine that runs it.

## Adding an approver

This is done by the person who runs Pulse.

1. In Slack, open the new approver's profile, click **⋮**, then **Copy member ID**. It starts with `U`.
2. Open the `.env` file and add the ID to `APPROVER_USER_IDS`, separated by a comma:
   `APPROVER_USER_IDS=U0CBA76T43Z,U0NEWPERSON`
3. Restart Pulse.
