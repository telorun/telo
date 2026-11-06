import { RuntimeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import type {
  BroadcastChannel,
  BroadcastListener,
  BroadcastSettings,
  BroadcastSubscriptionHandle,
} from "./broadcast-channel-contract.js";
import { broadcastSettingsOf } from "./broadcast-settings.js";

/** Listeners by kernel instance, then channel name: two resources naming one
 *  channel in one running application are one channel, and no application
 *  shares one with another. An entry goes when its last listener leaves. */
const listenersByInstance = new Map<string, Map<string, Set<BroadcastListener>>>();

/** Listeners registered across every kernel instance and channel; exposed for tests. */
export function registeredChannelCount(): number {
  let count = 0;
  for (const channels of listenersByInstance.values()) count += channels.size;
  return count;
}

interface MemoryChannelResource {
  metadata: { name: string; module?: string };
  name: string;
  messageType: unknown;
  maxBytes?: number;
}

/**
 * Broadcast.MemoryChannel — delivery within one running application. A publish
 * reaches every subscription live on the same channel name at once, in call order;
 * there is no connection to lose, so it never reports a gap by itself.
 */
class MemoryChannel implements BroadcastChannel, ResourceInstance {
  private readonly channelSettings: BroadcastSettings;

  constructor(
    resource: MemoryChannelResource,
    ctx: ResourceContext,
    private readonly instanceId: string,
  ) {
    this.channelSettings = broadcastSettingsOf(resource, ctx);
  }

  settings(): BroadcastSettings {
    return this.channelSettings;
  }

  async publish(payload: string): Promise<void> {
    const listeners = listenersByInstance.get(this.instanceId)?.get(this.channelSettings.name);
    if (!listeners) return;
    for (const listener of [...listeners]) listener.receive(payload);
  }

  subscribe(listener: BroadcastListener): BroadcastSubscriptionHandle {
    const { name } = this.channelSettings;
    const instanceId = this.instanceId;
    let channels = listenersByInstance.get(instanceId);
    if (!channels) listenersByInstance.set(instanceId, (channels = new Map()));
    let listeners = channels.get(name);
    if (!listeners) channels.set(name, (listeners = new Set()));
    listeners.add(listener);
    return {
      close: () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        channels.delete(name);
        if (channels.size === 0) listenersByInstance.delete(instanceId);
      },
    };
  }

  async provide(): Promise<MemoryChannel> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(resource: MemoryChannelResource, ctx: ResourceContext): Promise<MemoryChannel> {
  const instanceId: unknown = ctx.kernelInstanceId;
  if (typeof instanceId !== "string") {
    throw new RuntimeError(
      "ERR_CONTROLLER_HOST_INCOMPATIBLE",
      `Broadcast.MemoryChannel "${resource.metadata.name}": this host does not name the kernel instance ` +
        "(ctx.kernelInstanceId), which scopes the channel to one running application.",
    );
  }
  return new MemoryChannel(resource, ctx, instanceId);
}
