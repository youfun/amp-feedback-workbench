import type {
  ActionResult,
  AgentConfig,
  FeedbackAction,
  FeedbackActor,
  FeedbackDetail,
  FeedbackItem,
  FeedbackLink,
  ListFeedbackParams,
} from "./types.ts";

export class FeedbackApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "FeedbackApiError";
    this.status = status;
    this.body = body;
  }
}

export function createClient(config: AgentConfig) {
  const base = config.baseUrl.replace(/\/$/, "");

  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${config.agentToken}`,
    "User-Agent": "amp-feedback-workbench/1.0 (+local-agent)",
  });

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...headers(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && (data.message || data.error)) ||
        text ||
        res.statusText;
      throw new FeedbackApiError(
        `${init.method || "GET"} ${path} failed: ${res.status} ${msg}`,
        res.status,
        text,
      );
    }
    return data as T;
  }

  return {
    async listFeedback(params: ListFeedbackParams = {}): Promise<FeedbackItem[]> {
      const qs = new URLSearchParams();
      const projectId = params.project_id ?? config.projectId ?? undefined;
      if (params.status) qs.set("status", String(params.status));
      if (projectId != null && projectId !== "") qs.set("project_id", String(projectId));
      if (params.assignee) qs.set("assignee", params.assignee);
      if (params.q) qs.set("q", params.q);
      if (params.limit != null) qs.set("limit", String(params.limit));
      const query = qs.toString();
      const data = await request<{ items?: FeedbackItem[] }>(
        `/api/feedback${query ? `?${query}` : ""}`,
      );
      return data.items || [];
    },

    async getFeedback(id: number): Promise<FeedbackDetail> {
      const data = await request<any>(`/api/feedback/${id}`);
      if (data && typeof data === "object" && "item" in data) {
        const attachments = Array.isArray(data.attachments)
          ? data.attachments
          : Array.isArray(data.item?.attachments)
            ? data.item.attachments
            : [];
        const screenshot_url =
          data.item.screenshot_url ?? data.screenshot_url ?? null;
        return {
          item: { ...data.item, screenshot_url, attachments },
          events: Array.isArray(data.events) ? data.events : [],
          attachments,
          screenshot_url,
        };
      }
      throw new Error(`Unexpected getFeedback response for #${id}`);
    },

    async action(
      id: number,
      action: FeedbackAction,
      opts: {
        actor: FeedbackActor;
        note?: string | null;
        meta?: Record<string, unknown> | null;
      },
    ): Promise<ActionResult> {
      return request<ActionResult>(`/api/feedback/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action,
          actor: opts.actor,
          note: opts.note ?? null,
          meta: {
            source: "amp-extension",
            ...(opts.meta || {}),
          },
        }),
      });
    },

    claim(id: number, actor: FeedbackActor, note?: string) {
      return this.action(id, "claim", {
        actor,
        note: note || "Claimed via Amp extension",
        meta: { source: "amp-extension", command: "claim" },
      });
    },

    startProcessing(id: number, actor: FeedbackActor, note?: string) {
      return this.action(id, "start_processing", { actor, note: note || null });
    },

    submitForReview(
      id: number,
      actor: FeedbackActor,
      note: string,
      meta?: Record<string, unknown> | null,
    ) {
      return this.action(id, "submit_for_review", {
        actor,
        note,
        meta: meta ?? null,
      });
    },

    addComment(id: number, actor: FeedbackActor, note: string) {
      return this.action(id, "comment", { actor, note });
    },

    addAiAnalysis(
      id: number,
      actor: FeedbackActor,
      analysis: string | Record<string, unknown>,
    ) {
      const note =
        typeof analysis === "string" ? analysis : JSON.stringify(analysis);
      const meta =
        typeof analysis === "string"
          ? { kind: "ai_analysis" }
          : { kind: "ai_analysis", ...analysis };
      return this.action(id, "ai_analysis", { actor, note, meta });
    },

    async patchFeedback(
      id: number,
      patch: { links?: FeedbackLink[]; [key: string]: unknown },
    ): Promise<FeedbackItem | { item: FeedbackItem }> {
      return request(`/api/feedback/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
  };
}

export type FeedbackClient = ReturnType<typeof createClient>;
