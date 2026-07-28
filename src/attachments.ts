import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig, FeedbackItem } from "./types.ts";

export type CachedAttachment = {
  path: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  sourceUrl: string;
};

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file.bin";
}

export async function downloadAttachments(
  config: AgentConfig,
  item: FeedbackItem,
  cwd: string,
): Promise<{ files: CachedAttachment[]; notes: string[] }> {
  const files: CachedAttachment[] = [];
  const notes: string[] = [];
  const candidates: { url: string; filename: string; contentType?: string }[] = [];
  const seen = new Set<string>();

  const push = (url?: string | null, filename?: string, contentType?: string) => {
    const u = url?.trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    candidates.push({
      url: u,
      filename: filename || "attachment.bin",
      contentType,
    });
  };

  for (const att of item.attachments || []) {
    let url = att.url?.trim() || "";
    if (!url && att.object_key) {
      url = att.object_key.startsWith("http")
        ? att.object_key
        : `${config.baseUrl}/files/${encodeURIComponent(att.object_key)}`;
    }
    push(url, att.filename, att.content_type);
  }
  push(item.screenshot_url, "screenshot.png", "image/png");
  if (item.image_object_key) {
    const key = item.image_object_key;
    const derived = key.startsWith("http")
      ? key
      : `${config.baseUrl}/files/${encodeURIComponent(key)}`;
    push(derived, "screenshot.png", "image/png");
  }

  if (!candidates.length) return { files, notes };

  const dir = join(cwd, "tmp", "feedback-workbench");
  await mkdir(dir, { recursive: true });
  const ts = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    try {
      const res = await fetch(c.url, {
        headers: {
          Authorization: `Bearer ${config.agentToken}`,
          Accept: "*/*",
          "User-Agent": "amp-feedback-workbench/1.0 (+local-agent)",
        },
      });
      if (!res.ok) {
        notes.push(`Failed ${c.filename}: HTTP ${res.status}`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const mediaType =
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        c.contentType ||
        "application/octet-stream";
      const filename = safeName(c.filename);
      const path = join(dir, `feedback-${item.id}-${ts}-${i}-${filename}`);
      await writeFile(path, buf);
      files.push({
        path,
        filename,
        mediaType,
        byteSize: buf.byteLength,
        sourceUrl: c.url,
      });
    } catch (err) {
      notes.push(
        `Failed ${c.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { files, notes };
}

export function formatAttachmentPathsBlock(files: CachedAttachment[]): string {
  if (!files.length) return "";
  return (
    "\nLocal attachment paths:\n" +
    files.map((f) => `- ${f.path} (${f.mediaType}, ${f.byteSize} bytes)`).join("\n") +
    "\n"
  );
}
