import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { compareCampaigns, findCampaign, getCampaignStats, listCampaigns, type Campaign } from '../db/queries.js';
import { createApproval, getActionLog, type Approval, type ApprovalAction } from '../services/approvals.js';

/** Who sent the message and where. It comes from the Slack event, never from Claude. */
export interface RequestContext {
  userId: string;
  channelId: string;
  threadTs: string | undefined;
}

export interface ToolContext {
  db: Db;
  today: string;
  now: Date;
  /** Needed by the action tools. Absent outside Slack, for example in the smoke test. */
  request?: RequestContext;
  onApprovalCreated?: (approval: Approval) => void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Set when the tool threw something unexpected, so the caller can log it. */
  failure?: unknown;
}

/** An expected failure that Claude can recover from, such as an unknown campaign name. */
export class ToolError extends Error {}

interface RegisteredTool {
  definition: Anthropic.Tool;
  execute(rawInput: unknown, ctx: ToolContext): unknown;
}

// Each tool's zod schema is the single source of truth: it validates the input Claude sends and
// generates the JSON Schema Claude sees.
function defineTool<Schema extends z.ZodObject>(spec: {
  name: string;
  description: string;
  input: Schema;
  run: (input: z.infer<Schema>, ctx: ToolContext) => unknown;
}): RegisteredTool {
  // `io: 'input'` keeps fields with defaults optional in the schema Claude sees.
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: 'input' });
  return {
    definition: {
      name: spec.name,
      description: spec.description,
      input_schema: inputSchema as Anthropic.Tool.InputSchema,
    },
    execute(rawInput, ctx) {
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) throw new ToolError(`Invalid input:\n${z.prettifyError(parsed.error)}`);
      return spec.run(parsed.data, ctx);
    },
  };
}

const days = z
  .number()
  .int()
  .min(1)
  .max(90)
  .describe('How many days to cover, ending today and including today. Use 7 for "this week".');

function resolveCampaign(db: Db, name: string): Campaign {
  const match = findCampaign(db, name);
  if (match.kind === 'found') return match.campaign;
  if (match.kind === 'ambiguous') {
    throw new ToolError(
      `"${name}" matches more than one campaign: ${match.candidates.join(', ')}. Ask the user which one they mean.`,
    );
  }
  throw new ToolError(`No campaign matches "${name}". The campaigns are: ${match.allNames.join(', ')}.`);
}

// Creates a pending approval only. The campaign changes when an approver clicks Approve (see services/approvals.ts).
function requestChangeTool(action: ApprovalAction): RegisteredTool {
  const gerund = action === 'pause' ? 'pausing' : 'resuming';
  return defineTool({
    name: `request_${action}_campaign`,
    description: `Ask a team lead to approve ${gerund} a campaign. This does not change the campaign. It posts an approval request with Approve and Cancel buttons below your reply, and the change happens only if an approver clicks Approve within 30 minutes.`,
    input: z.object({
      campaign_name: z.string().min(1).describe('The campaign name. Matching ignores case, and a unique part of the name also works.'),
      reason: z.string().min(1).max(500).describe("Why the user wants this, in their words."),
    }),
    run: ({ campaign_name, reason }, { db, now, request, onApprovalCreated }) => {
      if (!request) throw new ToolError('Campaign changes can only be requested from Slack.');
      const campaign = resolveCampaign(db, campaign_name);
      const outcome = createApproval(db, {
        action,
        campaign,
        reason,
        requestedBy: request.userId,
        channelId: request.channelId,
        threadTs: request.threadTs,
        now,
      });
      if (outcome.kind === 'already_in_state') {
        throw new ToolError(`${campaign.name} is already ${campaign.status}, so there is nothing to request.`);
      }
      onApprovalCreated?.(outcome.approval);
      return {
        status: 'approval_requested',
        action,
        campaign: campaign.name,
        expiresAt: outcome.approval.expiresAt,
        note: 'The approval request appears below your reply. Nothing changes until a team lead clicks Approve.',
      };
    },
  });
}

const tools: RegisteredTool[] = [
  defineTool({
    name: 'list_campaigns',
    description: 'List campaigns with their id, name, platform, status (active or paused) and daily budget.',
    input: z.object({
      status: z.enum(['active', 'paused']).optional().describe('Only return campaigns with this status.'),
    }),
    run: ({ status }, { db }) => listCampaigns(db, status),
  }),
  defineTool({
    name: 'get_campaign_stats',
    description:
      'Totals and ratios for one campaign over the last N days: spend, impressions, clicks, leads, revenue, CTR (a percentage), CPL and ROAS. A ratio is null when its denominator is zero.',
    input: z.object({
      campaign_name: z
        .string()
        .min(1)
        .describe('The campaign name. Matching ignores case, and a unique part of the name also works.'),
      days,
    }),
    run: ({ campaign_name, days }, { db, today }) =>
      getCampaignStats(db, resolveCampaign(db, campaign_name).id, days, today),
  }),
  defineTool({
    name: 'compare_campaigns',
    description:
      'Rank every campaign by one metric over the last N days, best first, with each campaign\'s full stats. CPL ranks lowest first; ROAS, CTR and spend rank highest first. Campaigns with no value for the metric (null) come last.',
    input: z.object({
      metric: z.enum(['cpl', 'roas', 'ctr', 'spend']),
      days,
    }),
    run: ({ metric, days }, { db, today }) => compareCampaigns(db, metric, days, today),
  }),
  defineTool({
    name: 'get_action_log',
    description:
      'Recent pause and resume requests, newest first: action, campaign, status (pending, approved, cancelled or expired), reason, who requested and decided them, and the times (UTC). Approved requests are the actions that were actually carried out. requestedBy and decidedBy are Slack user IDs; write them as <@USERID> so Slack shows the name.',
    input: z.object({
      days: days.default(1),
      status: z.enum(['pending', 'approved', 'cancelled', 'expired']).optional().describe('Only return requests with this status.'),
    }),
    run: ({ days, status }, { db, today, now }) => getActionLog(db, { days, status, today, now }),
  }),
  requestChangeTool('pause'),
  requestChangeTool('resume'),
];

const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));

/** Tool definitions in a fixed order, so every request sends identical `tools`. */
export const TOOL_DEFINITIONS: Anthropic.Tool[] = tools.map((tool) => tool.definition);

/** Runs a tool and never throws: every failure becomes an error result that Claude can read. */
export function runTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  const tool = toolsByName.get(name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    return { content: JSON.stringify(tool.execute(input, ctx)), isError: false };
  } catch (error) {
    if (error instanceof ToolError) return { content: error.message, isError: true };
    return { content: 'The tool failed unexpectedly. Tell the user to try again later.', isError: true, failure: error };
  }
}
