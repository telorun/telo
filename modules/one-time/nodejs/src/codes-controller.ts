import type { ResourceContext } from "@telorun/sdk";
import { CodeSet, isKvStore, settingsOf, type TokenSetResource } from "./token-set.js";

interface CodesResource extends TokenSetResource {
  digits?: number;
  maxAttempts?: number;
}

export async function create(resource: CodesResource, ctx: ResourceContext): Promise<CodeSet> {
  const describe = `OneTime.Codes "${resource.metadata.name}"`;
  const settings = settingsOf(resource, describe);
  const store = ctx.resolveRef(resource.store, isKvStore, () => `${describe}: 'store'`, "KvStore.Store");
  return new CodeSet(store, settings, resource.digits ?? 6, resource.maxAttempts ?? 5, describe);
}

export function register(): void {}
