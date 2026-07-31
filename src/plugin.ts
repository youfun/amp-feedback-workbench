import type {
  PluginAPI,
  PluginCommandContext,
  PluginThread,
  ThreadID,
  ToolCallEvent,
  ToolResultEvent,
} from "@ampcode/plugin";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  actorFromConfig,
  loadConfig,
  requireConfig,
  saveProjectConfig,
  summarizeConfig,
} from "./config.js";
import { createClient, type FeedbackClient } from "./client.js";
import { buildLinkFromParams, mergeLinks, parseLinksParam } from "./delivery.js";
import { buildInjectMessage, displayNo, formatListLabel, parseIdArg } from "./format.js";
import { downloadAttachments, formatAttachmentPathsBlock } from "./image.js";
import { toRepoRelativePath } from "./progress-sync.js";
import { ThreadStateStore } from "./state.js";
import type { AgentConfig, FeedbackItem, FeedbackStatus, ProjectRelease } from "./types.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toolText(text: string): string {
  return text;
}

function objectSchema(properties: Record<string, object>, required: string[] = []) {
  return {
    type: "object" as const,
    properties,
    required,
    additionalProperties: false,
  };
}

function str(description: string) {
  return { type: "string", description };
}

function num(description: string) {
  return { type: "number", description };
}

function bool(description: string) {
  return { type: "boolean", description };
}

function resolveId(input: Record<string, unknown>): number {
  const raw = input.id ?? input.feedback_id;
  const id = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("id must be a positive integer (internal feedback id)");
  }
  return id;
}

function defaultListFilter(config: AgentConfig) {
  return {
    project_id: config.projectId ?? undefined,
    limit: 50,
  };
}

function workspaceRootPath(amp: PluginAPI): string | undefined {
  return amp.system.workspaceRoot
    ? amp.helpers.filePathFromURI(amp.system.workspaceRoot)
    : undefined;
}

function commandThreadId(amp: PluginAPI, ctx: PluginCommandContext): ThreadID | undefined {
  return ctx.thread?.id || amp.activeThread.current?.id;
}

function currentAgentSessionMeta(threadId?: ThreadID): Record<string, unknown> {
  if (!threadId) return {};
  return {
    amp_thread_id: threadId,
    agent_session: {
      agent_type: "amp_agent",
      session_id: threadId,
      amp_thread_id: threadId,
    },
  };
}

function currentClaimedId(
  stateStore: ThreadStateStore,
  threadId?: ThreadID,
): number | null {
  return threadId ? stateStore.get(threadId).claimedId() : null;
}

function requireClaimedId(
  stateStore: ThreadStateStore,
  input: Record<string, unknown>,
  threadId?: ThreadID,
): number {
  if (input.id !== undefined && input.id !== null && input.id !== "") {
    return resolveId(input);
  }
  const claimed = currentClaimedId(stateStore, threadId);
  if (!claimed) {
    throw new Error("No feedback id provided and no currently claimed feedback for this thread.");
  }
  return claimed;
}

async function injectIntoThread(
  thread: PluginThread,
  text: string,
): Promise<void> {
  await thread.appendUserMessage(
    { type: "user-message", content: text },
    { steer: true },
  );
}

async function resolveWorkspaceUploadPath(amp: PluginAPI, inputPath: string): Promise<string> {
  const workspace = workspaceRootPath(amp);
  if (!workspace) throw new Error("Cannot upload files without an open workspace.");
  const realWorkspace = await realpath(workspace);
  const candidate = isAbsolute(inputPath) ? inputPath : resolve(realWorkspace, inputPath);
  const realCandidate = await realpath(candidate);
  const rel = relative(realWorkspace, realCandidate);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Attachment path must stay inside the open workspace.");
  }
  const fileStat = await stat(realCandidate);
  if (!fileStat.isFile()) throw new Error("Attachment path must be a regular file.");
  if (fileStat.size > 5 * 1024 * 1024) throw new Error("file_too_large (max 5MB)");
  return realCandidate;
}

async function maybeExtraPrompt(ctx: PluginCommandContext): Promise<string> {
  try {
    return (
      (await ctx.ui.input({
        title: "Optional extra instructions",
        helpText: "Empty to skip",
        initialValue: "",
        submitButtonText: "Continue",
      })) || ""
    ).trim();
  } catch {
    return "";
  }
}

function releaseProjectId(config: AgentConfig, raw?: unknown): number | string {
  const value = raw == null || raw === "" ? config.projectId : raw;
  if (value == null || value === "") {
    throw new Error("project_id is required; configure it with fb-config");
  }
  return typeof value === "number" ? value : String(value);
}

