import { afterEach, describe, expect, it, vi } from "vitest";
import feedbackWorkbenchPlugin from "../src/plugin.js";

function makeAmp(opts: { activeThreadId?: string | null } = {}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const statusUpdates: Array<{ text: string; url?: string }> = [];
  let active: { id: string } | null =
    opts.activeThreadId === undefined
      ? null
      : opts.activeThreadId
        ? { id: opts.activeThreadId }
        : null;
  const activeSubs: Array<(v: { id: string } | null) => void> = [];
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
    on(event: string, handler: any) {
      events.set(event, handler);
      return { unsubscribe() {} };
    },
    onDispose() {
      return { unsubscribe() {} };
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
      return { unsubscribe() {}, setAvailability() {} };
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
      return { unsubscribe() {} };
    },
    attachments: {} as any,
    ai: {} as any,
    createAgent() {
      throw new Error("unused");
    },
    getBuiltinAgent() {
      throw new Error("unused");
    },
    registerAgentMode() {
      return { unsubscribe() {} };
    },
    activeThread: {
      get current() {
        return active;
      },
      subscribe(cb: (v: { id: string } | null) => void) {
        activeSubs.push(cb);
        return { unsubscribe() {} };
      },
    },
    experimental: {
      createStatusItem(initial?: { text: string; url?: string }) {
        if (initial) statusUpdates.push(initial);
        return {
          update(value: { text: string; url?: string }) {
            statusUpdates.push(value);
          },
          unsubscribe() {},
        };
      },
    },
    threads: {
      get(id: string) {
        return {
          id,
          async appendUserMessage() {},
        };
      },
    } as any,
    createWebhook() {
      throw new Error("unused");
    },
    setActiveThread(id: string | null) {
      active = id ? { id } : null;
      for (const cb of activeSubs) cb(active);
    },
  };
  feedbackWorkbenchPlugin(amp as any);
  return { amp, tools, commands, events, statusUpdates };
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
          text: async () =>
            JSON.stringify({
              item: {
                id: Number(id),
                status: body.action === "comment" ? "claimed" : "claimed",
                title: `Title ${id}`,
                note: `Body ${id}`,
                feedback_type: "bug",
                project_id: "p1",
                inserted_at: "2026-01-01T00:00:00Z",
              },
              event: { claim_round: 1 },
              events: [],
            }),
        };
      }
      // getFeedback during claim inject
      const getMatch = url.match(/\/api\/feedback\/(\d+)$/);
      if (getMatch) {
        const id = Number(getMatch[1]);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              item: {
                id,
                status: "claimed",
                title: `Title ${id}`,
                note: `Body ${id}`,
                feedback_type: "bug",
                project_id: "p1",
                inserted_at: "2026-01-01T00:00:00Z",
                attachments: [],
              },
              events: [],
              attachments: [],
            }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tools, events } = makeAmp();
    // inject=false keeps this test focused on claim isolation + progress sync
    await tools.get("feedback_claim").execute({ id: 12, inject: false }, { thread: { id: "T-1" } });
    await tools.get("feedback_claim").execute({ id: 99, inject: false }, { thread: { id: "T-2" } });

    expect(await tools.get("feedback_current_claimed_id").execute({}, { thread: { id: "T-1" } })).toContain(
      "12",
    );
    expect(await tools.get("feedback_current_claimed_id").execute({}, { thread: { id: "T-2" } })).toContain(
      "99",
    );

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
    expect(commentBody.meta).toMatchObject({
      amp_thread_id: "T-1",
      agent_session: { session_id: "T-1" },
    });
  });

  it("injects claimed-context on agent.start and updates status item", async () => {
    process.env.AMP_FEEDBACK_AGENT_TOKEN = "pt_test";
    process.env.AMP_FEEDBACK_BASE_URL = "https://feedback.example.test";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/actions")) {
        const id = url.match(/feedback\/(\d+)\/actions/)?.[1] || "12";
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              item: { id: Number(id), status: "claimed", title: "T", note: "N", feedback_type: "bug", project_id: "p", inserted_at: "2026-01-01T00:00:00Z" },
              event: { claim_round: 1 },
              events: [],
            }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { amp, tools, events, statusUpdates } = makeAmp({ activeThreadId: "T-1" });
    await tools.get("feedback_claim").execute({ id: 12, inject: false }, { thread: { id: "T-1" } });

    const startResult = await events.get("agent.start")(
      { thread: { id: "T-1" }, message: "work on it", id: 1 },
      { thread: { id: "T-1" } },
    );
    expect(startResult?.message?.content).toContain("claimed feedback id 12");
    expect(startResult?.message?.display).toBe(false);

    const last = statusUpdates.at(-1);
    expect(last?.text).toContain("fb #12");
    expect(last?.url).toBe("command:fb-progress");

    amp.setActiveThread(null);
    expect(statusUpdates.at(-1)?.text).toBe("fb: —");
  });

  it("feedback_claim injects title, body, and attachment guidance into the thread", async () => {
    process.env.AMP_FEEDBACK_AGENT_TOKEN = "pt_test";
    process.env.AMP_FEEDBACK_BASE_URL = "https://feedback.example.test";
    const injected: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/actions")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              item: {
                id: 12,
                status: "claimed",
                title: "Login button broken",
                note: "Clicking Sign in does nothing on Safari",
                feedback_type: "bug",
                project_id: "p1",
                inserted_at: "2026-01-01T00:00:00Z",
                screenshot_url: null,
                attachments: [],
              },
              event: { claim_round: 2 },
              events: [],
            }),
        };
      }
      if (/\/api\/feedback\/12$/.test(url)) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              item: {
                id: 12,
                status: "claimed",
                title: "Login button broken",
                note: "Clicking Sign in does nothing on Safari",
                feedback_type: "bug",
                project_id: "p1",
                inserted_at: "2026-01-01T00:00:00Z",
                attachments: [],
              },
              events: [],
              attachments: [],
            }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tools } = makeAmp();
    // Override thread append capture via tool context
    const result = await tools.get("feedback_claim").execute(
      { id: 12 },
      {
        thread: {
          id: "T-inj",
          async appendUserMessage(msg: { content: string }) {
            injected.push(msg.content);
          },
        },
      },
    );

    expect(result).toContain('"injected": true');
    expect(result).toContain("Login button broken");
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("## Title");
    expect(injected[0]).toContain("Login button broken");
    expect(injected[0]).toContain("## User description / body");
    expect(injected[0]).toContain("Clicking Sign in does nothing on Safari");
    expect(injected[0]).toContain("Required reading before coding");
  });
});
