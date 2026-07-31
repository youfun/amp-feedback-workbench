import { afterEach, describe, expect, it, vi } from "vitest";
import feedbackWorkbenchPlugin from "../src/plugin.js";

function makeAmp() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const amp = {
    logger: { log() {} },
    system: { workspaceRoot: { toString: () => "file:///repo" } },
    configuration: {} as any,
    $: {} as any,
    helpers: {
      filesModifiedByToolCall: vi.fn(() => [{ toString: () => "file:///repo/src/a.ts" }]),
      filePathFromURI: vi.fn((uri: { toString(): string }) => uri.toString().replace("file://", "")),
    },
    ui: {} as any,
    on(event: string, handler: any) { events.set(event, handler); return { unsubscribe() {} }; },
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
  };
  feedbackWorkbenchPlugin(amp as any);
  return { amp, tools, commands, events };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.AMP_FEEDBACK_AGENT_TOKEN;
  delete process.env.AMP_FEEDBACK_BASE_URL;
});

describe("thread isolation and progress sync", () => {
  it("stores claimed feedback per thread and syncs progress only to that thread", async () => {
    process.env.AMP_FEEDBACK_AGENT_TOKEN = "pt_test";
    process.env.AMP_FEEDBACK_BASE_URL = "https://feedback.example.test";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/actions")) {
        const body = JSON.parse(String(init?.body));
        const id = url.match(/feedback\/(\d+)\/actions/)?.[1] || "12";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ item: { id: Number(id), status: body.action === "comment" ? "claimed" : "claimed" }, event: { claim_round: 1 }, events: [] }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tools, events } = makeAmp();
    await tools.get("feedback_claim").execute({ id: 12 }, { thread: { id: "T-1" } });
    await tools.get("feedback_claim").execute({ id: 99 }, { thread: { id: "T-2" } });

    expect(await tools.get("feedback_current_claimed_id").execute({}, { thread: { id: "T-1" } })).toContain("12");
    expect(await tools.get("feedback_current_claimed_id").execute({}, { thread: { id: "T-2" } })).toContain("99");

    await events.get("tool.call")({
      tool: "write",
      input: {},
      toolUseID: "toolu_1",
      thread: { id: "T-1" },
    });
    await events.get("tool.result")({
      status: "done",
      tool: "write",
      input: {},
      toolUseID: "toolu_1",
      thread: { id: "T-1" },
    });

    const actionCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/actions"));
    expect(actionCalls).toHaveLength(3);
    const commentBody = JSON.parse(String(actionCalls[2]?.[1]?.body));
    expect(commentBody.note).toContain("src/a.ts");
    expect(commentBody.meta).toMatchObject({ amp_thread_id: "T-1", agent_session: { session_id: "T-1" } });
  });
});
