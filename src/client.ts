import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolveMediaType } from "./image.js";
import type {
  ActionResult,
  AgentConfig,
  CreateFeedbackInput,
  FeedbackAction,
  FeedbackActor,
  FeedbackDetail,
  FeedbackItem,
  FeedbackLink,
  ListFeedbackParams,
  ProjectRelease,
  ProjectReleaseItem,
  ReleaseDetail,
  SubmitFeedbackResult,
} from "./types.js";

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
    async submitFeedback(
      input: CreateFeedbackInput,
      opts: { token?: string } = {},
    ): Promise<SubmitFeedbackResult> {
      const token = opts.token || config.submitToken;
      if (!token) {
        throw new Error(
          "No submitToken configured. Add a Project Token to .amp/feedback-workbench.json or set AMP_FEEDBACK_SUBMIT_TOKEN.",
        );
      }
      const projectId = input.project_id ?? config.projectId ?? undefined;
      const payload = {
        ...input,
        ...(projectId != null ? { project_id: projectId } : {}),
      };
      const res = await fetch(`${base}/api/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const msg =
          (data && typeof data === "object" && ((data as any).message || (data as any).error)) ||
          text ||
          res.statusText;
        throw new FeedbackApiError(
          `POST /api/feedback failed: ${res.status} ${msg}`,
          res.status,
          text,
        );
      }
      return data as SubmitFeedbackResult;
    },

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

    async listReleases(params: {
      projectId: number | string;
      status?: "draft" | "published";
      limit?: number;
    }): Promise<ProjectRelease[]> {
      const qs = new URLSearchParams();
      if (params.status) qs.set("status", params.status);
      if (params.limit != null) qs.set("limit", String(params.limit));
      const query = qs.toString();
      const data = await request<{ releases?: ProjectRelease[] }>(
        `/api/projects/${encodeURIComponent(String(params.projectId))}/releases${query ? `?${query}` : ""}`,
      );
      return data.releases || [];
    },

    async getRelease(projectId: number | string, releaseId: number): Promise<ReleaseDetail> {
      const data = await request<ReleaseDetail>(
        `/api/projects/${encodeURIComponent(String(projectId))}/releases/${releaseId}`,
      );
      return {
        release: data.release,
        items: data.items || [],
        events: data.events || [],
      };
    },

    async getReleaseByVersion(projectId: number | string, version: string): Promise<ReleaseDetail> {
      const data = await request<ReleaseDetail>(
        `/api/projects/${encodeURIComponent(String(projectId))}/releases/by-version/${encodeURIComponent(version)}`,
      );
      return {
        release: data.release,
        items: data.items || [],
        events: data.events || [],
      };
    },

    async createRelease(
      projectId: number | string,
      input: { version: string; title?: string; target_date?: string; notes_md?: string },
    ): Promise<{ release: ProjectRelease }> {
      return request(`/api/projects/${encodeURIComponent(String(projectId))}/releases`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    async addReleaseItems(
      projectId: number | string,
      releaseId: number,
      input: {
        feedback_ids: number[];
        expected_revision: number;
        section?: "features" | "fixes" | "other";
      },
    ): Promise<{
      release: ProjectRelease;
      items: ProjectReleaseItem[];
      added_count: number;
      warnings: string[];
    }> {
      return request(
        `/api/projects/${encodeURIComponent(String(projectId))}/releases/${releaseId}/items`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },

    async draftReleaseChangelog(
      projectId: number | string,
      releaseId: number,
      input: { apply: boolean; expected_revision?: number },
    ): Promise<{ release: ProjectRelease; notes_md: string; applied: boolean }> {
      return request(
        `/api/projects/${encodeURIComponent(String(projectId))}/releases/${releaseId}/draft-changelog`,
        { method: "POST", body: JSON.stringify(input) },
      );
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
          agent_sessions: Array.isArray(data.agent_sessions) ? data.agent_sessions : [],
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

    claim(id: number, actor: FeedbackActor, note?: string, meta?: Record<string, unknown> | null) {
      return this.action(id, "claim", {
        actor,
        note: note || "Claimed via Amp extension",
        meta: { command: "claim", ...(meta || {}) },
      });
    },

    startProcessing(
      id: number,
      actor: FeedbackActor,
      note?: string,
      meta?: Record<string, unknown> | null,
    ) {
      return this.action(id, "start_processing", { actor, note: note || null, meta: meta ?? null });
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

    addComment(
      id: number,
      actor: FeedbackActor,
      note: string,
      meta?: Record<string, unknown> | null,
    ) {
      return this.action(id, "comment", { actor, note, meta: meta ?? null });
    },

    addAiAnalysis(
      id: number,
      actor: FeedbackActor,
      analysis: string | Record<string, unknown>,
      sessionMeta?: Record<string, unknown> | null,
    ) {
      const note =
        typeof analysis === "string" ? analysis : JSON.stringify(analysis);
      const meta =
        typeof analysis === "string"
          ? { kind: "ai_analysis", ...(sessionMeta || {}) }
          : { kind: "ai_analysis", ...analysis, ...(sessionMeta || {}) };
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

    async uploadAttachments(
      feedbackId: number,
      files: Array<{
        path?: string;
        data?: Uint8Array;
        filename?: string;
        contentType?: string;
      }>,
    ): Promise<{
      ok: boolean;
      saved?: string[];
      attachments?: unknown[];
      errors?: string[];
    }> {
      if (!files.length) return { ok: false, errors: ["no_files"] };

      const form = new FormData();
      form.set("source", "amp");
      const maxBytes = 5 * 1024 * 1024;

      for (const file of files) {
        let bytes: Uint8Array;
        if (file.path) {
          const fileStat = await stat(file.path);
          if (!fileStat.isFile()) throw new Error("attachment path must be a regular file");
          if (fileStat.size > maxBytes) {
            throw new Error("file_too_large (max 5MB)");
          }
          bytes = new Uint8Array(await readFile(file.path));
        } else if (file.data) {
          bytes = file.data;
        } else {
          throw new Error("Either path or data must be provided");
        }
        if (bytes.byteLength > maxBytes) {
          throw new Error("file_too_large (max 5MB)");
        }
        const name = basename(file.filename || (file.path ? basename(file.path) : "file.bin"));
        const contentType =
          file.contentType ||
          resolveMediaType({ filename: name, url: file.path, bytes });
        const blob = new Blob([bytes], { type: contentType });
        form.append("files", blob, name);
      }

      const res = await fetch(`${base}/api/feedback/${feedbackId}/attachments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.agentToken}`,
        },
        body: form,
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { ok: false, error: text };
      }
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
      }
      if (
        data?.ok !== true ||
        !Array.isArray(data.saved) ||
        data.saved.length !== files.length ||
        (Array.isArray(data.errors) && data.errors.length > 0)
      ) {
        const message = Array.isArray(data?.errors) && data.errors.length
          ? data.errors.join("; ")
          : "attachment was not saved";
        throw new Error(message);
      }
      return data;
    },
  };
}

export type FeedbackClient = ReturnType<typeof createClient>;
