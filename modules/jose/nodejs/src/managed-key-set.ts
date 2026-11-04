import { randomValue } from "@telorun/crypto";
import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { InvokeError } from "@telorun/sdk";
import { exportJWK, generateKeyPair, generateSecret, type JWK } from "jose";
import {
  ERR_JOSE_KEYSET_UNAVAILABLE,
  type JoseKeySet,
  type JsonWebKeySet,
  type KeyHint,
  type KeyMaterial,
  type RotationOutcome,
  type SigningKey,
} from "./key-set-contract.js";
import { isSymmetric, KeyImports, publicJwk, selectKeys, type SigningAlgorithm } from "./jwk-selection.js";
import { seal, unseal, type SealingKey } from "./sealing.js";

/** One key of the stored set. Times are RFC 3339; the private JWK is sealed under the wrap key. */
interface StoredKey {
  kid: string;
  alg: string;
  createdAt: string;
  retiresAt: string | null;
  publicJwk: JWK | null;
  wrappedJwk: string;
}

/** The whole set, one record in the store. */
interface KeySetRecord {
  format: 1;
  current: string;
  keys: StoredKey[];
}

interface Held {
  record: KeySetRecord;
  version: string;
  readAt: number;
}

export interface ManagedKeySetOptions {
  describe: string;
  store: () => KvStore;
  /** The record's key in the store. */
  storeKey: string;
  wrapKey: SealingKey;
  algorithm: SigningAlgorithm;
  /** A Rotate without `force` rotates only once the current key is this old; 0 rotates every time. */
  rotateEveryMs: number;
  retireAfterMs: number;
  cacheTtlMs: number;
}

/** The set is meant never to lapse; a KvStore requires a TTL, so it is a century, refreshed on every write. */
const RECORD_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 8;
/** An unknown kid re-reads the record at most this often, so random kids cannot turn every request into a store read. */
const UNKNOWN_KID_REREAD_MS = 1000;

/**
 * A signing key set kept as ONE record in a `KvStore.Store`, written only by
 * conditional writes: every replica rotating at once converges on one current
 * key, because a writer whose `compareAndSet` lost re-reads and adopts the
 * rotation that won.
 */
export class ManagedKeySet implements JoseKeySet {
  private held?: Held;
  private reading?: Promise<Held>;
  private readonly imports = new KeyImports();
  private readonly unwrapped = new Map<string, Promise<JWK>>();

  constructor(private readonly options: ManagedKeySetOptions) {}

  /** Nothing configured or observed here is safe or useful to publish. */
  snapshot(): Record<string, unknown> {
    return {};
  }

  async verificationKeys(hint: KeyHint): Promise<KeyMaterial[]> {
    let held = await this.current(this.options.cacheTtlMs);
    let found = this.candidates(held, hint);
    if (
      found.length === 0 &&
      hint.kid !== undefined &&
      Date.now() - held.readAt >= UNKNOWN_KID_REREAD_MS
    ) {
      held = await this.current(0);
      found = this.candidates(held, hint);
    }
    return Promise.all(
      found.map(async (stored) =>
        this.imports.get(
          isSymmetric(stored.alg) ? await this.privateJwk(stored) : stored.publicJwk!,
          hint.alg,
        ),
      ),
    );
  }

  async publicKeys(): Promise<JsonWebKeySet> {
    const held = await this.current(this.options.cacheTtlMs);
    return {
      keys: liveKeys(held.record, Date.now())
        .filter((stored) => stored.publicJwk !== null)
        .map((stored) => stored.publicJwk!),
    };
  }

  async signingKey(): Promise<SigningKey> {
    const held = await this.current(this.options.cacheTtlMs);
    const stored = held.record.keys.find((key) => key.kid === held.record.current)!;
    const key = await this.imports.get(await this.privateJwk(stored), stored.alg);
    return { kid: stored.kid, alg: stored.alg, key };
  }