async function resolveRelease(
  client: FeedbackClient,
  projectId: number | string,
  opts: { releaseId?: unknown; version?: unknown; allowOnlyDraft?: boolean },
) {
  const releaseId = Number(opts.releaseId);
  if (Number.isInteger(releaseId) && releaseId > 0) {
    return client.getRelease(projectId, releaseId);
  }
  const version = String(opts.version || "").trim();
  if (version) {
    const detail = await client.getReleaseByVersion(projectId, version);
    if (opts.allowOnlyDraft && detail.release.status !== "draft") {
      throw new Error(`Release ${detail.release.version} is already published`);
    }
    return detail;
  }
  const releases = await client.listReleases({
    projectId,
    status: opts.allowOnlyDraft ? "draft" : undefined,
    limit: 100,
  });
  let release: ProjectRelease | undefined;
  if (opts.allowOnlyDraft) {
    if (releases.length === 0) throw new Error("No draft release exists");
    if (releases.length > 1) {
      throw new Error("ambiguous_draft: specify release_id or version");
    }
    release = releases[0];
  } else {
    throw new Error("release_id or version is required");
  }
  return client.getRelease(projectId, release.id);
}

async function claimAndInject(
  amp: PluginAPI,
  ctx: PluginCommandContext,
  stateStore: ThreadStateStore,
  client: FeedbackClient,
  config: AgentConfig,
  item: FeedbackItem,
  options: { sourceCommand: string },
): Promise<void> {
  const targetThread = ctx.thread ?? (
    amp.activeThread.current?.id
      ? amp.threads.get(amp.activeThread.current.id)
      : undefined
  );
  if (!targetThread) {
    await ctx.ui.notify(
      "No active thread. Send any message to create one, then re-run the feedback command.",
    );
    return;
  }
  const requestedThreadId = targetThread.id;
  const actor = actorFromConfig(config);
  let working = item;
  let claimRound: number | null = item.claim_count ?? null;
  let events: Awaited<ReturnType<typeof client.getFeedback>>["events"] = [];

  await ctx.ui.notify(`Claiming #${displayNo(item)}…`);
  const claimed = await client.claim(
    item.id,
    actor,
    `Claimed via Amp ${options.sourceCommand}`,
    currentAgentSessionMeta(requestedThreadId),
  );
  working = claimed.item;
  claimRound = claimed.event?.claim_round ?? working.claim_count ?? null;
  events = claimed.events || [];

  try {
    const detail = await client.getFeedback(working.id);
    working = {
      ...detail.item,
      screenshot_url:
        detail.item.screenshot_url ?? detail.screenshot_url ?? working.screenshot_url,
      attachments: detail.attachments || detail.item.attachments || working.attachments || [],
    };
    events = detail.events || events;
  } catch {
    // keep claimed payload
  }

  const extraPrompt = await maybeExtraPrompt(ctx);
  let text = buildInjectMessage(working, {
    projectSlug: config.projectSlug,
    claimRound,
    extraPrompt,
    events,
  });

  try {
    const cwd = workspaceRootPath(amp) || config.cwd || process.cwd();
    const resolved = await downloadAttachments(config, working, cwd);
    text += formatAttachmentPathsBlock(resolved.files);
    if (resolved.notes.length) {
      text += `\nAttachment notes:\n- ${resolved.notes.join("\n- ")}\n`;
    }
  } catch (err) {
    await ctx.ui.notify(`Attachment download skipped: ${errMsg(err)}`);
  }

  await injectIntoThread(targetThread, text);
  stateStore.get(requestedThreadId).setClaimed(working.id);

  await ctx.ui.notify(
    `Feedback #${displayNo(working)} claimed & injected (status=${working.status}, claims=${working.claim_count ?? "?"})`,
  );
}

async function withConfig<T>(
  fn: (config: AgentConfig, client: FeedbackClient) => Promise<T>,
  options: { requireAgentToken?: boolean } = {},
): Promise<T> {
  const config = loadConfig({ cwd: process.cwd() });
  if (options.requireAgentToken !== false) requireConfig(config);
  return fn(config, createClient(config));
}

