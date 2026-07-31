import { describe, expect, it, vi } from "vitest";
import { ThreadProgressTracker, formatProgressComment, toRepoRelativePath } from "../src/progress-sync.js";

describe("progress sync", () => {
  it("normalizes repo-relative paths", () => {
    expect(toRepoRelativePath("./src/a.ts", "/repo")).toBe("src/a.ts");
    expect(toRepoRelativePath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(toRepoRelativePath("/tmp/a.ts", "/repo")).toBe("/tmp/a.ts");
  });

  it("records files and throttles duplicate comments", async () => {
    const tracker = new ThreadProgressTracker({ throttleMs: 5_000, now: (() => { let t = 1_000; return () => t; })() });
    tracker.setClaimed(19);
    const comments: string[] = [];
    const client = { addComment: vi.fn(async (_id: number, _actor: unknown, note: string) => { comments.push(note); }) };

    await tracker.recordAndCommentFiles({
      toolName: "write",
      filePaths: ["src/a.ts", "src/a.ts"],
      client: client as any,
      actor: { type: "amp_agent", id: "a", name: "Amp" },
      source: "tool.result",
      cwd: "/repo",
      meta: { amp_thread_id: "T-1" },
    });
    expect(tracker.changedFiles()).toEqual(["src/a.ts"]);
    expect(comments).toHaveLength(1);
    expect(formatProgressComment({ toolName: "write", filePath: "src/a.ts", source: "tool.result" })).toContain("src/a.ts");
  });

  it("does not move an in-flight multi-file result to a newer claim", async () => {
    const tracker = new ThreadProgressTracker({ throttleMs: 0 });
    tracker.setClaimed(19);
    const generation = tracker.claimGeneration();
    let releaseFirstComment!: () => void;
    const firstCommentStarted = new Promise<void>((resolve) => {
      releaseFirstComment = resolve;
    });
    let unblockFirstComment!: () => void;
    const firstCommentBlocked = new Promise<void>((resolve) => {
      unblockFirstComment = resolve;
    });
    const calls: number[] = [];
    const client = {
      addComment: vi.fn(async (id: number) => {
        calls.push(id);
        if (calls.length === 1) {
          releaseFirstComment();
          await firstCommentBlocked;
        }
      }),
    };

    const recording = tracker.recordAndCommentFiles({
      toolName: "apply_patch",
      filePaths: ["src/a.ts", "src/b.ts"],
      client: client as any,
      actor: { type: "amp_agent", id: "a", name: "Amp" },
      expectedClaim: { id: 19, generation },
    });
    await firstCommentStarted;
    tracker.setClaimed(20);
    unblockFirstComment();
    await recording;

    expect(calls).toEqual([19]);
    expect(tracker.claimedId()).toBe(20);
    expect(tracker.changedFiles()).toEqual([]);
  });
});
