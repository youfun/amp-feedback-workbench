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

export type FeedbackPriority = "urgent" | "high" | "medium" | "low";

export type FeedbackActorType =
  | "human"
  | "pi_agent"
  | "droid_agent"
  | "amp_agent"
  | "system";

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
  priority?: FeedbackPriority | string | null;
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
  agent_sessions?: Array<{
    agent_type?: FeedbackActorType | string;
    session_id?: string;
    actor_id?: string | null;
    actor_name?: string | null;
    resume_command?: string | null;
    first_seen_at?: string;
    last_seen_at?: string;
  }>;
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

export interface CreateFeedbackInput {
  note?: string;
  title?: string | null;
  feedbackType?: FeedbackType | string;
  labels?: string[] | string | null;
  url?: string | null;
  project_id?: number | string | null;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ReleaseStatus = "draft" | "published";

export interface ProjectRelease {
  id: number;
  project_id?: number | string;
  version: string;
  title?: string | null;
  notes_md?: string;
  target_date?: string | null;
  status: ReleaseStatus;
  revision: number;
  item_count?: number;
  published_at?: string | null;
}

export interface ProjectReleaseItem {
  id: number;
  release_id: number;
  feedback_id: number;
  feedback?: FeedbackItem | null;
}

export interface ReleaseDetail {
  release: ProjectRelease;
  items: ProjectReleaseItem[];
  events?: Array<{ id: number; action: string; inserted_at?: string }>;
}

export interface SubmitFeedbackResult {
  ok: boolean;
  id: number;
  project_slug: string;
  admin_url?: string;
  [key: string]: unknown;
}

export interface StoredConfig {
  baseUrl?: string;
  agentToken?: string;
  submitToken?: string;
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
  submitToken?: string;
  actorId: string;
  actorName: string;
  cwd?: string;
  configPath?: string;
  source?: string;
}
