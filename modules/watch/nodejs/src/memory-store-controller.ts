import type { CancellationToken, ResourceContext, ResourceInstance } from "@telorun/sdk";
import type { WatchSignal, WatchStore } from "./watch-store-contract.js";

/** The longest delay a Node timer holds; a longer wait re-arms until its deadline. */
const MAX_TIMER_MS = 2_147_483_647;

interface MemoryStoreResource {
  metadata: { name: string; module?: string };
  /** Filled from the schema's default when the manifest omits it. */
  maxTopics: number;
}

interface Waiter {
  readonly after: bigint;
  settle(changed: boolean): void;
}

interface Topic {
  version: bigint;
  readonly waiters: Set<Waiter>;
}

/**
 * Watch.MemoryStore — topic versions and their waiters in this process's
 * memory. Every operation runs to completion without an `await`, so a raise
 * and a wait cannot interleave: a wait opened after a raise sees its version.
 *
 * A topic nobody waits on sits in `idle`, least recently raised first; beyond
 * `maxTopics` idle topics the oldest are forgotten. A topic with waiters is
 * outside that order and is never forgotten; when its last waiter leaves it
 * re-enters at the most recent end. A forgotten topic reads as version 0.
 */
class MemoryWatchStore implements WatchStore, ResourceInstance {
  private readonly topics = new Map<string, Topic>();
  private readonly idle = new Map<string, Topic>();
  private readonly maxTopics: number;

  constructor(resource: MemoryStoreResource) {
    this.maxTopics = resource.maxTopics;
  }

  init(ctx: ResourceContext) {
    return ctx.effect("pending waiters", async () => ({
      result: undefined,
      // A waiter released early reads as a timeout: its caller re-reads its
      // source of truth, which is always correct for a wake-up signal.
      inverse: () => {
        for (const topic of [...this.topics.values()]) {
          for (const waiter of [...topic.waiters]) waiter.settle(false);
        }
      },
    }));
  }

  async raise(topic: string, version: bigint): Promise<void> {
    const current = this.topics.get(topic);
    if (current && version <= current.version) return;
    const entry: Topic = current ?? { version, waiters: new Set() };
    entry.version = version;
    this.topics.set(topic, entry);
    if (entry.waiters.size === 0) this.markIdle(topic, entry);
    for (const waiter of [...entry.waiters]) {
      if (waiter.after < version) waiter.settle(true);
    }
  }

  wait(
    topic: string,
    after: bigint,
    timeoutMs: number,
    cancellation: CancellationToken,
  ): Promise<WatchSignal> {
    const existing = this.topics.get(topic);
    const known = existing?.version ?? 0n;
    if (known > after) return Promise.resolve({ changed: true, version: known });
    if (cancellation.isCancelled || timeoutMs <= 0) {
      return Promise.resolve({ changed: false, version: known });
    }
    const entry: Topic = existing ?? { version: 0n, waiters: new Set() };
    this.topics.set(topic, entry);
    this.idle.delete(topic);

    return new Promise<WatchSignal>((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      let settled = false;
      const arm = () => {
        timer = setTimeout(() => {
          if (Date.now() >= deadline) waiter.settle(false);
          else arm();
        }, Math.min(deadline - Date.now(), MAX_TIMER_MS));
      };
      const waiter: Waiter = {
        after,
        settle: (changed) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          entry.waiters.delete(waiter);
          if (entry.waiters.size === 0) this.markIdle(topic, entry);
          resolve({ changed, version: entry.version });
        },
      };
      entry.waiters.add(waiter);
      arm();
      unsubscribe = cancellation.onCancelled(() => waiter.settle(false));
    });
  }

  /** Move a topic nobody waits on to the most recent end of the eviction order,
   *  then forget from the oldest end while there are more than `maxTopics`. */
  private markIdle(topic: string, entry: Topic): void {
    this.idle.delete(topic);
    this.idle.set(topic, entry);
    while (this.idle.size > this.maxTopics) {
      const oldest = this.idle.keys().next().value as string;
      this.idle.delete(oldest);
      this.topics.delete(oldest);
    }
  }

  async provide(): Promise<MemoryWatchStore> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: MemoryStoreResource): Promise<MemoryWatchStore> {
  return new MemoryWatchStore(resource);
}
