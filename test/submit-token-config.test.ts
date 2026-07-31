import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, summarizeConfig, toStoredConfig } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("submitToken configuration", () => {
  it("loads and persists the project-scoped submit token", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "amp-feedback-submit-token-"));
    tempDirs.push(cwd);
    await mkdir(join(cwd, ".amp"));
    await writeFile(
      join(cwd, ".amp", "feedback-workbench.json"),
      JSON.stringify({
        baseUrl: "https://duck.example.test",
        agentToken: "pt_agent_secret",
        submitToken: "fd_submit_secret",
        projectId: "project-1",
      }),
    );

    const config = loadConfig({ cwd });

    expect(config.submitToken).toBe("fd_submit_secret");
    expect(toStoredConfig(config).submitToken).toBe("fd_submit_secret");
    expect(summarizeConfig(config)).not.toContain("fd_submit_secret");
    expect(summarizeConfig(config)).toContain("submitToken: fd_s…cret");
  });
});
