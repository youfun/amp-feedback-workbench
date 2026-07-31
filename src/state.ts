import type { ThreadID } from "@ampcode/plugin";
import { ThreadProgressTracker } from "./progress-sync.js";

export class ThreadStateStore {
  private readonly states = new Map<ThreadID, ThreadProgressTracker>();

  get(threadId: ThreadID): ThreadProgressTracker {
    let state = this.states.get(threadId);
    if (!state) {
      state = new ThreadProgressTracker({ enabled: true });
      this.states.set(threadId, state);
    }
    return state;
  }

  maybe(threadId: ThreadID | undefined): ThreadProgressTracker | undefined {
    return threadId ? this.states.get(threadId) : undefined;
  }

  delete(threadId: ThreadID): void {
    this.states.delete(threadId);
  }

  clear(): void {
    this.states.clear();
  }
}
