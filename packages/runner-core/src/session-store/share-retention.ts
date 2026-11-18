import type { ShareStore } from "./share-store.js";

const SWEEP_MS = 60_000;

export interface ShareRetentionDeps {
  store: ShareStore;
  /** `RUNNER_SHARE_RETENTION_SECONDS`, in ms. */
  retentionMs: number;
  log: { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void };
  now?: () => Date;
}

/** The control plane's sweep: deletes a share that has not been connected for
 *  the retention window after its `lastActiveAt`. A connected share never expires. */
export class ShareRetention {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ShareRetentionDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep. Exposed for tests. */
  async tick(): Promise<string[]> {
    try {
      const ids = await this.deps.store.sweepExpiredShares((this.deps.now ?? (() => new Date()))(), this.deps.retentionMs);
      if (ids.length > 0) this.deps.log.info({ shares: ids }, "deleted shares past their retention");
      return ids;
    } catch (err) {
      this.deps.log.error({ err }, "the share retention sweep failed");
      return [];
    }
  }
}
