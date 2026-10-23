/** Removes the bot's own `<@U123>` mention from a message. Other mentions are kept. */
export function stripBotMention(text: string, botUserId: string | undefined): string {
  const withoutBot = botUserId ? text.replaceAll(`<@${botUserId}>`, '') : text;
  return withoutBot.replace(/\s+/g, ' ').trim();
}

/** A safety net for Markdown habits that Slack's mrkdwn doesn't understand. */
export function toSlackMrkdwn(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **bold** -> *bold*
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*'); // # Heading -> *Heading*
}
