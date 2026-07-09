import {
  type CancellationSource,
  type ControllerContext,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  isCancellationError,
  parseDurationMs,
  resolveInvocableDispatcher,
} from "@telorun/sdk";
import { type CacheStore, resolveCacheStore } from "@telorun/cache";
import { randomUUID } from "node:crypto";
import { Mutex } from "./mutex.js";

interface CriticalResource {
  metadata: { name: string; module?: string };
  store?: CacheStore | { name: string; alias?: string };
  ttl: string;
  detach?: boolean;
  invoke?: unknown;
}

interface CriticalInputs {
  op?: "run" | "cancel";
  key: string;
  holder?: string;
  inputs?: Record<string, unknown>;
}

interface CriticalResult {
  acquired: boolean;
  holder?: unknown;
  result?: unknown;
  cancelled?: boolean;
}

/** A detached body currently running under this instance's lease for a key. */
interface ActiveRun {
  holder: unknown;
  source: CancellationSource;
}

/**
 * Lease.Critical — a declarative critical section. Acquires a keyed lease, runs
 * the wrapped `invoke` body under it, and releases automatically; the caller
 * never issues acquire/release. Synchronous mode releases when the body returns
 * (or throws); `detach` mode dispatches the body detached, holds the lease
 * across it, and releases on its terminal — so a lease can span a background
 * operation that outlives the call while the acquire outcome is still returned
 * synchronously (for a 200-vs-409 branch).
 *
 * A detached body runs under an instance-owned cancellation scope, so a later
 * `op: cancel` for the same key cancels it cooperatively (every honoring leaf —
 * a model call, a timer, a fetch — aborts and the lease releases on the body's
 * terminal). Cancellation state is process-local: the cancel must reach the
 * instance that dispatched the body.
 */
class LeaseCritical implements ResourceInstance<CriticalInputs, CriticalResult> {
  private readonly ttlMs: number;
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly resource: CriticalResource,
    private readonly ctx: ResourceContext,
  ) {
    this.ttlMs = parseDurationMs(resource.ttl);
  }

  async invoke(inputs: CriticalInputs, _ctx?: InvokeContext): Promise<CriticalResult> {
    const name = this.resource.metadata.name;
    if (!inputs || typeof inputs.key !== "string" || inputs.key.length === 0) {
      // Fail closed: an empty key must not collapse every caller into one lease.
      return { acquired: false };
    }
    if (inputs.op === "cancel") return this.cancelActive(inputs);

    const store = resolveCacheStore(this.resource.store, this.ctx);
    const mutex = new Mutex(store, name, this.ttlMs);
    // The holder token is both the 409 payload and the release guard — unique
    // per acquisition so a stale holder can't free another owner's lease.
    const holder = inputs.holder ?? randomUUID();

    const acq = await mutex.acquire(inputs.key, holder);
    if (!acq.acquired) return { acquired: false, holder: acq.holder ?? null };

    const dispatch = resolveInvocableDispatcher(
      this.resource.invoke,
      this.ctx,
      () => `Lease.Critical "${name}"`,
    );
    const bodyInputs = inputs.inputs ?? {};

    if (this.resource.detach) {
      // Hold the lease across a detached body — the lease resource owns the
      // detach so the hold outlives this call; release on the body's terminal.
      // The body runs under an instance-owned cancellation scope so `op: cancel`
      // for this key can end it early.
      const source = this.ctx.createCancellationSource();
      this.active.set(inputs.key, { holder, source });
      this.ctx.runDetached(async () => {
        try {
          await dispatch(bodyInputs, source.context);
        } catch (err) {
          // A body ending because this instance cancelled it is the expected
          // `op: cancel` terminal, not a failure; every other error still
          // propagates to the detached error route.
          if (!(source.token.isCancelled && isCancellationError(err))) throw err;
        } finally {
          this.active.delete(inputs.key);
          source.dispose();
          await mutex.release(inputs.key, holder);
        }
      });
      return { acquired: true, holder: null };
    }

    try {
      const result = await dispatch(bodyInputs);
      return { acquired: true, holder: null, result };
    } finally {
      await mutex.release(inputs.key, holder);
    }
  }

  /** `op: cancel` — cancel the detached body running under `key`, if any. When
   *  `holder` is supplied it must match the running holder (so a stale caller
   *  can't kill a newer occupant); the current holder is reported either way. */
  private cancelActive(inputs: CriticalInputs): CriticalResult {
    const name = this.resource.metadata.name;
    const run = this.active.get(inputs.key);
    if (!run) return { acquired: false, cancelled: false };
    if (inputs.holder != null && inputs.holder !== run.holder) {
      return { acquired: false, cancelled: false, holder: run.holder };
    }
    run.source.cancel(`Lease.Critical "${name}": '${inputs.key}' cancelled by caller`);
    return { acquired: false, cancelled: true, holder: run.holder };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: CriticalResource,
  ctx: ResourceContext,
): Promise<LeaseCritical> {
  return new LeaseCritical(resource, ctx);
}
