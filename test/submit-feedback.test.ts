import { describe, expect, it, vi } from "vitest";
import feedbackWorkbenchPlugin from "../src/plugin.js";
import { createClient } from "../src/client.js";
import type { AgentConfig, CreateFeedbackInput } from "../src/types.js";

const dummyConfig: AgentConfig = {
  baseUrl: "http://127.0.0.1:8787",
  agentToken: "pt_test_agent_token",
  submitToken: "fd_configured_submit_token",
  actorId: "test-agent",
  actorName: "Test Agent",
  projectId: 1,
};

describe("submitFeedback client API", () => {
  it("sends POST /api/feedback with explicit token override", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ ok: true, id: 42, project_slug: "demo-proj", admin_url: "/admin/42" }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient(dummyConfig);
    const input: CreateFeedbackInput = {
      note: "Found a bug while testing authentication",
      title: "Auth failure on expired token",
      feedbackType: "bug",
    };

    const res = await client.submitFeedback(input, { token: "fd_project_token_123" });
    expect(res.id).toBe(42);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/feedback",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer fd_project_token_123" }),
        body: JSON.stringify({
          note: input.note,
          title: input.title,
          feedbackType: input.feedbackType,
          project_id: 1,
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("uses submitToken by default and never falls back to agentToken", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, id: 99, project_slug: "test-proj" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createClient(dummyConfig).submitFeedback({
      title: "Simple issue",
      note: "Simple issue note",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/feedback",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fd_configured_submit_token" }),
      }),
    );

    await expect(
      createClient({ ...dummyConfig, submitToken: undefined }).submitFeedback({
        title: "Missing token",
        note: "Missing token",
      }),
    ).rejects.toThrow(/No submitToken configured/);
    vi.unstubAllGlobals();
  });
});

describe("plugin registration", () => {
  it("registers feedback_submit", () => {
    const tools = new Map<string, any>();
    feedbackWorkbenchPlugin({
      logger: { log() {} },
      system: { workspaceRoot: null },
      configuration: {} as any,
      $: {} as any,
      helpers: { filesModifiedByToolCall() { return null; }, filePathFromURI() { return ""; } } as any,
      ui: {} as any,
      on() { return { unsubscribe() {} }; },
      onDispose() { return { unsubscribe() {} }; },
      registerCommand() { return { unsubscribe() {}, setAvailability() {} }; },
      registerTool(tool: any) { tools.set(tool.name, tool); return { unsubscribe() {} }; },
      attachments: {} as any,
      ai: {} as any,
      createAgent() { throw new Error("unused"); },
      getBuiltinAgent() { throw new Error("unused"); },
      registerAgentMode() { return { unsubscribe() {} }; },
      activeThread: { current: null },
      threads: {} as any,
      createWebhook() { throw new Error("unused"); },
    } as any);
    expect(tools.has("feedback_submit")).toBe(true);
  });
});
