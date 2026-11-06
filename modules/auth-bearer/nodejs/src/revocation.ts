import { InvokeError } from "@telorun/sdk";
import type { KvStore } from "@telorun/kv-store";

/** The record naming a revoked token; shared by the verifier that reads it and `Revoke` that writes it. */
export function revocationKey(jti: string): string {
  return `auth-bearer:revoked:${jti}`;
}

export async function isRevoked(store: KvStore, jti: string): Promise<boolean> {
  return (await store.get(revocationKey(jti))) !== null;
}

const MAX_ATTEMPTS = 8;

/** Records `jti` as revoked until `untilMs`, never shortening an existing record. */
export async function revoke(store: KvStore, jti: string, untilMs: number, nowMs: number): Promise<boolean> {
  const ttlMs = untilMs - nowMs;
  if (ttlMs <= 0) return false;
  const key = revocationKey(jti);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if ((await store.putIfAbsent(key, { until: untilMs }, ttlMs)) !== null) return true;
    const existing = await store.get(key);
    if (existing === null) continue;
    const current = (existing.value as { until?: number } | null)?.until;
    if (typeof current === "number" && current >= untilMs) return true;
    if ((await store.compareAndSet(key, existing.version, { until: untilMs }, ttlMs)) !== null) return true;
  }
  throw new InvokeError(
    "ERR_AUTH_BEARER_REVOKE_CONTENDED",
    `the revocation record for '${jti}' kept changing under concurrent writers`,
  );
}
