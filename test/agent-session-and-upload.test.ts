import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import feedbackWorkbenchPlugin from "../src/plugin.js";
import { createClient } from "../src/client.js";
import type { AgentConfig } from "../src/types.js";

const config: AgentConfig = {
  baseUrl: "https://feedback.example.test",
  agentToken: "pt_test",
  actorId: "amp-agent",
  actorName: "Amp",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.AMP_FEEDBACK_AGENT_TOKEN;
  delete process.env.AMP_FEEDBACK_BASE_URL;
});

describe("Amp thread metadata and attachment upload", () => {
  it("sends amp thread metadata on claim and comments", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ item: { id: 12, status: "claimed" }, event: { claim_round: 1 }, events: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createClient(config);
    const meta = { amp_thread_id: "T-thread-1", agent_session: { session_id: "T-thread-1", agent_type: "amp_agent" } };
    await client.claim(12, { type: "amp_agent", id: "amp-agent", name: "Amp" }, "claim", meta);
    await client.addComment(12, { type: "amp_agent", id: "amp-agent", name: "Amp" }, "[progress] file=a.ts", meta);

    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.meta).toMatchObject({ amp_thread_id: "T-thread-1", agent_session: { session_id: "T-thread-1" } });
    }
  });

  it("rejects files larger than 5MB and defaults upload tool id to current thread claim", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "amp-feedback-upload-"));
    try {
      const bigPath = join(tempDir, "big.bin");
      await writeFile(bigPath, Buffer.alloc(5 * 1024 * 1024 + 1));
      await expect(createClient(config).uploadAttachments(1, [{ path: bigPath }])).rejects.toThrow(/5MB/);

      process.env.AMP_FEEDBACK_AGENT_TOKEN = "pt_test";
      process.env.AMP_FEEDBACK_BASE_URL = "https://feedback.example.test";
      const smallPath = join(tempDir, "small.txt");
      await writeFile(smallPath, "hello");

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/12/actions")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => JSON.stringify({ item: { id: 12, status: "claimed" }, event: { claim_round: 1 }, events: [] }),
          };
        }
        if (url.endsWith("/12/attachments")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => JSON.stringify({
              ok: true,
              saved: ["small.txt"],
              errors: [],
              attachments: [{ filename: "small.txt" }],
            }),
          };
        }
        throw new Error(`Unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const tools = new Map<string, any>();
      feedbackWorkbenchPlugin({
        logger: { log() {} },
        system: { workspaceRoot: { toString: () => `file://${tempDir}` } },
        configuration: {} as any,
        $: {} as any,
        helpers: {
          filesModifiedByToolCall() { return null; },
          filePathFromURI() { return tempDir; },
        } as any,
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
        activeThread: { current: null, subscribe() { return { unsubscribe() {} }; } },
        experimental: {
          createStatusItem() {
            return { update() {}, unsubscribe() {} };
          },
        },
        threads: {
          get(id: string) {
            return { id, async appendUserMessage() {} };
          },
        } as any,
        createWebhook() { throw new Error("unused"); },
      } as any);

      // inject=false: this test only needs claim state for upload default id
      await tools.get("feedback_claim").execute({ id: 12, inject: false }, { thread: { id: "T-claim" } });
      const result = await tools.get("feedback_upload_attachment").execute(
        { local_path: smallPath },
        { thread: { id: "T-claim" } },
      );
      expect(result).toContain('"feedback_id": 12');

      const outsidePath = join(tmpdir(), `outside-${Date.now()}.txt`);
      await writeFile(outsidePath, "secret");
      try {
        const rejected = await tools.get("feedback_upload_attachment").execute(
          { local_path: outsidePath },
          { thread: { id: "T-claim" } },
        );
        expect(rejected).toContain("must stay inside the open workspace");
      } finally {
        await rm(outsidePath, { force: true });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects HTTP 200 attachment responses when the server saved no file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "amp-feedback-upload-failure-"));
    try {
      const path = join(tempDir, "blocked.exe");
      await writeFile(path, "not executable");
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          ok: true,
          saved: [],
          errors: ["blocked.exe: extension_not_allowed"],
          attachments: [],
        }),
      })));

      await expect(createClient(config).uploadAttachments(1, [{ path }])).rejects.toThrow(
        /extension_not_allowed/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves agent_sessions returned by feedback_get", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        item: { id: 12, attachments: [] },
        events: [],
        agent_sessions: [{
          agent_type: "amp_agent",
          session_id: "T-thread-1",
          resume_command: null,
        }],
      }),
    })));

    const detail = await createClient(config).getFeedback(12);
    expect(detail.agent_sessions).toEqual([
      expect.objectContaining({ agent_type: "amp_agent", session_id: "T-thread-1" }),
    ]);
  });
});
