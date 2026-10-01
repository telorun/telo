import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isWatchStore, versionInput, type WatchStore } from "./watch-store-contract.js";

interface PublishResource {
  metadata: { name: string; module?: string };
  store?: WatchStore | KindRef<WatchStore>;
}

interface PublishInputs {
  topic: string;
  version: unknown;
}

/** Watch.Publish — raise a topic's version monotonically and wake the waiters
 *  whose cursor it passes. */
class WatchPublish implements ResourceInstance<PublishInputs, void> {
  constructor(
    private readonly resource: PublishResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: PublishInputs): Promise<void> {
    const label = `Watch.Publish "${this.resource.metadata.name}"`;
    const store = this.ctx.resolveRef(
      this.resource.store,
      isWatchStore,
      () => `${label}: 'store'`,
      "Watch.Store",
    );
    const version = versionInput(inputs.version, () => `${label}: 'version'`);
    await store.raise(inputs.topic, version);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: PublishResource,
  ctx: ResourceContext,
): Promise<WatchPublish> {
  return new WatchPublish(resource, ctx);
}
