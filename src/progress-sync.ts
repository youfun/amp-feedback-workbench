import { isAbsolute, relative } from "node:path";
import type { FeedbackActor } from "./types.js";

export type ProgressActor = FeedbackActor;

export type ProgressCommentClient = {
  addComment: (
    id: number,
    actor: ProgressActor,
    note: string,
    meta?: Record<string, unknown> | null,
  ) => Promise<unknown>;
};

export type ProgressSyncOptions = {
  throttleMs?: number;
  now?: () => number;
  enabled?: boolean;
};

export function toRepoRelativePath(filePath: string, cwd?: string | null): string {
  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;

  const posix = (value: string) => value.replace(/\\/g, "/");
  if (!cwd || !cwd.trim()) return posix(trimmed);
  if (!isAbsolute(trimmed)) {
    const rel = posix(trimmed);
    return rel.startsWith("./") ? rel.slice(2) : rel;
  }

  const rel = relative(cwd.trim(), trimmed);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return posix(trimmed);
  }
  return posix(rel);
}

export function formatProgressComment(opts: {
  toolName: string;
  filePath: string;
  source?: string;
}): string {
  const via = opts.source ? ` via ${opts.source}` : "";
  return `[progress] tool=${opts.toolName} file=${opts.filePath}${via}`;
}

export class ThreadProgressTracker {
  private claimed: number | null = null;
  private generation = 0;
  private files = new Set<string>();
  private lastCommentAt = new Map<string, number>();
  private enabled: boolean;
  private throttleMs: number;
  private now: () => number;

  constructor(opts: ProgressSyncOptions = {}) {
    this.throttleMs = opts.throttleMs ?? 8_000;
    this.now = opts.now ?? (() => Date.now());
    this.enabled = opts.enabled ?? true;
  }

  setClaimed(id: number | null): void {
    this.claimed = id;
    this.generation += 1;
    this.files.clear();
    this.lastCommentAt.clear();
  }

  claimedId(): number | null {
    return this.claimed;
  }

  claimGeneration(): number {
    return this.generation;
  }

  matchesClaim(id: number, generation: number): boolean {
    return this.claimed === id && this.generation === generation;
  }

  clearChangedFiles(): void {
    this.files.clear();
    this.lastCommentAt.clear();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  changedFiles(): string[] {
    return [...this.files].sort();
  }

  recordFile(path: string, cwd?: string | null): boolean {
    if (!this.enabled || this.claimed == null) return false;
    const normalized = toRepoRelativePath(path, cwd);
    if (!normalized || this.files.has(normalized)) return false;
    this.files.add(normalized);
    return true;
  }

  async recordAndCommentFiles(args: {
    toolName: string;
    filePaths: string[];
    client: ProgressCommentClient;
    actor: ProgressActor;
    source?: string;
    cwd?: string | null;
    meta?: Record<string, unknown> | null;
    expectedClaim?: { id: number; generation: number };
  }): Promise<void> {
    if (!this.enabled || this.claimed == null) return;
    const claimId = args.expectedClaim?.id ?? this.claimed;
    const claimGeneration = args.expectedClaim?.generation ?? this.generation;
    if (!this.matchesClaim(claimId, claimGeneration)) return;

    for (const filePath of args.filePaths) {
      if (!this.matchesClaim(claimId, claimGeneration)) return;
      const file = toRepoRelativePath(filePath, args.cwd);
      if (!file) continue;
      this.files.add(file);

      const now = this.now();
      const last = this.lastCommentAt.get(file);
      if (last !== undefined && now - last < this.throttleMs) continue;
      this.lastCommentAt.set(file, now);

      try {
        await args.client.addComment(
          claimId,
          args.actor,
          formatProgressComment({
            toolName: args.toolName,
            filePath: file,
            source: args.source,
          }),
          args.meta,
        );
      } catch {
        // non-fatal
      }
      if (!this.matchesClaim(claimId, claimGeneration)) return;
    }
  }
}
