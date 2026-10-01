import {
  Duration,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  NEVER_CANCELLED,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import {
  isWatchStore,
  versionInput,
  type WatchSignal,
  type WatchStore,
} from "./watch-store-contract.js";

interface WaitResource {
  metadata: { name: string; module?: string };
  store?: WatchStore | KindRef<WatchStore>;
  maxTimeout?: unknown;
}

interface WaitInputs {
  topic: string;
  after: unknown;
  timeout: unknown;
}

function milliseconds(value: unknown, describe: () => string): number {
  if (!(value instanceof Duration)) throw new Error(`${describe()} must be a duration`);
  return Math.max(0, Number(value.getMilliseconds()));
}

/**
 * Watch.Wait — hold the call until a topic's version passes the caller's
 * cursor, or until `min(timeout, maxTimeout)`. Running out of time is a
 * result, never an error; a cancelled call releases its waiter and rethrows
 * the cancellation.
 */
class WatchWait implements ResourceInstance<WaitInputs, WatchSignal> {
  private readonly maxTimeoutMs: number;

  constructor(
    private readonly resource: WaitResource,
    private readonly ctx: ResourceContext,
  ) {
    this.maxTimeoutMs = milliseconds(resource.maxTimeout, () => `${this.label}: 'maxTimeout'`);
  }

  private get label(): string {
    return `Watch.Wait "${this.resource.metadata.name}"`;
  }

  async invoke(inputs: WaitInputs, invokeCtx?: InvokeContext): Promise<WatchSignal> {
    this.refuseReplayedZone(invokeCtx);
    const store = this.ctx.resolveRef(
      this.resource.store,
      isWatchStore,
      () => `${this.label}: 'store'`,
      "Watch.Store",
    );
    const after = versionInput(inputs.after, () => `${this.label}: 'after'`);
    const timeoutMs = Math.min(
      milliseconds(inputs.timeout, () => `${this.label}: 'timeout'`),
      this.maxTimeoutMs,
    );
    const cancellation = invokeCtx?.cancellation ?? NEVER_CANCELLED;
    const signal = await store.wait(inputs.topic, after, timeoutMs, cancellation);
    if (cancellation.isCancelled) {
      throw new InvokeError(
        ERR_INVOKE_CANCELLED,
        `${this.label}: cancelled while waiting on topic '${inputs.topic}'` +
          (cancellation.reason ? ` (${cancellation.reason})` : ""),
      );
    }
    return signal;
  }

  /** The runtime half of `x-telo-violates-zone: replayed`, for a path the static
   *  check could not trace. */
  private refuseReplayedZone(invokeCtx: InvokeContext | undefined): void {
    for (const zone of this.ctx.zoneAttributes(invokeCtx)) {
      const reason = zone.attributes.replayed;
      if (!reason) continue;
      throw new InvokeError(
        "ERR_WATCH_REPLAY_FORBIDDEN",
        `${this.label} is inside a ${zone.kind} zone whose body is replayed (${reason}), but a ` +
          `wait lives only in the memory of the call that opened it. Wait for a delivery with ` +
          `Durable.Await inside a durable run instead.`,
        { zone: zone.kind, reason },
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: WaitResource, ctx: ResourceContext): Promise<WatchWait> {
  return new WatchWait(resource, ctx);
}
