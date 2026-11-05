import {
  InvokeError,
  isCancellationError,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { isBroadcastChannel, type BroadcastChannel } from "./broadcast-channel-contract.js";
import { encodeBroadcastPayload, payloadBytes } from "./broadcast-payload.js";

export const ERR_BROADCAST_UNAVAILABLE = "ERR_BROADCAST_UNAVAILABLE";
export const ERR_BROADCAST_MESSAGE_TOO_LARGE = "ERR_BROADCAST_MESSAGE_TOO_LARGE";

interface PublishResource {
  metadata: { name: string; module?: string };
  channel?: BroadcastChannel | KindRef<BroadcastChannel>;
}

interface PublishInputs {
  message: unknown;
  topic?: string | null;
}

/** Broadcast.Publish — send one message, with an optional topic, on a channel.
 *  The channel gets the invocation's context so a backend with transactions can
 *  deliver on the caller's commit. */
class BroadcastPublish implements ResourceInstance<PublishInputs, void> {
  private readonly describe: string;

  constructor(
    private readonly resource: PublishResource,
    private readonly ctx: ResourceContext,
  ) {
    this.describe = `Broadcast.Publish "${resource.metadata.name}"`;
  }

  async invoke(inputs: PublishInputs, invokeCtx?: InvokeContext): Promise<void> {
    const channel = this.ctx.resolveRef(
      this.resource.channel,
      isBroadcastChannel,
      () => `${this.describe}: 'channel'`,
      "Broadcast.Channel",
    );
    const { maxBytes } = channel.settings();
    const payload = encodeBroadcastPayload(inputs.topic ?? null, inputs.message);
    const bytes = payloadBytes(payload);
    if (bytes > maxBytes) {
      throw new InvokeError(
        ERR_BROADCAST_MESSAGE_TOO_LARGE,
        `${this.describe}: the message encodes to ${bytes} bytes, its topic included, over the ` +
          `channel's maxBytes of ${maxBytes}; nothing was sent.`,
        { bytes, maxBytes },
      );
    }
    try {
      await channel.publish(payload, invokeCtx);
    } catch (err) {
      throw sendFailure(this.describe, err);
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** A cancellation passes as it is; any other failure of the channel is raised as
 *  the retryable `ERR_BROADCAST_UNAVAILABLE`, the original as its cause. */
function sendFailure(describe: string, err: unknown): unknown {
  if (isCancellationError(err)) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new InvokeError(
    ERR_BROADCAST_UNAVAILABLE,
    `${describe}: the channel could not send — ${reason}`,
    undefined,
    { cause: err },
  );
}

export async function create(resource: PublishResource, ctx: ResourceContext): Promise<BroadcastPublish> {
  return new BroadcastPublish(resource, ctx);
}
