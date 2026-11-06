import {
  InvokeError,
  isCelTimestamp,
  type CelTimestamp,
  type InvokeContext,
  type KindRef,
  type ResourceContext,
} from "@telorun/sdk";
import { publicIdOf, uuidOfPublicId } from "./key-format.js";
import { millisOfTimestamp } from "./instants.js";
import { callStore } from "./store-failure.js";
import { isApiKeyStore, type ApiKeyStore, type KeySourceSettings, type StoredKey } from "./store-contract.js";

export const ERR_API_KEY_NOT_FOUND = "ERR_API_KEY_NOT_FOUND";
export const ERR_API_KEY_SCOPE_UNKNOWN = "ERR_API_KEY_SCOPE_UNKNOWN";
export const ERR_API_KEY_LIFETIME_EXCEEDED = "ERR_API_KEY_LIFETIME_EXCEEDED";
export const ERR_API_KEY_REVOKED = "ERR_API_KEY_REVOKED";
export const ERR_API_KEY_CURSOR_INVALID = "ERR_API_KEY_CURSOR_INVALID";

export interface OperationResource {
  kind?: string;
  metadata: { name: string; module?: string };
  store?: ApiKeyStore | KindRef<ApiKeyStore>;
}

/** One operation resource: its label for messages and the store its `store`
 *  slot names, resolved per call so creation orders against nothing. */
export class BoundKeyOperation {
  readonly describe: string;

  constructor(
    kind: string,
    readonly resource: OperationResource,
    readonly ctx: ResourceContext,
  ) {
    this.describe = `${kind} "${resource.metadata.name}"`;
  }

  get store(): ApiKeyStore {
    return this.ctx.resolveRef(this.resource.store, isApiKeyStore, () => `${this.describe}: 'store'`, "ApiKey.Store");
  }

  call<T>(work: () => Promise<T>): Promise<T> {
    return callStore(this.describe, work);
  }

  /** The store's UUID for a public id; an id that is none names no key. */
  uuidOf(publicId: string): string {
    const uuid = uuidOfPublicId(publicId);
    if (uuid === undefined) throw this.notFound(publicId);
    return uuid;
  }

  notFound(publicId: string): InvokeError {
    return new InvokeError(ERR_API_KEY_NOT_FOUND, `${this.describe}: no key has the id "${publicId}".`);
  }

  /** Refuses scopes outside the source's vocabulary. */
  checkScopes(scopes: readonly string[], settings: KeySourceSettings): void {
    const vocabulary = new Set(settings.scopes);
    const unknown = scopes.filter((scope) => !vocabulary.has(scope));
    if (unknown.length > 0) {
      throw new InvokeError(
        ERR_API_KEY_SCOPE_UNKNOWN,
        `${this.describe}: scope ${unknown.map((s) => `"${s}"`).join(", ")} is outside the store's 'scopes'.`,
        { scopes: unknown },
      );
    }
  }

  /** Refuses an expiry beyond the store's `maxLifetime`; with one stated, a key must expire. */
  checkLifetime(expiresAt: CelTimestamp | null, settings: KeySourceSettings, nowMs: number): void {
    if (settings.maxLifetimeMs === null) return;
    const lifetime = expiresAt === null ? Infinity : millisOfTimestamp(expiresAt) - nowMs;
    if (lifetime > settings.maxLifetimeMs) {
      throw new InvokeError(
        ERR_API_KEY_LIFETIME_EXCEEDED,
        `${this.describe}: the key ${expiresAt === null ? "has no expiry" : "would live longer"} than the store's 'maxLifetime' allows; give an 'expiresAt' within it.`,
      );
    }
  }
}

/** An optional timestamp input: absent or null is no expiry. */
export function optionalTimestamp(value: unknown, describe: string, name: string): CelTimestamp | null {
  if (value === undefined || value === null) return null;
  if (!isCelTimestamp(value)) throw new InvokeError("ERR_INPUT_INVALID", `${describe}: '${name}' must be a timestamp.`);
  return value;
}

/** A key as an operation reports it: the public id, never the digest. */
export function keyRecord(key: StoredKey) {
  return {
    id: publicIdOf(key.id),
    owner: { type: key.owner.type, id: key.owner.id },
    scopes: [...key.scopes],
    label: key.label,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    revokedBy: key.revokedBy,
    lastUsedAt: key.lastUsedAt,
    rotatedFrom: key.rotatedFrom === null ? null : publicIdOf(key.rotatedFrom),
  };
}

/** A key just issued, as Issue and Rotate report it: nothing has revoked or used it yet. */
export function issuedRecord(key: StoredKey) {
  const { id, owner, scopes, label, createdAt, expiresAt } = keyRecord(key);
  return { id, owner, scopes, label, createdAt, expiresAt };
}

export type { InvokeContext };
