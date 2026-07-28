/**
 * Amp Feedback Workbench plugin — Pi-parity claim flow for hono_feedback_duck.
 *
 * Load:
 *   project: .amp/plugins/feedback-workbench.ts (re-exports this module)
 *   or: ln -sfn <repo>/amp-feedback-workbench/src/plugin.ts ~/.config/amp/plugins/feedback-workbench.ts
 *   then: plugins: reload
 *
 * Commands (palette category "feedback"):
 *   fb-config / fb-config-show / fb / fb-open / fb-next / fb-mine
 *
 * Tools (LLM):
 *   feedback_list, feedback_get, feedback_claim, feedback_start_processing,
 *   feedback_submit_for_review, feedback_add_comment, feedback_add_ai_analysis,
 *   feedback_add_link
 */
import type { PluginAPI } from "@ampcode/plugin";
import {
  actorFromConfig,
  loadConfig,
  requireConfig,
  saveProjectConfig,
  summarizeConfig,
} from "./config.ts";
import { createClient, type FeedbackClient } from "./client.ts";
import {
  downloadAttachments,
  formatAttachmentPathsBlock,
} from "./attachments.ts";
import {
  buildInjectMessage,
  displayNo,
  formatListLabel,
  parseIdArg,
} from "./format.ts";
import type {
  AgentConfig,
  FeedbackItem,
  FeedbackLink,
  FeedbackStatus,
} from "./types.ts";

let currentClaimedFeedbackId: number | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toolText(text: string) {
  return text;
}

async function injectIntoThread(
  amp: PluginAPI,
  ctx: { thread?: { append: (msgs: any[]) => Promise<void>; id?: string } | undefined; ui: any },
  text: string,
): Promise<void> {
  if (ctx.thread && typeof ctx.thread.append === "function") {
    await ctx.thread.append([{ type: "user-message", content: text }]);
    return;
  }

  const active = amp.activeThread?.current;
  if (active?.id && amp.threads?.get) {
    await amp.threads.get(active.id).appendUserMessage(
      { type: "user-message", content: text },
      { steer: true },
    );
    return;
  }

  await ctx.ui.notify(
    "No active thread. Send any message to create one, then re-run the feedback command (or use tools).",
  );
}

async function claimAndInject(
  amp: PluginAPI,
  ctx: any,
  client: FeedbackClient,
  config: AgentConfig,
  item: FeedbackItem,
  options: { sourceCommand: string },
): Promise<void> {
  const actor = actorFromConfig(config);
  let working = item;
  let claimRound: number | null = item.claim_count ?? null;
  let events: Awaited<ReturnType<typeof client.getFeedback>>["events"] = [];

  await ctx.ui.notify?.(`Claiming #${displayNo(item)}…`);
  const claimed = await client.claim(
    item.id,
    actor,
    `Claimed via Amp ${options.sourceCommand}`,
  );
  working = claimed.item;
  claimRound = claimed.event?.claim_round ?? working.claim_count ?? null;
  events = claimed.events || [];

  try {
    const detail = await client.getFeedback(working.id);
    working = {
      ...detail.item,
      screenshot_url:
        detail.item.screenshot_url ??
        detail.screenshot_url ??
        working.screenshot_url,
      attachments:
        detail.attachments ||
        detail.item.attachments ||
        working.attachments ||
        [],
    };
    events = detail.events || events;
  } catch {
    // keep claimed payload
  }

  let extraPrompt = "";
  try {
    if (typeof ctx.ui.input === "function") {
      const value = await ctx.ui.input({
        title: "Optional extra instructions",
        helpText: "Empty to skip",
        initialValue: "",
        submitButtonText: "Continue",
      });
      extraPrompt = (value || "").trim();
    }
  } catch {
    // optional
  }

  const cwd = config.cwd || process.cwd();
  let attachmentBlock = "";
  try {
    const resolved = await downloadAttachments(config, working, cwd);
    attachmentBlock = formatAttachmentPathsBlock(resolved.files);
    if (resolved.notes.length) {
      attachmentBlock +=
        "\nAttachment notes:\n- " + resolved.notes.join("\n- ") + "\n";
    }
  } catch (err) {
    await ctx.ui.notify?.(`Attachment download skipped: ${errMsg(err)}`);
  }

  const text =
    buildInjectMessage(working, {
      projectSlug: config.projectSlug,
      claimRound,
      extraPrompt,
      events,
    }) + attachmentBlock;

  await injectIntoThread(amp, ctx, text);
  currentClaimedFeedbackId = working.id;

  await ctx.ui.notify?.(
    `Feedback #${displayNo(working)} claimed & injected (status=${working.status}, claims=${
      working.claim_count ?? "?"
    })`,
  );
}

