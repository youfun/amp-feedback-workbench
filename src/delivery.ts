import type { FeedbackLink, FeedbackLinkKind } from "./types.js";

const LINK_KINDS = new Set<FeedbackLinkKind>(["pr", "commit", "branch", "url"]);

function isLinkKind(value: unknown): value is FeedbackLinkKind {
  return typeof value === "string" && LINK_KINDS.has(value as FeedbackLinkKind);
}

function normalizeLink(raw: unknown): FeedbackLink | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!isLinkKind(obj.kind)) return null;
  if (typeof obj.url !== "string" || !obj.url.trim()) return null;
  const title =
    obj.title === undefined || obj.title === null ? undefined : String(obj.title);
  return {
    kind: obj.kind,
    url: obj.url.trim(),
    ...(title !== undefined ? { title } : {}),
  };
}

export function parseLinksParam(input: unknown): FeedbackLink[] {
  if (input === undefined || input === null || input === "") return [];

  let value: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(
        'Invalid links JSON. Expected e.g. [{"kind":"pr","url":"https://..."}] or a single link object.',
      );
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => {
      const link = normalizeLink(item);
      if (!link) {
        throw new Error(
          'Invalid link entry. Each link needs kind ("pr"|"commit"|"branch"|"url") and url.',
        );
      }
      return link;
    });
  }

  const single = normalizeLink(value);
  if (!single) {
    throw new Error(
      'Invalid link. Expected {kind:"pr"|"commit"|"branch"|"url", url:string, title?:string}.',
    );
  }
  return [single];
}

export function mergeLinks(
  existing: FeedbackLink[] | null | undefined,
  additions: FeedbackLink[],
): FeedbackLink[] {
  return [...(existing || []), ...additions];
}

export function buildLinkFromParams(params: {
  kind: string;
  url: string;
  title?: string | null;
}): FeedbackLink {
  if (!isLinkKind(params.kind)) {
    throw new Error(`Invalid kind "${params.kind}". Must be one of: pr, commit, branch, url.`);
  }
  const url = String(params.url || "").trim();
  if (!url) throw new Error("url is required");
  const title =
    params.title === undefined || params.title === null || params.title === ""
      ? undefined
      : String(params.title);
  return {
    kind: params.kind,
    url,
    ...(title !== undefined ? { title } : {}),
  };
}
