import { RuntimeError, toPlainJson } from "@telorun/sdk";
import { durationSetting } from "./duration-setting.js";
import { RemoteKeySet } from "./remote-key-set.js";

interface RemoteKeySetResource {
  metadata: { name: string };
  url?: unknown;
  issuer?: unknown;
  cacheTtl?: unknown;
  cooldown?: unknown;
  timeout?: unknown;
}

export function register(): void {}

export async function create(resource: RemoteKeySetResource) {
  const describe = `Jose.RemoteKeySet "${resource.metadata.name}"`;
  if ((resource.url === undefined) === (resource.issuer === undefined)) {
    throw new RuntimeError(
      "ERR_JOSE_REMOTE_KEYSET_SOURCE",
      `${describe}: declare either \`url\` (a JWKS) or \`issuer\` (discovered through its metadata), not both and not neither.`,
    );
  }
  return new RemoteKeySet({
    describe,
    url: resource.url === undefined ? undefined : (toPlainJson(resource.url) as string),
    issuer: resource.issuer === undefined ? undefined : (toPlainJson(resource.issuer) as string),
    cacheTtlMs: durationSetting(resource.cacheTtl, 600_000, () => `${describe}: 'cacheTtl'`),
    cooldownMs: durationSetting(resource.cooldown, 30_000, () => `${describe}: 'cooldown'`),
    timeoutMs: durationSetting(resource.timeout, 10_000, () => `${describe}: 'timeout'`),
  });
}
