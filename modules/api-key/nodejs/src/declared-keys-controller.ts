import { RuntimeError, type CelTimestamp, type ResourceInstance } from "@telorun/sdk";
import { timestampOfMillis } from "./instants.js";
import { DIGEST_PATTERN, PUBLIC_ID_PATTERN, uuidOfPublicId } from "./key-format.js";
import { keySourceSettingsOf } from "./key-source-settings.js";
import type { KeyOwner, KeySource, KeySourceSettings, StoredKey } from "./store-contract.js";

export const ERR_API_KEY_SCOPE_UNKNOWN = "ERR_API_KEY_SCOPE_UNKNOWN";
export const ERR_API_KEY_ID_DUPLICATE = "ERR_API_KEY_ID_DUPLICATE";

interface DeclaredEntry {
  id: string;
  digest: string;
  owner: KeyOwner;
  scopes: string[];
  expiresAt?: CelTimestamp;
}

interface DeclaredKeysResource {
  metadata: { name: string };
  prefix: string;
  scopes: string[];
  keys: DeclaredEntry[];
}

/**
 * ApiKey.DeclaredKeys — keys written in the manifest as digests. It answers
 * lookups only: nothing is revoked, listed or recorded as used, so a key is
 * withdrawn by removing its entry and an entry expires on `expiresAt`.
 */
class DeclaredKeys implements ResourceInstance, KeySource {
  constructor(
    private readonly keySettings: KeySourceSettings,
    private readonly byUuid: ReadonlyMap<string, StoredKey>,
  ) {}

  settings(): KeySourceSettings {
    return this.keySettings;
  }

  async lookup(id: string): Promise<{ outcome: "found"; key: StoredKey } | { outcome: "absent" }> {
    const key = this.byUuid.get(id);
    return key ? { outcome: "found", key } : { outcome: "absent" };
  }

  snapshot(): Record<string, unknown> {
    return { prefix: this.keySettings.prefix, scopes: [...this.keySettings.scopes], keys: this.byUuid.size };
  }
}

// The creation-time twins of the kind's resource rules (API_KEY_SCOPE_UNKNOWN,
// API_KEY_ID_DUPLICATE), for a manifest that was not checked.
export async function create(resource: DeclaredKeysResource): Promise<DeclaredKeys> {
  const describe = `ApiKey.DeclaredKeys "${resource.metadata.name}"`;
  const settings = keySourceSettingsOf(resource, describe);
  const vocabulary = new Set(settings.scopes);
  const entries = new Map<string, StoredKey>();
  const createdAt = timestampOfMillis(Date.now());

  for (const [index, entry] of resource.keys.entries()) {
    const at = `${describe}: keys[${index}]`;
    const uuid = PUBLIC_ID_PATTERN.test(entry.id) ? uuidOfPublicId(entry.id) : undefined;
    if (uuid === undefined) {
      throw new RuntimeError("ERR_INVALID_VALUE", `${at}: 'id' "${entry.id}" is not an \`apk_\` key id.`);
    }
    if (typeof entry.digest !== "string" || !DIGEST_PATTERN.test(entry.digest)) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `${at}: 'digest' must be the base64url SHA-256 of the key, 43 characters; mint one with ApiKey.Generate.`,
      );
    }
    if (entries.has(uuid)) {
      throw new RuntimeError(ERR_API_KEY_ID_DUPLICATE, `${at}: the id "${entry.id}" is declared twice.`);
    }
    const unknown = entry.scopes.filter((scope) => !vocabulary.has(scope));
    if (unknown.length > 0) {
      throw new RuntimeError(
        ERR_API_KEY_SCOPE_UNKNOWN,
        `${at}: scope ${unknown.map((s) => `"${s}"`).join(", ")} is outside the source's 'scopes'.`,
      );
    }
    entries.set(uuid, {
      id: uuid,
      digest: entry.digest,
      owner: entry.owner,
      scopes: [...entry.scopes],
      label: null,
      createdAt,
      expiresAt: entry.expiresAt ?? null,
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
      rotatedFrom: null,
    });
  }
  return new DeclaredKeys(settings, entries);
}

export function register(): void {}