  async rotate(force: boolean): Promise<RotationOutcome> {
    let startedFrom: string | undefined;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const { held, created, wasAbsent } = await this.read();
      this.held = held;
      // A set made by this read, or by a concurrent one, has a key fresh enough to be this rotation's.
      if (wasAbsent) {
        return { rotated: created, currentKid: held.record.current, retiredKids: [] };
      }
      const { record } = held;
      // Someone else rotated since this call first looked: that rotation is this one's too.
      if (startedFrom !== undefined && record.current !== startedFrom) {
        return { rotated: false, currentKid: record.current, retiredKids: [] };
      }
      startedFrom = record.current;

      const now = Date.now();
      const current = record.keys.find((key) => key.kid === record.current)!;
      const retired = record.keys.filter((key) => !isLive(key, now));
      const due =
        force ||
        current.alg !== this.options.algorithm ||
        now - Date.parse(current.createdAt) >= this.options.rotateEveryMs;
      if (!due && retired.length === 0) {
        return { rotated: false, currentKid: record.current, retiredKids: [] };
      }

      const keys = liveKeys(record, now);
      let next: KeySetRecord = { format: 1, current: record.current, keys };
      if (due) {
        const fresh = await this.generate(now);
        next = {
          format: 1,
          current: fresh.kid,
          keys: [
            ...keys.map((key) =>
              key.kid === record.current && key.retiresAt === null
                ? { ...key, retiresAt: new Date(now + this.options.retireAfterMs).toISOString() }
                : key,
            ),
            fresh,
          ],
        };
      }
      const written = await this.attempt("compareAndSet", (store) =>
        store.compareAndSet(this.options.storeKey, held.version, next, RECORD_TTL_MS),
      );
      if (written) {
        this.held = { record: next, version: written.version, readAt: now };
        return {
          rotated: due,
          currentKid: next.current,
          retiredKids: retired.map((key) => key.kid),
        };
      }
    }
    throw new InvokeError(
      ERR_JOSE_KEYSET_UNAVAILABLE,
      `${this.options.describe}: lost ${MAX_WRITE_ATTEMPTS} conditional writes in a row to other writers of the record.`,
    );
  }

  private candidates(held: Held, hint: KeyHint): StoredKey[] {
    const live = liveKeys(held.record, Date.now()).map((stored) => ({
      ...stored,
      jwk: (stored.publicJwk ?? { kty: "oct", alg: stored.alg }) as JWK,
    }));
    return selectKeys(live, hint);
  }

  /** The held record when it is younger than `maxAgeMs`, else a fresh read shared by concurrent callers. */
  private async current(maxAgeMs: number): Promise<Held> {
    if (this.held && Date.now() - this.held.readAt < maxAgeMs) return this.held;
    this.reading ??= this.read()
      .then(({ held }) => (this.held = held))
      .finally(() => (this.reading = undefined));
    return this.reading;
  }

  /**
   * The stored record, creating the set's first key when there is none.
   * `wasAbsent` says the record did not exist when this read began, whoever then created it.
   */
  private async read(): Promise<{ held: Held; created: boolean; wasAbsent: boolean }> {
    const key = this.options.storeKey;
    const found = await this.attempt("get", (store) => store.get(key));
    if (found) return { held: this.heldFrom(found), created: false, wasAbsent: false };

    const now = Date.now();
    const first = await this.generate(now);
    const record: KeySetRecord = { format: 1, current: first.kid, keys: [first] };
    const put = await this.attempt("putIfAbsent", (store) => store.putIfAbsent(key, record, RECORD_TTL_MS));
    if (put) return { held: { record, version: put.version, readAt: now }, created: true, wasAbsent: true };

    const theirs = await this.attempt("get", (store) => store.get(key));
    if (!theirs) {
      throw new InvokeError(
        ERR_JOSE_KEYSET_UNAVAILABLE,
        `${this.options.describe}: the record at "${key}" was written by another writer and is gone again.`,
      );
    }
    return { held: this.heldFrom(theirs), created: false, wasAbsent: true };
  }

  private heldFrom(found: VersionedValue): Held {
    const record = this.parse(found);
    this.pruneUnwrapped(record);
    return { record, version: found.version, readAt: Date.now() };
  }

  /** Forgets unwrapped keys the record no longer holds. */
  private pruneUnwrapped(record: KeySetRecord): void {
    const kept = new Set(record.keys.map((stored) => `${stored.kid}\u0000${stored.wrappedJwk}`));
    for (const cacheKey of this.unwrapped.keys()) {
      if (!kept.has(cacheKey)) this.unwrapped.delete(cacheKey);
    }
  }

  private parse(found: VersionedValue): KeySetRecord {
    const record = found.value as Partial<KeySetRecord> | null;
    const valid =
      !!record &&
      record.format === 1 &&
      typeof record.current === "string" &&
      Array.isArray(record.keys) &&
      record.keys.every(
        (key) =>
          !!key &&
          typeof key.kid === "string" &&
          typeof key.alg === "string" &&
          typeof key.createdAt === "string" &&
          (key.retiresAt === null || typeof key.retiresAt === "string") &&
          typeof key.wrappedJwk === "string",
      ) &&
      record.keys.some((key) => key.kid === record.current);
    if (!valid) {
      throw new InvokeError(
        ERR_JOSE_KEYSET_UNAVAILABLE,
        `${this.options.describe}: the record at "${this.options.storeKey}" is not a key set. ` +
          `Give this set its own \`name\`, or remove the record.`,
      );
    }
    return record as KeySetRecord;
  }

  private async generate(now: number): Promise<StoredKey> {
    const alg = this.options.algorithm;
    const kid = randomValue(16, "base64url");
    let privateJwk: JWK;
    let published: JWK | null = null;
    if (isSymmetric(alg)) {
      privateJwk = await exportJWK(await generateSecret(alg, { extractable: true }));
    } else {
      const pair = await generateKeyPair(alg, { extractable: true });
      privateJwk = await exportJWK(pair.privateKey);
      published = publicJwk(await exportJWK(pair.publicKey), kid, alg);
    }
    return {
      kid,
      alg,
      createdAt: new Date(now).toISOString(),
      retiresAt: null,
      publicJwk: published,
      wrappedJwk: await seal(JSON.stringify({ ...privateJwk, kid, alg }), this.options.wrapKey),
    };
  }

  private privateJwk(stored: StoredKey): Promise<JWK> {
    const cacheKey = `${stored.kid}\u0000${stored.wrappedJwk}`;
    let jwk = this.unwrapped.get(cacheKey);
    if (!jwk) {
      jwk = this.unwrap(stored);
      jwk.catch(() => this.unwrapped.delete(cacheKey));
      this.unwrapped.set(cacheKey, jwk);
    }
    return jwk;
  }

  private async unwrap(stored: StoredKey): Promise<JWK> {
    const opened = await unseal(stored.wrappedJwk, [this.options.wrapKey]);
    if (!opened.ok) {
      const why =
        opened.reason === "unknownKey"
          ? "it was wrapped under a different `wrapKey`"
          : opened.reason === "decryption"
            ? "it does not decrypt under this `wrapKey`"
            : "its wrapped form is malformed";
      throw new InvokeError(
        ERR_JOSE_KEYSET_UNAVAILABLE,
        `${this.options.describe}: key "${stored.kid}" will not unwrap — ${why}. ` +
          `Restore the \`wrapKey\` the set was created with.`,
      );
    }
    return JSON.parse(opened.plaintext) as JWK;
  }

  /** A store operation; a store failure is the set being unavailable, with the failure as its cause. */
  private async attempt<T>(operation: string, run: (store: KvStore) => Promise<T>): Promise<T> {
    const store = this.options.store();
    try {
      return await run(store);
    } catch (err) {
      throw new InvokeError(
        ERR_JOSE_KEYSET_UNAVAILABLE,
        `${this.options.describe}: the store failed ${operation} on "${this.options.storeKey}": ${(err as Error).message}`,
        undefined,
        { cause: err },
      );
    }
  }
}

function isLive(key: StoredKey, now: number): boolean {
  return key.retiresAt === null || Date.parse(key.retiresAt) > now;
}

function liveKeys(record: KeySetRecord, now: number): StoredKey[] {
  return record.keys.filter((key) => isLive(key, now));
}