export default function feedbackWorkbenchPlugin(amp: PluginAPI) {
  const stateStore = new ThreadStateStore();
  const toolClaims = new Map<
    string,
    { threadId: ThreadID; claimedId: number; generation: number }
  >();
  amp.logger.log("[feedback-workbench] plugin initialized");

  amp.on("tool.call", (event: ToolCallEvent) => {
    const state = stateStore.maybe(event.thread.id);
    const claimedId = state?.claimedId();
    if (state && claimedId != null && state.isEnabled()) {
      toolClaims.set(event.toolUseID, {
        threadId: event.thread.id,
        claimedId,
        generation: state.claimGeneration(),
      });
    }
    return { action: "allow" };
  });

  amp.on("tool.result", async (event: ToolResultEvent) => {
    const toolClaim = toolClaims.get(event.toolUseID);
    toolClaims.delete(event.toolUseID);
    if (event.status !== "done") return;
    const threadId = event.thread.id;
    const state = stateStore.maybe(threadId);
    if (
      !state ||
      !toolClaim ||
      toolClaim.threadId !== threadId ||
      !state.isEnabled() ||
      !state.matchesClaim(toolClaim.claimedId, toolClaim.generation)
    ) return;

    const uris = amp.helpers.filesModifiedByToolCall(event);
    if (!uris || uris.length === 0) return;

    try {
      const config = loadConfig({ cwd: process.cwd() });
      requireConfig(config);
      const client = createClient(config);
      const actor = actorFromConfig(config);
      const root = workspaceRootPath(amp) || process.cwd();
      const files = uris
        .map((uri) => amp.helpers.filePathFromURI(uri))
        .map((path) => toRepoRelativePath(path, root));
      await state.recordAndCommentFiles({
        toolName: event.tool,
        filePaths: files,
        client,
        actor,
        source: "tool.result",
        cwd: root,
        meta: currentAgentSessionMeta(threadId),
        expectedClaim: {
          id: toolClaim.claimedId,
          generation: toolClaim.generation,
        },
      });
    } catch (err) {
      amp.logger.log("[feedback-workbench] progress sync skipped", errMsg(err));
    }
  });

  amp.onDispose(() => {
    toolClaims.clear();
    stateStore.clear();
  });

  amp.registerCommand(
    "fb-config-show",
    {
      title: "Show config",
      category: "feedback",
      description: "Show resolved feedback workbench config (tokens masked)",
    },
    async (ctx) => {
      await ctx.ui.notify(summarizeConfig(loadConfig({ cwd: process.cwd() })));
    },
  );

  amp.registerCommand(
    "fb-config",
    {
      title: "Configure workbench",
      category: "feedback",
      description: "Save Personal Token + Project submit token to .amp/feedback-workbench.json",
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
            helpText: "Used for claim/actions/comments; never used for submission",
            initialValue: current.agentToken || "",
            submitButtonText: "Next",
          })) || current.agentToken;
        const submitToken =
          (await ctx.ui.input({
            title: "Project Submit Token",
            helpText: "Used only for feedback_submit / fb-submit",
            initialValue: current.submitToken || "",
            submitButtonText: "Next",
          })) || current.submitToken;
        const projectIdRaw = await ctx.ui.input({
          title: "projectId (optional)",
          helpText: "Filter lists by project id",
          initialValue: current.projectId != null ? String(current.projectId) : "",
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
          submitToken,
          projectId: projectIdRaw?.trim() || null,
          projectSlug: projectSlug || null,
          actorId: current.actorId || "local-amp",
          actorName,
        });

        await ctx.ui.notify(`Saved ${path}\n${summarizeConfig(loadConfig({ cwd: process.cwd() }))}`);
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
      description: "List feedback, pick one, claim, and inject into the current thread",
    },
    async (ctx) => {
      try {
        await withConfig(async (config, client) => {
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
          if (!statusChoice || statusChoice === "cancel") return;
          const status =
            statusChoice.startsWith("all") ? undefined : (statusChoice as FeedbackStatus);
          const items = await client.listFeedback({
            ...defaultListFilter(config),
            ...(status ? { status } : {}),
          });
          if (!items.length) {
            await ctx.ui.notify(status ? `No feedback with status=${status}` : "No feedback found.");
            return;
          }
          const ordered = [...items].sort((a, b) => a.inserted_at.localeCompare(b.inserted_at));
          const labels = [...ordered.map((item) => formatListLabel(item)), "cancel"];
          const picked = await ctx.ui.select({
            title: `Feedback · ${config.projectSlug || config.projectId || "project"}`,
            message: "Select an issue to claim",
            options: labels,
          });
          if (!picked || picked === "cancel") return;
          const item = ordered[labels.indexOf(picked)];
          if (!item) throw new Error("Invalid selection");
          await claimAndInject(amp, ctx, stateStore, client, config, item, { sourceCommand: "fb" });
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
        await withConfig(async (config, client) => {
          const raw = await ctx.ui.input({
            title: "Feedback id",
            helpText: "Internal numeric id",
            submitButtonText: "Claim",
          });
          const id = parseIdArg(raw || "");
          if (!id) {
            await ctx.ui.notify("Enter a positive numeric id.");
            return;
          }
          const detail = await client.getFeedback(id);
          await claimAndInject(amp, ctx, stateStore, client, config, detail.item, {
            sourceCommand: "fb-open",
          });
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
        await withConfig(async (config, client) => {
          const items = await client.listFeedback({
            ...defaultListFilter(config),
            status: "pending",
            limit: 10,
          });
          if (!items.length) {
            await ctx.ui.notify("No pending feedback");
            return;
          }
          const ordered = [...items].sort((a, b) => a.inserted_at.localeCompare(b.inserted_at));
          await claimAndInject(amp, ctx, stateStore, client, config, ordered[0]!, {
            sourceCommand: "fb-next",
          });
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
        await withConfig(async (config, client) => {
          const items = await client.listFeedback({
            ...defaultListFilter(config),
            assignee: config.actorName,
            limit: 50,
          });
          if (!items.length) {
            await ctx.ui.notify(`No items assigned to ${config.actorName}`);
            return;
          }
          const labels = [...items.map((item) => formatListLabel(item)), "done (close)"];
          const picked = await ctx.ui.select({
            title: "My feedback",
            message: "Select to re-claim + inject, or close",
            options: labels,
          });
          if (!picked || picked.startsWith("done")) {
            await ctx.ui.notify(items.map((item) => formatListLabel(item)).join("\n"));
            return;
          }
          const item = items[labels.indexOf(picked)];
          if (!item) return;
          await claimAndInject(amp, ctx, stateStore, client, config, item, {
            sourceCommand: "fb-mine",
          });
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-submit",
    {
      title: "Submit new feedback",
      category: "feedback",
      description: "Create a new feedback item using the configured submit token",
    },
    async (ctx) => {
      try {
        await withConfig(
          async (_config, client) => {
            const note = (
              await ctx.ui.input({
                title: "Feedback note",
                helpText: "Required issue description",
                submitButtonText: "Next",
              })
            )?.trim();
            if (!note) {
              await ctx.ui.notify("Feedback note is required.");
              return;
            }
            const title = (await ctx.ui.input({ title: "Optional title", submitButtonText: "Next" })) || undefined;
            const feedbackType =
              (await ctx.ui.select({
                title: "Feedback type",
                options: ["bug", "feature", "other"],
                initialValue: "bug",
              })) || "bug";
            const result = await client.submitFeedback({
              note,
              title,
              feedbackType,
              meta: currentAgentSessionMeta(commandThreadId(amp, ctx)),
            });
            await ctx.ui.notify(
              `Created feedback #${result.id} in project ${result.project_slug}${result.admin_url ? ` · ${result.admin_url}` : ""}`,
            );
          },
          { requireAgentToken: false },
        );
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerCommand(
    "fb-progress",
    {
      title: "Progress sync",
      category: "feedback",
      description: "Show or change thread-scoped progress sync settings",
    },
    async (ctx) => {
      const threadId = commandThreadId(amp, ctx);
      if (!threadId) {
        await ctx.ui.notify("No active thread.");
        return;
      }
      const state = stateStore.get(threadId);
      const action = await ctx.ui.select({
        title: "Progress sync",
        options: ["status", "on", "off", "clear"],
      });
      if (!action) return;
      if (action === "status") {
        await ctx.ui.notify(
          [
            `thread: ${threadId}`,
            `enabled: ${state.isEnabled()}`,
            `claimedId: ${state.claimedId() ?? "(none)"}`,
            `changedFiles: ${state.changedFiles().length}`,
            ...state.changedFiles().map((file) => `- ${file}`),
          ].join("\n"),
        );
        return;
      }
      if (action === "on") state.setEnabled(true);
      if (action === "off") state.setEnabled(false);
      if (action === "clear") state.clearChangedFiles();
      await ctx.ui.notify(
        action === "clear"
          ? `Cleared recorded changed files for ${threadId}.`
          : `Progress sync ${action} for ${threadId}.`,
      );
    },
  );

  amp.registerCommand(
    "fb-release",
    {
      title: "Release workflow",
      category: "feedback",
      description: "Interactive release listing/staging/changelog flow",
    },
    async (ctx) => {
      try {
        await withConfig(async (config, client) => {
          const projectId = releaseProjectId(config);
          const action = await ctx.ui.select({
            title: "Release workflow",
            options: [
              "list drafts",
              "list published",
              "create draft",
              "stage current claimed",
              "draft changelog preview",
              "draft changelog apply",
              "publish guidance",
            ],
          });
          if (!action) return;
          if (action === "list drafts" || action === "list published") {
            const status = action === "list drafts" ? "draft" : "published";
            const releases = await client.listReleases({ projectId, status, limit: 20 });
            await ctx.ui.notify(
              releases.length
                ? releases.map((release) => `#${release.id} ${release.version} [${release.status}] rev=${release.revision}`).join("\n")
                : `No ${status} releases.`,
            );
            return;
          }
          if (action === "create draft") {
            const version = (await ctx.ui.input({ title: "Version", submitButtonText: "Create" }))?.trim();
            if (!version) return;
            const title = (await ctx.ui.input({ title: "Optional title", submitButtonText: "Create" })) || undefined;
            const result = await client.createRelease(projectId, { version, title });
            await ctx.ui.notify(`Created draft ${result.release.version} (#${result.release.id}).`);
            return;
          }
          if (action === "stage current claimed") {
            const threadId = commandThreadId(amp, ctx);
            const feedbackId = currentClaimedId(stateStore, threadId);
            if (!feedbackId) throw new Error("No current claimed feedback in this thread.");
            const version = await ctx.ui.input({
              title: "Release version (optional if only one draft)",
              submitButtonText: "Stage",
            });
            const detail = await resolveRelease(client, projectId, {
              version,
              allowOnlyDraft: true,
            });
            const result = await client.addReleaseItems(projectId, detail.release.id, {
              feedback_ids: [feedbackId],
              expected_revision: detail.release.revision,
            });
            await ctx.ui.notify(`Staged feedback #${feedbackId} in ${result.release.version}.`);
            return;
          }
          if (action === "draft changelog preview" || action === "draft changelog apply") {
            const version = await ctx.ui.input({
              title: "Release version (optional if only one draft)",
              submitButtonText: "Continue",
            });
            const detail = await resolveRelease(client, projectId, {
              version,
              allowOnlyDraft: true,
            });
            const apply = action === "draft changelog apply";
            const result = await client.draftReleaseChangelog(projectId, detail.release.id, {
              apply,
              ...(apply ? { expected_revision: detail.release.revision } : {}),
            });
            await ctx.ui.notify(`${apply ? "Applied" : "Preview"} changelog for ${detail.release.version}:\n${result.notes_md}`);
            return;
          }
          await ctx.ui.notify(
            "Release publishing is human-only. Open the draft in the Web UI and publish there.",
          );
        });
      } catch (err) {
        await ctx.ui.notify(errMsg(err));
      }
    },
  );

  amp.registerTool({
    name: "feedback_list",
    description: "List feedback issues from hono_feedback_duck (filters: status, assignee, q, limit).",
    inputSchema: objectSchema({
      status: str("pending|claimed|in_progress|in_review|done|canceled"),
      assignee: str("Filter by assignee label"),
      q: str("Search query"),
      limit: num("Max items (default 20)"),
      project_id: str("Optional project id override"),
    }),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          const items = await client.listFeedback({
            status: typeof input.status === "string" ? input.status : undefined,
            assignee: typeof input.assignee === "string" ? input.assignee : undefined,
            q: typeof input.q === "string" ? input.q : undefined,
            limit: typeof input.limit === "number" ? input.limit : Number(input.limit) || 20,
            project_id:
              typeof input.project_id === "string" || typeof input.project_id === "number"
                ? input.project_id
                : config.projectId ?? undefined,
          });
          return toolText(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_get",
    description: "Get feedback detail + events + attachments by internal id.",
    inputSchema: objectSchema({ id: num("Internal feedback id") }, ["id"]),
    async execute(input) {
      try {
        return await withConfig(async (_config, client) => {
          const detail = await client.getFeedback(resolveId(input));
          return toolText(JSON.stringify({ ok: true, ...detail }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_claim",
    description: "Claim a feedback item. Sets the current claim only for the invoking Amp thread.",
    inputSchema: objectSchema({ id: num("Feedback id"), note: str("Optional claim note") }, ["id"]),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const id = resolveId(input);
          const note =
            typeof input.note === "string" && input.note.trim()
              ? input.note
              : "Claimed via Amp feedback_claim tool";
          const result = await client.claim(
            id,
            actorFromConfig(config),
            note,
            currentAgentSessionMeta(ctx.thread.id),
          );
          stateStore.get(ctx.thread.id).setClaimed(result.item.id);
          return toolText(JSON.stringify({ ok: true, action: "claim", item: result.item, event: result.event }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_start_processing",
    description: "Mark feedback as in_progress. Includes the current Amp thread ID in action metadata.",
    inputSchema: objectSchema({ id: num("Feedback id"), note: str("Optional note") }, ["id"]),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const result = await client.startProcessing(
            resolveId(input),
            actorFromConfig(config),
            typeof input.note === "string" ? input.note : undefined,
            currentAgentSessionMeta(ctx.thread.id),
          );
          return toolText(JSON.stringify({ ok: true, action: "start_processing", item: result.item }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_submit_for_review",
    description:
      "Submit delivered work for human verification (status → in_review). Requires note. If id is omitted, uses this thread's current claimed feedback. Optional links are merged before submit. Never publishes or marks done.",
    inputSchema: objectSchema(
      {
        id: num("Feedback id (optional; defaults to current claimed feedback in this thread)"),
        note: str("Required delivery summary"),
        links: {
          oneOf: [{ type: "string" }, { type: "array" }, { type: "object" }],
          description: "Optional delivery link object/array or JSON string",
        },
      },
      ["note"],
    ),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const targetId = requireClaimedId(stateStore, input, ctx.thread.id);
          const note = String(input.note || "").trim();
          if (!note) return toolText("Error: note is required for submit_for_review");
          let mergedLinks = [] as ReturnType<typeof parseLinksParam>;
          if (input.links !== undefined && input.links !== null && input.links !== "") {
            const detail = await client.getFeedback(targetId);
            mergedLinks = mergeLinks(detail.item.links, parseLinksParam(input.links));
            await client.patchFeedback(targetId, { links: mergedLinks });
          }
          const result = await client.submitForReview(
            targetId,
            actorFromConfig(config),
            note,
            mergedLinks.length
              ? { delivery_links: mergedLinks, ...currentAgentSessionMeta(ctx.thread.id) }
              : currentAgentSessionMeta(ctx.thread.id),
          );
          return toolText(JSON.stringify({ ok: true, action: "submit_for_review", item: result.item }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_link",
    description:
      "Attach a delivery link (pr|commit|branch|url) via PATCH. If id is omitted, uses this thread's current claimed feedback.",
    inputSchema: objectSchema(
      {
        id: num("Feedback id (optional; defaults to current claimed feedback in this thread)"),
        kind: str('Link kind: "pr" | "commit" | "branch" | "url"'),
        url: str("Link URL"),
        title: str("Optional short title"),
      },
      ["kind", "url"],
    ),
    async execute(input, ctx) {
      try {
        return await withConfig(async (_config, client) => {
          const targetId = requireClaimedId(stateStore, input, ctx.thread.id);
          const newLink = buildLinkFromParams({
            kind: String(input.kind || ""),
            url: String(input.url || ""),
            title: typeof input.title === "string" ? input.title : undefined,
          });
          const detail = await client.getFeedback(targetId);
          const links = mergeLinks(detail.item.links, [newLink]);
          const patched = await client.patchFeedback(targetId, { links });
          return toolText(JSON.stringify({ ok: true, action: "add_link", result: patched }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_comment",
    description: "Add a comment event. Includes the current Amp thread ID in action metadata.",
    inputSchema: objectSchema({ id: num("Feedback id"), note: str("Comment text") }, ["id", "note"]),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const note = String(input.note || "").trim();
          if (!note) return toolText("Error: note required");
          const result = await client.addComment(
            resolveId(input),
            actorFromConfig(config),
            note,
            currentAgentSessionMeta(ctx.thread.id),
          );
          return toolText(JSON.stringify({ ok: true, action: "comment", raw: result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_add_ai_analysis",
    description: "Write an AI analysis event. Includes the current Amp thread ID in action metadata.",
    inputSchema: objectSchema({ id: num("Feedback id"), analysis: str("Analysis text") }, ["id", "analysis"]),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const analysis = String(input.analysis || "").trim();
          if (!analysis) return toolText("Error: analysis required");
          const result = await client.addAiAnalysis(
            resolveId(input),
            actorFromConfig(config),
            analysis,
            currentAgentSessionMeta(ctx.thread.id),
          );
          return toolText(JSON.stringify({ ok: true, action: "ai_analysis", raw: result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_upload_attachment",
    description:
      "Upload a local file (<=5MB) to hono_feedback_duck via the feedback attachments endpoint. If id is omitted, uses this thread's current claimed feedback. Optional note is recorded as a comment.",
    inputSchema: objectSchema(
      {
        id: num("Feedback id (optional; defaults to current claimed feedback in this thread)"),
        local_path: str("File path inside the open workspace (absolute or workspace-relative)"),
        filename: str("Optional attachment filename override"),
        note: str("Optional comment to add after upload"),
      },
      ["local_path"],
    ),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const targetId = requireClaimedId(stateStore, input, ctx.thread.id);
          const localPath = await resolveWorkspaceUploadPath(
            amp,
            String(input.local_path),
          );
          const upload = await client.uploadAttachments(targetId, [
            {
              path: localPath,
              filename:
                typeof input.filename === "string"
                  ? basename(input.filename)
                  : undefined,
            },
          ]);
          if (typeof input.note === "string" && input.note.trim()) {
            await client.addComment(
              targetId,
              actorFromConfig(config),
              input.note.trim(),
              currentAgentSessionMeta(ctx.thread.id),
            );
          }
          return toolText(JSON.stringify({ ok: true, feedback_id: targetId, upload }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_record_change",
    description:
      "Manually record a changed file for this thread's current claimed feedback. Automatic progress sync via tool.result is preferred.",
    inputSchema: objectSchema({ file: str("Changed file path") }, ["file"]),
    async execute(input, ctx) {
      try {
        const state = stateStore.get(ctx.thread.id);
        if (!state.claimedId()) return toolText("No current claimed feedback for this thread.");
        const root = workspaceRootPath(amp) || process.cwd();
        const file = String(input.file || "").trim();
        if (!file) return toolText("Error: file is required");
        const wasNew = state.recordFile(file, root);
        return toolText(
          wasNew
            ? `Recorded change: ${toRepoRelativePath(file, root)}`
            : `File already recorded: ${toRepoRelativePath(file, root)}`,
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_upload_changes",
    description:
      "Comment the changed-files list on the current claimed feedback, and optionally upload changed-files.txt via the feedback attachment endpoint.",
    inputSchema: objectSchema({
      id: num("Feedback id (optional; defaults to current claimed feedback in this thread)"),
      as_attachment: bool("Upload changed-files.txt attachment when true"),
      note: str("Optional extra note to append"),
    }),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const targetId = requireClaimedId(stateStore, input, ctx.thread.id);
          const state = stateStore.get(ctx.thread.id);
          const files = state.changedFiles();
          if (!files.length) return toolText(`No changed files recorded for #${targetId}.`);
          const listText = files.map((file) => `- ${file}`).join("\n");
          const extraNote = typeof input.note === "string" && input.note.trim() ? `\n\n${input.note.trim()}` : "";
          const comment = `Changed files during processing:\n${listText}${extraNote}`;
          await client.addComment(
            targetId,
            actorFromConfig(config),
            comment,
            currentAgentSessionMeta(ctx.thread.id),
          );
          if (input.as_attachment === true) {
            const bytes = new TextEncoder().encode(
              `# Changed files for feedback #${targetId}\n\n${listText}\n`,
            );
            await client.uploadAttachments(targetId, [
              { data: bytes, filename: "changed-files.txt", contentType: "text/plain" },
            ]);
          }
          return toolText(
            `Sent changed files list to #${targetId} as comment${input.as_attachment === true ? " and attachment" : ""}.`,
          );
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_submit",
    description:
      "Submit a new feedback item / bug / issue using an explicit token override or the configured submitToken. Never falls back to agentToken.",
    inputSchema: objectSchema(
      {
        note: str("Required issue description"),
        title: str("Optional title"),
        feedback_type: str('Type: "bug" | "feature" | "other"'),
        token: str("Optional submit token override"),
        project_id: num("Optional project ID override"),
      },
      ["note"],
    ),
    async execute(input, ctx) {
      try {
        return await withConfig(
          async (_config, client) => {
            const note = String(input.note || "").trim();
            if (!note) return toolText("Error: note parameter is required.");
            const result = await client.submitFeedback(
              {
                note,
                title: typeof input.title === "string" ? input.title : undefined,
                feedbackType:
                  typeof input.feedback_type === "string" ? input.feedback_type : "bug",
                project_id:
                  typeof input.project_id === "number" || typeof input.project_id === "string"
                    ? input.project_id
                    : undefined,
                meta: currentAgentSessionMeta(ctx.thread.id),
              },
              { token: typeof input.token === "string" ? input.token : undefined },
            );
            return toolText(JSON.stringify({ ok: true, result }, null, 2));
          },
          { requireAgentToken: false },
        );
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "feedback_current_claimed_id",
    description: "Return the current claimed feedback id for the invoking Amp thread only.",
    inputSchema: objectSchema({}),
    async execute(_input, ctx) {
      return toolText(
        JSON.stringify({ ok: true, currentClaimedFeedbackId: currentClaimedId(stateStore, ctx.thread.id) }, null, 2),
      );
    },
  });

  amp.registerTool({
    name: "release_list",
    description: "List project releases using the configured personal token.",
    inputSchema: objectSchema({
      project_id: str("Project id override"),
      status: str("draft | published"),
      limit: num("Optional limit"),
    }),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          const releases = await client.listReleases({
            projectId: releaseProjectId(config, input.project_id),
            status:
              input.status === "draft" || input.status === "published"
                ? input.status
                : undefined,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          return toolText(JSON.stringify({ ok: true, count: releases.length, releases }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_get",
    description: "Get a release by release_id or version.",
    inputSchema: objectSchema({
      project_id: str("Project id override"),
      release_id: num("Release id"),
      version: str("Release version"),
    }),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          const detail = await resolveRelease(client, releaseProjectId(config, input.project_id), {
            releaseId: input.release_id,
            version: input.version,
          });
          return toolText(JSON.stringify({ ok: true, ...detail }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_create",
    description: "Create a draft project release.",
    inputSchema: objectSchema(
      {
        project_id: str("Project id override"),
        version: str("Release version"),
        title: str("Optional title"),
        target_date: str("Optional YYYY-MM-DD target date"),
        notes_md: str("Optional markdown notes"),
      },
      ["version"],
    ),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          const result = await client.createRelease(releaseProjectId(config, input.project_id), {
            version: String(input.version),
            title: typeof input.title === "string" ? input.title : undefined,
            target_date: typeof input.target_date === "string" ? input.target_date : undefined,
            notes_md: typeof input.notes_md === "string" ? input.notes_md : undefined,
          });
          return toolText(JSON.stringify({ ok: true, result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_add_items",
    description: "Add done feedback items to a draft release.",
    inputSchema: objectSchema(
      {
        project_id: str("Project id override"),
        release_id: num("Release id"),
        version: str("Release version"),
        feedback_ids: {
          oneOf: [{ type: "array", items: { type: "number" } }, { type: "string" }],
          description: "Feedback ids as array or JSON array string",
        },
        section: str("Optional features | fixes | other"),
      },
      ["feedback_ids"],
    ),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          let rawIds: unknown = input.feedback_ids;
          if (typeof rawIds === "string") rawIds = JSON.parse(rawIds);
          if (!Array.isArray(rawIds) || rawIds.length === 0) {
            throw new Error("feedback_ids must not be empty");
          }
          if (rawIds.length > 100) throw new Error("feedback_ids supports at most 100 ids");
          const ids = rawIds.map(Number);
          if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
            throw new Error("every feedback_id must be a positive integer");
          }
          const projectId = releaseProjectId(config, input.project_id);
          const detail = await resolveRelease(client, projectId, {
            releaseId: input.release_id,
            version: input.version,
            allowOnlyDraft: true,
          });
          const section = input.section;
          if (
            section !== undefined &&
            section !== "features" &&
            section !== "fixes" &&
            section !== "other"
          ) {
            throw new Error("section must be features|fixes|other");
          }
          const result = await client.addReleaseItems(projectId, detail.release.id, {
            feedback_ids: ids,
            expected_revision: detail.release.revision,
            ...(section ? { section } : {}),
          });
          return toolText(JSON.stringify({ ok: true, result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_stage_current",
    description: "Stage this thread's current claimed feedback in a draft release.",
    inputSchema: objectSchema({
      project_id: str("Project id override"),
      release_id: num("Release id"),
      version: str("Release version"),
    }),
    async execute(input, ctx) {
      try {
        return await withConfig(async (config, client) => {
          const feedbackId = currentClaimedId(stateStore, ctx.thread.id);
          if (!feedbackId) throw new Error("No current claimed feedback. Claim first.");
          const projectId = releaseProjectId(config, input.project_id);
          const detail = await resolveRelease(client, projectId, {
            releaseId: input.release_id,
            version: input.version,
            allowOnlyDraft: true,
          });
          const result = await client.addReleaseItems(projectId, detail.release.id, {
            feedback_ids: [feedbackId],
            expected_revision: detail.release.revision,
          });
          return toolText(JSON.stringify({ ok: true, result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_draft_changelog",
    description: "Preview or apply generated markdown changelog for a draft release.",
    inputSchema: objectSchema({
      project_id: str("Project id override"),
      release_id: num("Release id"),
      version: str("Release version"),
      apply: bool("Write generated notes_md when true; defaults false"),
    }),
    async execute(input) {
      try {
        return await withConfig(async (config, client) => {
          const projectId = releaseProjectId(config, input.project_id);
          const detail = await resolveRelease(client, projectId, {
            releaseId: input.release_id,
            version: input.version,
            allowOnlyDraft: true,
          });
          const apply = input.apply === true;
          const result = await client.draftReleaseChangelog(projectId, detail.release.id, {
            apply,
            ...(apply ? { expected_revision: detail.release.revision } : {}),
          });
          return toolText(JSON.stringify({ ok: true, result }, null, 2));
        });
      } catch (err) {
        return toolText(`Error: ${errMsg(err)}`);
      }
    },
  });

  amp.registerTool({
    name: "release_publish",
    description: "Human-only gate. Agents cannot publish releases from tools.",
    inputSchema: objectSchema({ release_id: num("Release id"), version: str("Release version") }),
    async execute() {
      return toolText(
        "Release publish is human-only. Open the Release in the Web UI and confirm publication there.",
      );
    },
  });
}