function defaultListFilter(config: AgentConfig) {
  return {
    project_id: config.projectId ?? undefined,
    limit: 50,
  };
}

function resolveId(input: Record<string, unknown>): number {
  const raw = input.id ?? input.feedback_id;
  const id = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("id must be a positive integer (internal feedback id)");
  }
  return id;
}

export default function feedbackWorkbenchPlugin(amp: PluginAPI) {
  amp.logger?.log?.("[feedback-workbench] plugin initialized");

  // --- Commands (Pi: /fb-config, /fb, /fb-open, /fb-next, /fb-mine) ---

  amp.registerCommand(
    "fb-config-show",
    {
      title: "Show config",
      category: "feedback",
      description: "Show resolved feedback workbench config (token masked)",
    },
    async (ctx) => {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        await ctx.ui.notify(summarizeConfig(config));
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-config",
    {
      title: "Configure workbench",
      category: "feedback",
      description:
        "Save Personal Token + baseUrl to .amp/feedback-workbench.json",
    },
    async (ctx) => {
      try {
        const current = loadConfig({ cwd: process.cwd() });
        const baseUrl =
          (await ctx.ui.input({
            title: "baseUrl",
            helpText: "hono_feedback_duck base URL",
            initialValue: current.baseUrl,
            submitButtonText: "Next",
          })) || current.baseUrl;

        const agentToken =
          (await ctx.ui.input({
            title: "Personal Token",
            helpText: "Personal Token for claim/actions (not Project Token)",
            initialValue: current.agentToken || "",
            submitButtonText: "Next",
          })) || current.agentToken;

        const projectIdRaw = await ctx.ui.input({
          title: "projectId (optional)",
          helpText: "Filter lists by project id",
          initialValue:
            current.projectId != null ? String(current.projectId) : "",
          submitButtonText: "Next",
        });

        const projectSlug =
          (await ctx.ui.input({
            title: "projectSlug (optional)",
            initialValue: current.projectSlug || "",
            submitButtonText: "Next",
          })) || current.projectSlug || undefined;

        const actorName =
          (await ctx.ui.input({
            title: "actorName",
            initialValue: current.actorName,
            submitButtonText: "Save",
          })) || current.actorName;

        const path = saveProjectConfig(process.cwd(), {
          baseUrl,
          agentToken,
          projectId: projectIdRaw?.trim() || null,
          projectSlug: projectSlug || null,
          actorId: current.actorId || "local-amp",
          actorName,
        });

        await ctx.ui.notify(
          `Saved ${path}\n${summarizeConfig(loadConfig({ cwd: process.cwd() }))}`,
        );
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb",
    {
      title: "Pick & claim feedback",
      category: "feedback",
      description:
        "List feedback, pick one, claim, and inject into the current thread",
    },
    async (ctx) => {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);

        const statusChoice = await ctx.ui.select({
          title: "Filter status",
          message: "Which queue?",
          options: [
            "pending",
            "claimed",
            "in_progress",
            "in_review",
            "all (no status filter)",
            "cancel",
          ],
        });
        if (!statusChoice || statusChoice === "cancel") {
          await ctx.ui.notify("Cancelled");
          return;
        }

        const status =
          statusChoice.startsWith("all")
            ? undefined
            : (statusChoice as FeedbackStatus);

        const items = await client.listFeedback({
          ...defaultListFilter(config),
          ...(status ? { status } : {}),
        });

        if (!items.length) {
          await ctx.ui.notify(
            status
              ? `No feedback with status=${status}`
              : "No feedback found. Check feedback: Configure workbench.",
          );
          return;
        }

        const ordered = [...items].sort((a, b) =>
          a.inserted_at.localeCompare(b.inserted_at),
        );
        const labels = ordered.map((it) => formatListLabel(it));
        labels.push("cancel");
        const pickedLabel = await ctx.ui.select({
          title: `Feedback · ${config.projectSlug || config.projectId || "project"}`,
          message: "Select an issue to claim",
          options: labels,
        });
        if (!pickedLabel || pickedLabel === "cancel") {
          await ctx.ui.notify("Cancelled");
          return;
        }
        const idx = labels.indexOf(pickedLabel);
        const item = ordered[idx];
        if (!item) {
          await ctx.ui.notify("Invalid selection");
          return;
        }

        await claimAndInject(amp, ctx, client, config, item, {
          sourceCommand: "fb",
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-open",
    {
      title: "Open & claim by id",
      category: "feedback",
      description: "Claim a feedback by internal id and inject",
    },
    async (ctx) => {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const raw = await ctx.ui.input({
          title: "Feedback id",
          helpText: "Internal numeric id",
          submitButtonText: "Claim",
        });
        const id = parseIdArg(raw || "");
        if (!id) {
          await ctx.ui.notify("Usage: enter a positive numeric id");
          return;
        }
        const detail = await client.getFeedback(id);
        await claimAndInject(amp, ctx, client, config, detail.item, {
          sourceCommand: "fb-open",
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-next",
    {
      title: "Claim next pending",
      category: "feedback",
      description: "Claim oldest pending feedback and inject into thread",
    },
    async (ctx) => {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const items = await client.listFeedback({
          ...defaultListFilter(config),
          status: "pending",
          limit: 10,
        });
        if (!items.length) {
          await ctx.ui.notify("No pending feedback");
          return;
        }
        const ordered = [...items].sort((a, b) =>
          a.inserted_at.localeCompare(b.inserted_at),
        );
        await claimAndInject(amp, ctx, client, config, ordered[0]!, {
          sourceCommand: "fb-next",
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-mine",
    {
      title: "List my claimed items",
      category: "feedback",
      description: "List feedback assigned to this actor; optionally re-inject",
    },
    async (ctx) => {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const assignee = config.actorName;
        const items = await client.listFeedback({
          ...defaultListFilter(config),
          assignee,
          limit: 50,
        });
        if (!items.length) {
          await ctx.ui.notify(`No items assigned to ${assignee}`);
          return;
        }
        const labels = items.map((it) => formatListLabel(it));
        labels.push("done (close)");
        const picked = await ctx.ui.select({
          title: "My feedback",
          message: "Select to re-claim + inject, or close",
          options: labels,
        });
        if (!picked || picked.startsWith("done")) {
          await ctx.ui.notify(
            items.map((it) => formatListLabel(it)).join("\n"),
          );
          return;
        }
        const idx = labels.indexOf(picked);
        const item = items[idx];
        if (!item) return;
        await claimAndInject(amp, ctx, client, config, item, {
          sourceCommand: "fb-mine",
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  // --- Tools (Pi parity) ---

  amp.registerTool({
    name: "feedback_list",
    description:
      "List feedback issues from hono_feedback_duck (filters: status, assignee, q, limit).",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description:
            "pending|claimed|in_progress|in_review|done|canceled",
        },
        assignee: { type: "string", description: "Filter by assignee label" },
        q: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max items (default 20)" },
        project_id: {
          type: "string",
          description: "Optional project id override",
        },
      },
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const items = await client.listFeedback({
          status: typeof input.status === "string" ? input.status : undefined,
          assignee:
            typeof input.assignee === "string" ? input.assignee : undefined,
          q: typeof input.q === "string" ? input.q : undefined,
          limit:
            typeof input.limit === "number"
              ? input.limit
              : Number(input.limit) || 20,
          project_id:
            typeof input.project_id === "string" ||
            typeof input.project_id === "number"
              ? input.project_id
              : config.projectId ?? undefined,
        });
        return toolText(
          JSON.stringify(
            {
              ok: true,
              count: items.length,
              items: items.map((it) => ({
                id: it.id,
                project_seq: it.project_seq,
                status: it.status,
                title: it.title,
                feedback_type: it.feedback_type,
                priority: it.priority,
                current_assignee: it.current_assignee,
                claim_count: it.claim_count,
                note: (it.note || "").slice(0, 200),
              })),
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_get",
    description:
      "Get feedback detail + events + attachments by internal id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Internal feedback id" },
      },
      required: ["id"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const id = resolveId(input);
        const detail = await client.getFeedback(id);
        return toolText(JSON.stringify({ ok: true, ...detail }, null, 2));
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_claim",
    description:
      "Claim a feedback issue (or re-claim). Prefer claiming before coding.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Internal feedback id" },
        note: { type: "string", description: "Optional claim note" },
      },
      required: ["id"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const actor = actorFromConfig(config);
        const id = resolveId(input);
        const note =
          typeof input.note === "string" && input.note.trim()
            ? input.note
            : "Claimed via Amp feedback_claim tool";
        const result = await client.claim(id, actor, note);
        currentClaimedFeedbackId = result.item.id;
        return toolText(
          JSON.stringify(
            {
              ok: true,
              action: "claim",
              item: result.item,
              event: result.event,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_start_processing",
    description: "Transition claimed → in_progress.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        note: { type: "string" },
      },
      required: ["id"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const actor = actorFromConfig(config);
        const id = resolveId(input);
        const note = typeof input.note === "string" ? input.note : undefined;
        const result = await client.startProcessing(id, actor, note);
        return toolText(
          JSON.stringify({ ok: true, action: "start_processing", item: result.item }, null, 2),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_submit_for_review",
    description:
      "Submit fix for human verification → in_review. Requires summary note. Never marks done.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        note: {
          type: "string",
          description: "Required delivery summary (what changed, PR/commit links)",
        },
      },
      required: ["id", "note"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const actor = actorFromConfig(config);
        const id = resolveId(input);
        const note = typeof input.note === "string" ? input.note.trim() : "";
        if (!note) return toolText("Error: note is required for submit_for_review");
        const result = await client.submitForReview(id, actor, note);
        return toolText(
          JSON.stringify(
            { ok: true, action: "submit_for_review", item: result.item },
            null,
            2,
          ),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_comment",
    description: "Add a comment event on a feedback issue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        note: { type: "string" },
      },
      required: ["id", "note"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const actor = actorFromConfig(config);
        const id = resolveId(input);
        const note = typeof input.note === "string" ? input.note : "";
        if (!note.trim()) return toolText("Error: note required");
        const result = await client.addComment(id, actor, note);
        return toolText(JSON.stringify({ ok: true, action: "comment", raw: result }, null, 2));
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_ai_analysis",
    description: "Write an AI analysis event on a feedback issue.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        analysis: { type: "string", description: "Analysis text" },
      },
      required: ["id", "analysis"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const actor = actorFromConfig(config);
        const id = resolveId(input);
        const analysis =
          typeof input.analysis === "string" ? input.analysis : "";
        if (!analysis.trim()) return toolText("Error: analysis required");
        const result = await client.addAiAnalysis(id, actor, analysis);
        return toolText(
          JSON.stringify({ ok: true, action: "ai_analysis", raw: result }, null, 2),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_link",
    description:
      "Attach a delivery link (pr|commit|branch|url) to the issue via PATCH.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        kind: {
          type: "string",
          description: "pr | commit | branch | url",
        },
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "kind", "url"],
    },
    async execute(input) {
      try {
        const config = loadConfig({ cwd: process.cwd() });
        requireConfig(config);
        const client = createClient(config);
        const id = resolveId(input);
        const kind = String(input.kind || "url") as FeedbackLink["kind"];
        const url = String(input.url || "");
        const title =
          typeof input.title === "string" ? input.title : undefined;
        if (!url) return toolText("Error: url required");
        const detail = await client.getFeedback(id);
        const existing = Array.isArray(detail.item.links)
          ? [...detail.item.links]
          : [];
        const link: FeedbackLink = { kind, url, title: title ?? null };
        const without = existing.filter(
          (l) => !(l.kind === kind && l.url === url),
        );
        without.push(link);
        const patched = await client.patchFeedback(id, { links: without });
        return toolText(
          JSON.stringify({ ok: true, action: "add_link", result: patched }, null, 2),
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_current_claimed_id",
    description:
      "Return the feedback id most recently claimed in this Amp session (if any).",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return toolText(
        JSON.stringify(
          { ok: true, currentClaimedFeedbackId },
          null,
          2,
        ),
      );
    },
  });
}
