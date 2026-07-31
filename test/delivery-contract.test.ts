import { describe, expect, it } from "vitest";
import { buildLinkFromParams, mergeLinks, parseLinksParam } from "../src/delivery.js";
import { createClient } from "../src/client.js";
import type { AgentConfig } from "../src/types.js";

const dummyConfig: AgentConfig = {
  baseUrl: "http://127.0.0.1:8787",
  agentToken: "pt_test",
  actorId: "test-agent",
  actorName: "Test Agent",
};

describe("delivery contract", () => {
  it("exposes submitForReview and patchFeedback but no complete method", () => {
    const client = createClient(dummyConfig);
    expect("complete" in client).toBe(false);
    expect(typeof client.submitForReview).toBe("function");
    expect(typeof client.patchFeedback).toBe("function");
  });

  it("parses and merges links", () => {
    expect(parseLinksParam(undefined)).toEqual([]);
    expect(parseLinksParam('{"kind":"url","url":"https://example.com"}')).toEqual([
      { kind: "url", url: "https://example.com" },
    ]);
    expect(() => parseLinksParam("not-json")).toThrow(/Invalid links JSON/);
    expect(
      buildLinkFromParams({ kind: "pr", url: " https://github.com/o/r/pull/1 ", title: "PR" }),
    ).toEqual({ kind: "pr", url: "https://github.com/o/r/pull/1", title: "PR" });
    expect(mergeLinks([{ kind: "url", url: "https://a" }], [{ kind: "pr", url: "https://b" }])).toEqual([
      { kind: "url", url: "https://a" },
      { kind: "pr", url: "https://b" },
    ]);
  });
});
