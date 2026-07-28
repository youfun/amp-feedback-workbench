/** Shared types for Amp feedback workbench (hono_feedback_duck). */

export type FeedbackStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

export type FeedbackAction =
  | "claim"
  | "start_processing"
  | "submit_for_review"
  | "verify_pass"
  | "verify_fail"
  | "reject"
  | "mark_duplicate"
  | "comment"
  | "ai_analysis"
  | "status_change";

export type FeedbackLinkKind = "pr" | "commit" | "branch" | "url";

export interface FeedbackLink {
  kind: FeedbackLinkKind;
  url: string;
  title?: string | null;
}

export type FeedbackActorType = "human" | "pi_agent" | "droid_agent" | "amp_agent" | "system";

export interface FeedbackActor {
  type: FeedbackActorType;
  id?: string | null;
  name?: string | null;
}

export type FeedbackType = "bug" | "feature" | "other";

export interface FeedbackAttachment {
  id?: number;
  filename: string;
  content_type?: string;
  byte_size?: number;
  kind?: string;
  object_key?: string;
  url?: string | null;
}

export interface FeedbackItem {
  id: number;
  project_seq?: number | null;
  project_id: string | number | null;
  status: FeedbackStatus;
  note: string | null;
  url: string | null;
  title: string | null;
  feedback_type: FeedbackType | string;
  priority?: string | null;
  labels?: string[] | null;
  acceptance_criteria?: string | null;
  links?: FeedbackLink[] | null;
  image_object_key?: string | null;
  screenshot_url?: string | null;
  attachments?: FeedbackAttachment[];
  build_version?: string | null;
  env?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  meta?: Record<string, unknown>;
  current_assignee?: string | null;
  claimed_at?: string | null;
  completed_at?: string | null;
  claim_count?: number;
  last_event_at?: string | null;
  inserted_at: string;
  updated_at?: string;
}

export interface FeedbackEvent {
  id: number;
  feedback_id: number;
  action: FeedbackAction | string;
  actor_type: FeedbackActorType | string;
  actor_id: string | null;
  actor_name: string | null;
  from_status: FeedbackStatus | null;
  to_status: FeedbackStatus | null;
  claim_round: number | null;
  note: string | null;
  meta?: Record<string, unknown>;
  inserted_at: string;
}

export interface FeedbackDetail {
  item: FeedbackItem;
  events: FeedbackEvent[];
  attachments?: FeedbackAttachment[];
  screenshot_url?: string | null;
}

export interface ActionResult {
  ok?: boolean;
  item: FeedbackItem;
  event?: FeedbackEvent;
  events?: FeedbackEvent[];
}

export interface ListFeedbackParams {
  status?: FeedbackStatus | string;
  project_id?: string | number;
  assignee?: string;
  q?: string;
  limit?: number;
}

export interface StoredConfig {
  baseUrl?: string;
  agentToken?: string;
  projectId?: number | string | null;
  projectSlug?: string | null;
  actorId?: string;
  actorName?: string;
}

export interface AgentConfig {
  baseUrl: string;
  projectId?: number | string | null;
  projectSlug?: string | null;
  agentToken: string;
  actorId: string;
  actorName: string;
  cwd?: string;
  configPath?: string;
  source?: string;
}
