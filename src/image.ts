import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentConfig, FeedbackItem } from "./types.js";

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
]);

export type CachedAttachment = {
  path: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  isImage: boolean;
  sourceUrl: string;
};

function stripMimeParams(value: string | null | undefined): string {
  if (!value) return "";
  return value.split(";")[0]!.trim().toLowerCase();
}

function extForMime(mime: string, fallbackName = ""): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    case "application/pdf":
      return "pdf";
    case "text/markdown":
      return "md";
    case "text/plain":
      return "txt";
    case "text/csv":
    case "application/csv":
      return "csv";
    default: {
      const match = fallbackName.match(/\.([a-z0-9]+)$/i);
      return match?.[1]?.toLowerCase() || "bin";
    }
  }
}

function mimeFromMagic(bytes: Uint8Array): string | null {
  if (bytes.length >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return "image/gif";
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return "application/pdf";
    }
  }
  const head = Buffer.from(bytes.slice(0, 256)).toString("utf8").trimStart();
  if (head.startsWith("<svg") || head.includes("http://www.w3.org/2000/svg")) {
    return "image/svg+xml";
  }
  return null;
}

function mimeFromNameOrUrl(nameOrUrl: string): string | null {
  const path = nameOrUrl.toLowerCase();
  if (path.endsWith(".png") || path.includes(".png?")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg") || path.includes(".jpg?")) {
    return "image/jpeg";
  }
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  if (path.endsWith(".csv")) return "text/csv";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return null;
}

export function resolveMediaType(opts: {
  contentTypeHeader?: string | null;
  url?: string;
  filename?: string;
  bytes: Uint8Array;
}): string {
  const fromHeader = stripMimeParams(opts.contentTypeHeader);
  if (
    fromHeader &&
    fromHeader !== "application/octet-stream" &&
    fromHeader !== "binary/octet-stream"
  ) {
    return fromHeader === "image/jpg" ? "image/jpeg" : fromHeader;
  }
  const fromMagic = mimeFromMagic(opts.bytes);
  if (fromMagic) return fromMagic;
  if (opts.filename) {
    const fromName = mimeFromNameOrUrl(opts.filename);
    if (fromName) return fromName;
  }
  if (opts.url) {
    const fromUrl = mimeFromNameOrUrl(opts.url);
    if (fromUrl) return fromUrl;
  }
  return "application/octet-stream";
}

export function isImageMediaType(mediaType: string): boolean {
  const mime = stripMimeParams(mediaType);
  return IMAGE_MIME.has(mime) || mime.startsWith("image/");
}

