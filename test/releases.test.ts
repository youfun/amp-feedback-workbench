import { afterEach, describe, expect, it, vi } from "vitest";
import feedbackWorkbenchPlugin from "../src/plugin.js";
import { createClient } from "../src/client.js";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("release client", () => {
  it("lists, creates, stages, and drafts changelog with Personal Token auth", async () => {
    const calls: Array<{ url: string; method: string; body?: any; auth?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string>)?.Authorization,
      });
      if (method === "GET") return response({ releases: [{ id: 1, version: "1.0.0", status: "draft", revision: 0 }] });
      if (url.endsWith("/draft-changelog")) return response({ applied: true, notes_md: "## Features", release: { id: 1, revision: 2 } });
      if (url.endsWith("/items")) return response({ added_count: 2, warnings: [], release: { id: 1, revision: 1 }, items: [] });
      return response({ release: { id: 1, version: "1.0.0", status: "draft", revision: 0 } }, 201);
    }));

    const client = createClient({
      baseUrl: "https://feedback.example",
      agentToken: "pt_test",
      actorId: "agent",
      actorName: "Agent",
    });
    await client.listReleases({ projectId: 7, status: "draft", limit: 10 });
    await client.createRelease(7, { version: "1.0.0" });
    await client.addReleaseItems(7, 1, { feedback_ids: [10, 11], expected_revision: 0 });
    await client.draftReleaseChangelog(7, 1, { apply: true, expected_revision: 1 });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://feedback.example/api/projects/7/releases?status=draft&limit=10"],
      ["POST", "https://feedback.example/api/projects/7/releases"],
      ["POST", "https://feedback.example/api/projects/7/releases/1/items"],
      ["POST", "https://feedback.example/api/projects/7/releases/1/draft-changelog"],
    ]);
    expect(calls[2]?.body).toEqual({ feedback_ids: [10, 11], expected_revision: 0 });
    expect(calls.every((call) => call.auth === "Bearer pt_test")).toBe(true);
  });
});

describe("release tools", () => {
  it("registers release workflow and keeps publish human-only", async () => {
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    feedbackWorkbenchPlugin({
      logger: { log() {} },
      system: { workspaceRoot: null },
      configuration: {} as any,
      $: {} as any,
      helpers: { filesModifiedByToolCall() { return null; }, filePathFromURI() { return ""; } } as any,
      ui: {} as any,
      on() { return { unsubscribe() {} }; },
      onDispose() { return { unsubscribe() {} }; },
      registerCommand(name: string, command: any) { commands.set(name, command); return { unsubscribe() {}, setAvailability() {} }; },
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

    expect([...tools.keys()]).toEqual(expect.arrayContaining([
      "release_list",
      "release_get",
      "release_create",
      "release_add_items",
      "release_stage_current",
      "release_draft_changelog",
      "release_publish",
    ]));
    expect(commands.has("fb-release")).toBe(true);
    const result = await tools.get("release_publish").execute({}, { thread: { id: "T-1" } });
    expect(result).toContain("human-only");
  });
});
