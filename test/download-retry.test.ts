import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAndCacheAttachment, downloadAttachments } from "../src/image.js";
import type { AgentConfig, FeedbackItem } from "../src/types.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function okResponse(body: Uint8Array, contentType = "image/png") {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("downloadAndCacheAttachment retries", () => {
  let cwd = "";

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = "";
    }
  });

  it("retries on ConnectTimeoutError and succeeds", async () => {
    cwd = await mkdtemp(join(tmpdir(), "fb-dl-"));
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new TypeError("fetch failed");
        (err as Error & { cause?: unknown }).cause = Object.assign(new Error("Connect Timeout Error"), {
          name: "ConnectTimeoutError",
          code: "UND_ERR_CONNECT_TIMEOUT",
        });
        throw err;
      }
      return okResponse(pngBytes);
    }));

    const result = await downloadAndCacheAttachment({
      url: "https://example.com/files/shot.png",
      cwd,
      feedbackId: 18,
      filename: "screenshot.png",
      index: 0,
    });
    expect(result?.mediaType).toBe("image/png");
    expect(attempts).toBe(3);
  });

  it("retries on HTTP 503 then succeeds", async () => {
    cwd = await mkdtemp(join(tmpdir(), "fb-dl-"));
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return new Response("busy", { status: 503 });
      return okResponse(pngBytes, "image/jpeg");
    }));

    const result = await downloadAndCacheAttachment({
      url: "https://example.com/files/a.jpg",
      cwd,
      feedbackId: 7,
      filename: "a.jpg",
      index: 1,
    });
    expect(result?.mediaType).toBe("image/jpeg");
    expect(attempts).toBe(2);
  });

  it("resolves API-relative URLs and sends credentials only to the API origin", async () => {
    cwd = await mkdtemp(join(tmpdir(), "fb-dl-origin-"));
    const calls: Array<{ url: string; authorization?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization") || undefined,
      });
      return okResponse(pngBytes);
    }));

    const config: AgentConfig = {
      baseUrl: "https://feedback.example.test",
      agentToken: "pt_secret",
      actorId: "amp",
      actorName: "Amp",
    };
    const item = {
      id: 9,
      project_id: 1,
      status: "claimed",
      note: "test",
      url: null,
      title: null,
      feedback_type: "bug",
      inserted_at: "2026-01-01T00:00:00Z",
      attachments: [
        { filename: "relative.png", url: "/files/relative.png" },
        { filename: "external.png", url: "https://storage.example.test/presigned.png" },
      ],
    } satisfies FeedbackItem;

    const result = await downloadAttachments(config, item, cwd);
    expect(result.files).toHaveLength(2);
    expect(calls).toEqual([
      {
        url: "https://feedback.example.test/files/relative.png",
        authorization: "Bearer pt_secret",
      },
      {
        url: "https://storage.example.test/presigned.png",
        authorization: undefined,
      },
    ]);
  });
});
