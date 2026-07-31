import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentConfig, FeedbackActor, StoredConfig } from "./types.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProjectId(value: unknown): string | number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(text);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : text;
}

function readJson(path: string): StoredConfig | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as StoredConfig) : null;
  } catch {
    return null;
  }
}

function findUp(start: string, rel: string): string | null {
  let dir = start;
  for (let i = 0; i < 14; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pick(...values: unknown[]) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return undefined;
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

  const files = paths.map((path) => ({ path, data: readJson(path) }));
  const match = files.find((entry) => entry.data);
  const first = match?.data || null;
  const firstPath = match?.path;

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

  const submitToken = asString(
    pick(
      env("AMP_FEEDBACK_SUBMIT_TOKEN"),
      env("DROID_FEEDBACK_SUBMIT_TOKEN"),
      env("PI_FEEDBACK_SUBMIT_TOKEN"),
      first?.submitToken,
    ),
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
  if (
    env("AMP_FEEDBACK_AGENT_TOKEN") ||
    env("AMP_FEEDBACK_SUBMIT_TOKEN") ||
    env("PI_FEEDBACK_AGENT_TOKEN") ||
    env("PI_FEEDBACK_SUBMIT_TOKEN")
  ) {
    source = "env";
  } else if (firstPath) {
    source = firstPath.includes(".pi")
      ? "pi-config"
      : firstPath.includes(".factory")
        ? "factory-config"
        : "amp-config";
  }

  return {
    baseUrl,
    agentToken,
    submitToken,
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

export function toStoredConfig(config: AgentConfig): StoredConfig {
  return {
    baseUrl: config.baseUrl,
    agentToken: config.agentToken,
    submitToken: config.submitToken,
    projectId: config.projectId ?? null,
    projectSlug: config.projectSlug ?? null,
    actorId: config.actorId,
    actorName: config.actorName,
  };
}

export function summarizeConfig(config: AgentConfig): string {
  return [
    `config: ${config.configPath || "(none)"}`,
    `source: ${config.source || "default"}`,
    `baseUrl: ${config.baseUrl}`,
    `agentToken: ${maskToken(config.agentToken)}`,
    `submitToken: ${maskToken(config.submitToken || "")}`,
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
    submitToken: data.submitToken,
    projectId: data.projectId ?? null,
    projectSlug: data.projectSlug ?? null,
    actorId: data.actorId,
    actorName: data.actorName,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
