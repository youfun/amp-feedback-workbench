import type { FeedbackEvent, FeedbackItem } from "./types.js";

function clip(text: string | null | undefined, max = 72): string {
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function displayNo(item: { id: number; project_seq?: number | null }): number {
  return item.project_seq != null && item.project_seq > 0 ? item.project_seq : item.id;
}

export function formatListLabel(item: FeedbackItem): string {
  const title = item.title || clip(item.note, 48) || "(no note)";
  const assignee = item.current_assignee ? ` @${item.current_assignee}` : "";
  const claims =
    item.claim_count && item.claim_count > 0 ? ` claims:${item.claim_count}` : "";
  return `#${displayNo(item)} [${item.status}] [${item.feedback_type}] ${title}${assignee}${claims}`;
}

export function formatEventLine(event: FeedbackEvent): string {
  const who = event.actor_name || event.actor_id || event.actor_type;
  const round = event.claim_round ? ` (round ${event.claim_round})` : "";
  const status =
    event.from_status || event.to_status
      ? ` ${event.from_status ?? "?"}→${event.to_status ?? "?"}`
      : "";
  const note = event.note ? ` — ${clip(event.note, 80)}` : "";
  return `${event.inserted_at} ${event.action}${round}${status} by ${who}${note}`;
}

export function buildInjectMessage(
  item: FeedbackItem,
  options: {
    projectSlug?: string | null;
    claimRound?: number | null;
    extraPrompt?: string | null;
    events?: FeedbackEvent[];
  } = {},
): string {
  const meta =
    item.meta && Object.keys(item.meta).length > 0
      ? `\nMeta:\n${JSON.stringify(item.meta, null, 2)}`
      : "";

  const recentEvents =
    options.events && options.events.length > 0
      ? `\nRecent events:\n${options.events
          .slice(0, 8)
          .map((e) => `- ${formatEventLine(e)}`)
          .join("\n")}`
      : "";

  const extra = options.extraPrompt?.trim()
    ? `\n\nAdditional instructions from operator:\n${options.extraPrompt.trim()}`
    : "";

  const ac = item.acceptance_criteria
    ? `\nAcceptance criteria:\n${item.acceptance_criteria}`
    : "";

  const titleLine = (item.title || "").trim() || "(no title)";
  const body = (item.note || "").trim() || "(no text body)";

  return `Please process this user feedback.

## Issue
- Issue #: ${displayNo(item)}
- Feedback ID (internal): ${item.id}
- Project ID: ${item.project_id ?? "n/a"}
- Project slug: ${options.projectSlug || "n/a"}
- Page URL: ${item.url || "n/a"}
- **Title:** ${titleLine}
- Type: ${item.feedback_type}
- Priority: ${item.priority || "n/a"}
- Status: ${item.status}
- Current assignee: ${item.current_assignee || "n/a"}
- Claim count: ${item.claim_count ?? 0}
- Claim round (this open): ${options.claimRound ?? item.claim_count ?? "n/a"}
- User: ${item.user_email || item.user_id || "anonymous"}
- Env: ${item.env || "n/a"}
- Build: ${item.build_version || "n/a"}
- Inserted at: ${item.inserted_at}
${ac}

## Title
${titleLine}

## User description / body
${body}
${meta}${recentEvents}

## Required reading before coding
1. Read the Title and User description above in full.
2. If Attachments are listed below, open every **image** with the Read or view_media tool (do not skip screenshots).
3. Then investigate the codebase and implement/verify.

## Workflow tools
- feedback_start_processing
- feedback_add_ai_analysis
- feedback_add_comment
- feedback_add_link (optional PR/commit/branch/url)
- feedback_submit_for_review (REQUIRED when done; never mark complete/done)
- feedback_get / feedback_list / feedback_claim
- feedback_upload_attachment (for screenshots/logs for this issue)
- feedback_record_change / feedback_upload_changes
- release_list / release_get / release_create / release_add_items
- release_stage_current / release_draft_changelog / release_publish (human-only)

Use Feedback ID (internal) with workflow tools.
Release safety: changed-file progress comments are not release membership. Only explicit release_add_items or release_stage_current may stage an issue.
Never mark done yourself — verification is Web/admin only.${extra}
`;
}

export function parseIdArg(args: string): number | null {
  const raw = args.trim().split(/\s+/)[0];
  if (!raw) return null;
  const id = Number(raw.replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : null;
}