function safeName(name: string): string {
  return (name || "file")
    .replace(/[^\w.\u4e00-\u9fff()-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
}

export function attachmentCacheDir(cwd: string): string {
  const base = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
  return join(base, "tmp", "feedback-workbench");
}

export const ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS = 3;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableFetchError(err: unknown): boolean {
  if (!err) return false;
  const error = err as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { name?: string; code?: string; message?: string };
  };
  const parts = [
    error.name,
    error.code,
    error.message,
    error.cause?.name,
    error.cause?.code,
    error.cause?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    parts.includes("connecttimeouterror") ||
    parts.includes("und_err_connect_timeout") ||
    parts.includes("connect timeout") ||
    parts.includes("etimedout") ||
    parts.includes("econnreset") ||
    parts.includes("econnrefused") ||
    parts.includes("enotfound") ||
    parts.includes("socket hang up") ||
    parts.includes("network") ||
    parts.includes("fetch failed")
  );
}

function retryDelayMs(attempt: number): number {
  return 150 * attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function downloadAndCacheAttachment(opts: {
  url: string;
  token?: string;
  cwd: string;
  feedbackId: number;
  filename?: string;
  preferredMediaType?: string | null;
  index?: number;
}): Promise<CachedAttachment | null> {
  const headers: Record<string, string> = { Accept: "*/*" };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
    headers["X-Admin-Token"] = opts.token;
    headers["X-Feedback-Token"] = opts.token;
  }

  for (let attempt = 1; attempt <= ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(opts.url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        if (
          isRetryableHttpStatus(res.status) &&
          attempt < ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS
        ) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        return null;
      }

      const buffer = new Uint8Array(await res.arrayBuffer());
      if (buffer.byteLength === 0) return null;

      const mediaType = resolveMediaType({
        contentTypeHeader: opts.preferredMediaType || res.headers.get("content-type"),
        url: opts.url,
        filename: opts.filename,
        bytes: buffer,
      });
      const ext = extForMime(mediaType, opts.filename || "");
      const dir = attachmentCacheDir(opts.cwd);
      await mkdir(dir, { recursive: true });

      const baseName = opts.filename ? safeName(opts.filename) : `file-${opts.index ?? 0}.${ext}`;
      const filename = baseName.includes(".") ? baseName : `${baseName}.${ext}`;
      const absPath = resolve(
        dir,
        `feedback-${opts.feedbackId}-${Date.now()}-${opts.index ?? 0}-${filename}`,
      );
      await writeFile(absPath, buffer);
      return {
        path: absPath,
        filename,
        mediaType,
        byteSize: buffer.byteLength,
        isImage: isImageMediaType(mediaType),
        sourceUrl: opts.url,
      };
    } catch (err) {
      if (isRetryableFetchError(err) && attempt < ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return null;
    }
  }

  return null;
}

type AttachmentCandidate = {
  url: string;
  filename?: string;
  contentType?: string | null;
};

function collectAttachmentCandidates(config: AgentConfig, item: FeedbackItem): AttachmentCandidate[] {
  const out: AttachmentCandidate[] = [];
  const seen = new Set<string>();

  const push = (url: string | null | undefined, filename?: string, contentType?: string | null) => {
    const trimmed = url?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ url: trimmed, filename, contentType });
  };

  for (const att of item.attachments || []) {
    let url = att.url?.trim() || "";
    if (!url && att.object_key) {
      url = att.object_key.startsWith("http")
        ? att.object_key
        : `${config.baseUrl.replace(/\/$/, "")}/files/${encodeURIComponent(att.object_key)}`;
    }
    push(url, att.filename, att.content_type);
  }

  push(item.screenshot_url, "screenshot.png", "image/png");
  if (item.image_object_key) {
    const key = item.image_object_key;
    push(
      key.startsWith("http")
        ? key
        : `${config.baseUrl.replace(/\/$/, "")}/files/${encodeURIComponent(key)}`,
      "screenshot.png",
      "image/png",
    );
  }

  return out;
}

export async function downloadAttachments(
  config: AgentConfig,
  item: FeedbackItem,
  cwd: string,
): Promise<{ files: CachedAttachment[]; notes: string[] }> {
  const candidates = collectAttachmentCandidates(config, item);
  const files: CachedAttachment[] = [];
  const notes: string[] = [];

  let index = 0;
  for (const candidate of candidates) {
    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(candidate.url, `${config.baseUrl.replace(/\/$/, "")}/`);
      if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:") {
        throw new Error(`unsupported attachment URL protocol: ${resolvedUrl.protocol}`);
      }
    } catch (err) {
      notes.push(
        `Failed to download: ${candidate.filename || candidate.url} (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    const apiOrigin = new URL(config.baseUrl).origin;
    const cached = await downloadAndCacheAttachment({
      url: resolvedUrl.toString(),
      token: resolvedUrl.origin === apiOrigin ? config.agentToken : undefined,
      cwd,
      feedbackId: item.id,
      filename: candidate.filename,
      preferredMediaType: candidate.contentType,
      index: index++,
    });
    if (!cached) {
      notes.push(`Failed to download: ${candidate.filename || candidate.url}`);
      continue;
    }
    files.push(cached);
  }

  return { files, notes };
}

export function formatAttachmentPathsBlock(files: CachedAttachment[]): string {
  if (!files.length) return "";
  const lines = files.map((file, index) => {
    const kind = file.isImage ? "image" : "file";
    return `${index + 1}. [${kind}] ${file.filename} (${file.mediaType}, ${file.byteSize} bytes)\n   absolute path: ${file.path}`;
  });
  return `\nAttachments saved under project tmp (absolute paths — open/read these files):\n${lines.join("\n")}\n`;
}
