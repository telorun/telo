import type { SessionEntry, SessionRegistry } from "./registry.js";

export interface WatchSupervisorDeps {
  registry: SessionRegistry;
  /** No SSE/WS subscriber for this long → suspend. */
  idleMs: number;
  /** How often to pull a whole-tree workspace snapshot. */
  checkpointMs: number;
  log?: { warn(obj: unknown, msg: string): void };
}

/** How often the supervisor wakes. Both of its jobs are coarse — a checkpoint
 *  cadence and an idle window, both measured in minutes — so a fine tick would
 *  buy nothing but wakeups. */
const TICK_MS = 5_000;

/**
 * The two background jobs that make a watch session affordable, and they only
 * work as a pair: a periodic workspace checkpoint, and an idle reap that deletes
 * the pod while keeping the session record and that checkpoint.
 *
 * Aggressive reaping is what makes per-visitor watch sessions affordable, and
 * the checkpoint is what makes aggressive reaping safe to do.
 *
 * The checkpoint is a CACHE, never the only copy. The runner is a single replica
 * with an in-memory registry, so a redeploy or crash drops every suspended
 * session — the editor holds the authoritative workspace, already diffs its own
 * files against `GET /workspace`, and on a `404` at resume creates a new session
 * and re-seeds from its own copy in one change set. What the checkpoint saves is
 * that upload.
 */
export class WatchSupervisor {
  private timer: NodeJS.Timeout | null = null;
  /** Sessions with a checkpoint or suspend in flight, so a slow snapshot cannot
   *  have a second one started on top of it every tick. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: WatchSupervisorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests, which drive the clock rather than waiting on it. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const entry of this.deps.registry.list()) {
      if (entry.mode !== "watch") continue;
      if (entry.status.kind !== "running") continue;
      if (this.busy.has(entry.sessionId)) continue;

      const idle =
        entry.subscribers === 0 &&
        entry.idleSince !== null &&
        now - entry.idleSince >= this.deps.idleMs;

      if (idle) {
        void this.run(entry, () => this.suspend(entry));
      } else if (
        entry.checkpointedAt === null ||
        now - entry.checkpointedAt >= this.deps.checkpointMs
      ) {
        void this.run(entry, () => this.checkpoint(entry));
      }
    }
  }

  private async run(entry: SessionEntry, job: () => Promise<void>): Promise<void> {
    this.busy.add(entry.sessionId);
    try {
      await job();
    } catch (err) {
      // A failed checkpoint is not a failed session: the editor still holds the
      // authoritative copy, and the next tick retries. Reported rather than
      // swallowed so an operator sees a workspace that has stopped answering.
      this.deps.log?.warn(
        { err, sessionId: entry.sessionId },
        "watch session checkpoint/suspend failed",
      );
    } finally {
      this.busy.delete(entry.sessionId);
    }
  }

  private async checkpoint(entry: SessionEntry): Promise<void> {
    const workspace = entry.session?.workspace;
    if (!workspace) return;
    const files = await workspace.snapshot();
    entry.checkpoint = { takenAt: new Date(), files };
    entry.checkpointedAt = Date.now();
  }

  private async suspend(entry: SessionEntry): Promise<void> {
    const session = entry.session;
    if (!session?.suspend) return;
    // Snapshot BEFORE the pod goes: the volume dies with it. A snapshot that
    // fails aborts the suspend rather than taking the pod down with an older
    // checkpoint — the session stays up and the next tick tries again.
    await this.checkpoint(entry);
    await session.suspend();
    entry.session = null;
    this.deps.registry.emit(entry.sessionId, { type: "status", status: { kind: "suspended" } });
  }
}
