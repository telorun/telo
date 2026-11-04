import type { KvStore } from "@telorun/kv-store";
import { RuntimeError, type ResourceContext } from "@telorun/sdk";
import { durationSetting } from "./duration-setting.js";
import { ManagedKeySet } from "./managed-key-set.js";
import { sealingKey } from "./sealing.js";
import { StaticKeySet } from "./static-key-set.js";
import type { SigningAlgorithm } from "./jwk-selection.js";

interface KeySetResource {
  metadata: { name: string };
  algorithm?: SigningAlgorithm;
  name?: string;
  store?: unknown;
  wrapKey?: string;
  rotation?: { every?: unknown; retireAfter: unknown };
  cacheTtl?: unknown;
  keys?: unknown[];
}

function isKvStore(value: unknown): value is KvStore {
  const candidate = value as Partial<KvStore> | null | undefined;
  return (
    !!candidate &&
    typeof candidate.get === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.compareAndSet === "function" &&
    typeof candidate.compareAndDelete === "function"
  );
}

export function register(): void {}

export async function create(resource: KeySetResource, ctx: ResourceContext) {
  const describe = `Jose.KeySet "${resource.metadata.name}"`;
  const algorithm = resource.algorithm ?? "ES256";
  const managed = resource.store !== undefined;
  if (managed === (resource.keys !== undefined)) {
    throw new RuntimeError(
      "ERR_JOSE_KEYSET_FORM",
      `${describe}: declare either \`store\` (a managed, rotating set) or \`keys\` (a static set), not both and not neither.`,
    );
  }
  return managed
    ? new ManagedKeySet({
        describe,
        store: () =>
          ctx.resolveRef(resource.store, isKvStore, () => `${describe}: 'store'`, "KvStore.Store"),
        storeKey: `jose/keyset/${resource.name}`,
        wrapKey: sealingKey(resource.wrapKey!, `keyset-wrap:${resource.name}`),
        algorithm,
        rotateEveryMs: durationSetting(resource.rotation?.every, 0, () => `${describe}: 'rotation.every'`),
        retireAfterMs: durationSetting(resource.rotation?.retireAfter, 0, () => `${describe}: 'rotation.retireAfter'`),
        cacheTtlMs: durationSetting(resource.cacheTtl, 30_000, () => `${describe}: 'cacheTtl'`),
      })
    : StaticKeySet.create(describe, algorithm, resource.keys!);
}
