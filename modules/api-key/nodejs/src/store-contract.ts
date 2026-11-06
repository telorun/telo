import type { CelDuration, CelTimestamp, InvokeContext } from "@telorun/sdk";

/**
 * The API-key store interface (normative: `docs/store-contract.md`).
 *
 * A store stores. Every error code, the key format, id and secret minting, the
 * digest, scope and lifetime checks and the list cursor envelope are the
 * operations' and the verifier's, decided once for every backend. A method
 * answers with an OUTCOME, never a code; a failure of the storage itself is
 * thrown as it arrives and surfaces as `ERR_API_KEY_STORE_UNAVAILABLE`.
 *
 * Every method takes the calling invocation's context last, so a remote call
 * can be cancelled with it. A key is addressed by its UUID (the store's id);
 * the public `apk_` id is derived from it and never stored.
 */

/** What a source is configured with. `maxLifetimeMs` is null when it states none. */
export interface KeySourceSettings {
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly maxLifetimeMs: number | null;
}

export type KeyOwnerType = "user" | "service" | "organization";

export interface KeyOwner {
  readonly type: KeyOwnerType;
  readonly id: string;
}

/** A key as a store holds it. */
export interface StoredKey {
  /** The key's UUID. */
  readonly id: string;
  /** SHA-256 of the whole key, base64url. */
  readonly digest: string;
  readonly owner: KeyOwner;
  readonly scopes: readonly string[];
  readonly label: string | null;
  readonly createdAt: CelTimestamp;
  readonly expiresAt: CelTimestamp | null;
  readonly revokedAt: CelTimestamp | null;
  readonly revokedBy: string | null;
  readonly lastUsedAt: CelTimestamp | null;
  /** The UUID of the key this one replaced, when it came from a rotation. */
  readonly rotatedFrom: string | null;
}

/** The lookup level: what a verifier needs of a source. */
export interface KeySource {
  settings(): KeySourceSettings;
  /** The key under `id`, revoked or expired ones included, or absent. */
  lookup(id: string, ctx?: InvokeContext): Promise<{ outcome: "found"; key: StoredKey } | { outcome: "absent" }>;
  /** Optional. Records a use at most once per `resolution` across every
   *  replica, as one conditional write: `touched` when it wrote, `fresh` when
   *  the last use was already within `resolution`. A source that tracks no
   *  last use omits the method. */
  touch?(
    id: string,
    resolution: CelDuration,
    ctx?: InvokeContext,
  ): Promise<{ outcome: "touched" } | { outcome: "fresh" } | { outcome: "absent" }>;
}

export interface IssueRequest {
  readonly id: string;
  readonly digest: string;
  readonly owner: KeyOwner;
  readonly scopes: readonly string[];
  readonly label: string | null;
  readonly expiresAt: CelTimestamp | null;
}

export interface RotateRequest {
  /** The key being replaced. */
  readonly id: string;
  /** The successor. It takes the replaced key's owner, scopes and label and
   *  records `rotatedFrom`. */
  readonly successor: { readonly id: string; readonly digest: string; readonly expiresAt: CelTimestamp | null };
  /** The replaced key's `expiresAt` becomes the earlier of its own and the
   *  store's now plus this. */
  readonly overlap: CelDuration;
}

export interface ListRequest {
  readonly owner: KeyOwner;
  /** 1 to 200. */
  readonly limit: number;
  /** A tail this store returned as `next`; one it cannot read is `cursorInvalid`. */
  readonly after?: string;
}

/** The management level: issue, list, revoke, rotate and touch. */
export interface ApiKeyStore extends KeySource {
  touch(
    id: string,
    resolution: CelDuration,
    ctx?: InvokeContext,
  ): Promise<{ outcome: "touched" } | { outcome: "fresh" } | { outcome: "absent" }>;
  /** Store a new key. */
  issue(request: IssueRequest, ctx?: InvokeContext): Promise<{ outcome: "issued"; key: StoredKey }>;
  /** A page of the owner's keys in id order (UUIDv7: creation time to the millisecond), revoked and
   *  expired ones included. `next` is present only when more keys exist. */
  list(
    request: ListRequest,
    ctx?: InvokeContext,
  ): Promise<{ outcome: "page"; keys: readonly StoredKey[]; next?: string } | { outcome: "cursorInvalid" }>;
  /** Set `revokedAt` (the store's now) and `revokedBy` unless already set.
   *  `alreadyRevoked` carries the key as it stands, with its first revocation. */
  revoke(
    id: string,
    request: { readonly by: string | null },
    ctx?: InvokeContext,
  ): Promise<
    { outcome: "revoked"; key: StoredKey } | { outcome: "alreadyRevoked"; key: StoredKey } | { outcome: "absent" }
  >;
  /** Store the successor and cap the replaced key's expiry, atomically: both
   *  or neither. `revoked` when the replaced key is revoked (nothing changed). */
  rotate(
    request: RotateRequest,
    ctx?: InvokeContext,
  ): Promise<
    | { outcome: "rotated"; predecessor: StoredKey; successor: StoredKey }
    | { outcome: "revoked" }
    | { outcome: "absent" }
  >;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    names.every((name) => typeof (value as Record<string, unknown>)[name] === "function")
  );
}

/** Recognised by shape, never by class: a store may live in another repository. */
export function isKeySource(value: unknown): value is KeySource {
  return hasMethods(value, ["settings", "lookup"]);
}

export function isApiKeyStore(value: unknown): value is ApiKeyStore {
  return hasMethods(value, ["settings", "lookup", "touch", "issue", "list", "revoke", "rotate"]);
}
