import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, FeedbackActor, StoredConfig } from "./types.ts";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProjectId(value: unknown): string | number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : s;
}

function readJson(path: string): StoredConfig | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? (data as StoredConfig) : null;
  } catch {
    return null;
  }
}

function findUp(start: string, rel: string): string | null {
  let dir = start;
  for (let i = 0; i < 14; i++) {
    const cand = join(dir, rel);
    if (existsSync(cand)) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadConfig(options: { cwd?: string } = {}): AgentConfig {
  const cwd = options.cwd || process.cwd();
  const paths = [
    findUp(cwd, ".amp/feedback-workbench.json"),
    findUp(cwd, ".factory/feedback-workbench.json"),
    findUp(cwd, ".pi/feedback-workbench.json"),
    join(homedir(), ".config", "amp", "feedback-workbench.json"),
    join(homedir(), ".factory", "feedback-workbench.json"),
    join(homedir(), ".pi", "feedback-workbench", "config.json"),
  ].filter(Boolean) as string[];

  const files = paths.map((p) => ({ path: p, data: readJson(p) }));
  const first = files.find((f) => f.data)?.data || null;
  const firstPath = files.find((f) => f.data)?.path;

  const pick = (...vals: unknown[]) => {
    for (const v of vals) {
      if (v == null) continue;
      if (typeof v === "string" && !v.trim()) continue;
      return v;
    }
    return undefined;
  };

  const baseUrl = String(
    pick(
      env("AMP_FEEDBACK_BASE_URL"),
      env("DROID_FEEDBACK_BASE_URL"),
      env("PI_FEEDBACK_BASE_URL"),
      first?.baseUrl,
      "http://127.0.0.1:8787",
    ),
  ).replace(/\/$/, "");

  const agentToken = String(
    pick(
      env("AMP_FEEDBACK_AGENT_TOKEN"),
      env("AMP_FEEDBACK_TOKEN"),
      env("DROID_FEEDBACK_AGENT_TOKEN"),
      env("PI_FEEDBACK_AGENT_TOKEN"),
      env("PI_FEEDBACK_TOKEN"),
      first?.agentToken,
      "",
    ) ?? "",
  );

  const projectId =
    parseProjectId(
      pick(
        env("AMP_FEEDBACK_PROJECT_ID"),
        env("DROID_FEEDBACK_PROJECT_ID"),
        env("PI_FEEDBACK_PROJECT_ID"),
        first?.projectId,
      ),
    ) ?? null;

  const projectSlug =
    asString(
      pick(
        env("AMP_FEEDBACK_PROJECT_SLUG"),
        env("DROID_FEEDBACK_PROJECT_SLUG"),
        env("PI_FEEDBACK_PROJECT_SLUG"),
        first?.projectSlug,
      ),
    ) ?? null;

  const actorId = String(
    pick(
      env("AMP_FEEDBACK_ACTOR_ID"),
      env("PI_FEEDBACK_ACTOR_ID"),
      first?.actorId,
      "local-amp",
    ),
  );

  const actorName = String(
    pick(
      env("AMP_FEEDBACK_ACTOR_NAME"),
      env("PI_FEEDBACK_ACTOR_NAME"),
      first?.actorName,
      `Amp on ${process.env.HOST || process.env.HOSTNAME || "local"}`,
    ),
  );

  let source = "default";
  if (env("AMP_FEEDBACK_AGENT_TOKEN") || env("PI_FEEDBACK_AGENT_TOKEN")) source = "env";
  else if (firstPath) source = firstPath.includes(".pi") ? "pi-config" : firstPath.includes(".factory") ? "factory-config" : "amp-config";

  return {
    baseUrl,
    agentToken,
    projectId,
    projectSlug,
    actorId,
    actorName,
    cwd,
    configPath: firstPath || join(cwd, ".amp", "feedback-workbench.json"),
    source,
  };
}

export function requireConfig(config: AgentConfig): void {
  if (!config.baseUrl) throw new Error("baseUrl is required");
  if (!config.agentToken) {
    throw new Error(
      `No Personal Token.\n` +
        `Save agentToken to ${config.configPath || ".amp/feedback-workbench.json"}\n` +
        `or set AMP_FEEDBACK_AGENT_TOKEN / reuse .pi/feedback-workbench.json`,
    );
  }
}

export function actorFromConfig(config: AgentConfig): FeedbackActor {
  return {
    type: "amp_agent",
    id: config.actorId,
    name: config.actorName,
  };
}

export function maskToken(token: string): string {
  if (!token) return "(empty)";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function summarizeConfig(config: AgentConfig): string {
  return [
    `config: ${config.configPath || "(none)"}`,
    `source: ${config.source || "default"}`,
    `baseUrl: ${config.baseUrl}`,
    `token: ${maskToken(config.agentToken)}`,
    `projectId: ${config.projectId ?? "(none)"}`,
    `projectSlug: ${config.projectSlug ?? "(none)"}`,
    `actor: ${config.actorName} (${config.actorId})`,
  ].join("\n");
}

export function saveProjectConfig(cwd: string, data: StoredConfig): string {
  const path = join(cwd, ".amp", "feedback-workbench.json");
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredConfig = {
    baseUrl: data.baseUrl?.replace(/\/$/, ""),
    agentToken: data.agentToken,
    projectId: data.projectId ?? null,
    projectSlug: data.projectSlug ?? null,
    actorId: data.actorId,
    actorName: data.actorName,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
