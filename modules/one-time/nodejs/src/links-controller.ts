import type { ResourceContext } from "@telorun/sdk";
import { isKvStore, LinkSet, settingsOf, type TokenSetResource } from "./token-set.js";

interface LinksResource extends TokenSetResource {
  bytes?: number;
}

export async function create(resource: LinksResource, ctx: ResourceContext): Promise<LinkSet> {
  const describe = `OneTime.Links "${resource.metadata.name}"`;
  const settings = settingsOf(resource, describe);
  const store = ctx.resolveRef(resource.store, isKvStore, () => `${describe}: 'store'`, "KvStore.Store");
  return new LinkSet(store, settings, resource.bytes ?? 32, describe);
}

export function register(): void {}
