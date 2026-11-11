import {
  durationNanos,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  isCelDuration,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { isRendezvousPoint, type RendezvousPoint } from "./rendezvous-point-contract.js";

export const ERR_RENDEZVOUS_AWAIT_TIMEOUT = "ERR_RENDEZVOUS_AWAIT_TIMEOUT";
export const ERR_RENDEZVOUS_KEY_BUSY = "ERR_RENDEZVOUS_KEY_BUSY";

const NANOS_PER_MILLISECOND = 1_000_000n;

interface AwaitResource {
  metadata: { name: string; module?: string };
  point?: RendezvousPoint | KindRef<RendezvousPoint>;
  timeout?: unknown;
}

interface AwaitInputs {
  key: string;
}

/**
 * Rendezvous.Await — hold the call until a value is delivered under the key, or
 * until `timeout`. A timeout raises; a cancelled call releases its waiter,
 * consuming nothing, and rethrows the cancellation.
 */
class RendezvousAwait implements ResourceInstance<AwaitInputs, unknown> {
  private readonly timeoutMs: number;

  constructor(
    private readonly resource: AwaitResource,
    private readonly ctx: ResourceContext,
  ) {
    if (!isCelDuration(resource.timeout)) throw new Error(`${this.label}: 'timeout' must be a duration`);
    this.timeoutMs = Math.max(0, Number(durationNanos(resource.timeout) / NANOS_PER_MILLISECOND));
  }

  private get label(): string {
    return `Rendezvous.Await "${this.resource.metadata.name}"`;
  }

  async invoke(inputs: AwaitInputs, invokeCtx?: InvokeContext): Promise<unknown> {
    const point = this.ctx.resolveRef(
      this.resource.point,
      isRendezvousPoint,
      () => `${this.label}: 'point'`,
      "Rendezvous.Point",
    );
    const result = await point.take(inputs.key, this.timeoutMs, invokeCtx);
    switch (result.outcome) {
      case "taken":
        return result.payload;
      case "timedOut":
        throw new InvokeError(
          ERR_RENDEZVOUS_AWAIT_TIMEOUT,
          `${this.label}: nothing was delivered under key '${inputs.key}' within ${this.timeoutMs} ms`,
          { key: inputs.key },
        );
      case "busy":
        throw new InvokeError(
          ERR_RENDEZVOUS_KEY_BUSY,
          `${this.label}: another call is already waiting under key '${inputs.key}'`,
          { key: inputs.key },
        );
      case "cancelled": {
        const reason = invokeCtx?.cancellation.reason;
        throw new InvokeError(
          ERR_INVOKE_CANCELLED,
          `${this.label}: cancelled while waiting under key '${inputs.key}'` +
            (reason ? ` (${reason})` : ""),
        );
      }
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: AwaitResource, ctx: ResourceContext): Promise<RendezvousAwait> {
  return new RendezvousAwait(resource, ctx);
}
