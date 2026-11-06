import type { ResourceContext } from "@telorun/sdk";
import { timestampOfMillis, millisOfTimestamp } from "../src/instants.js";
import type {
  ApiKeyStore,
  IssueRequest,
  KeyOwner,
  KeySource,
  RotateRequest,
  StoredKey,
} from "../src/store-contract.js";

/** A context whose references are the objects themselves. */
export const directCtx = { resolveRef: (value: unknown) => value } as unknown as ResourceContext;

export class FakeStore implements ApiKeyStore {
  readonly keys = new Map<string, StoredKey>();
  readonly calls: string[] = [];
  now = Date.now();

  constructor(
    private readonly prefix = "tk",
    private readonly scopes: string[] = ["read", "write"],
    private readonly maxLifetimeMs: number | null = null,
  ) {}

  settings() {
    return { prefix: this.prefix, scopes: this.scopes, maxLifetimeMs: this.maxLifetimeMs };
  }

  async lookup(id: string) {
    this.calls.push("lookup");
    const key = this.keys.get(id);
    return key ? ({ outcome: "found", key } as const) : ({ outcome: "absent" } as const);
  }

  async touch(id: string, resolution: { seconds: bigint }) {
    this.calls.push("touch");
    const key = this.keys.get(id);
    if (!key) return { outcome: "absent" } as const;
    const lastUsed = key.lastUsedAt === null ? null : millisOfTimestamp(key.lastUsedAt);
    if (lastUsed !== null && this.now - lastUsed < Number(resolution.seconds) * 1000) return { outcome: "fresh" } as const;
    this.keys.set(id, { ...key, lastUsedAt: timestampOfMillis(this.now) });
    return { outcome: "touched" } as const;
  }

  async issue(request: IssueRequest) {
    const key: StoredKey = {
      ...request,
      createdAt: timestampOfMillis(this.now),
      revokedAt: null,
      revokedBy: null,
      lastUsedAt: null,
      rotatedFrom: null,
    };
    this.keys.set(request.id, key);
    return { outcome: "issued", key } as const;
  }

  async list(request: { owner: KeyOwner; limit: number; after?: string }) {
    const all = [...this.keys.values()]
      .filter((k) => k.owner.type === request.owner.type && k.owner.id === request.owner.id)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .filter((k) => request.after === undefined || k.id > request.after);
    if (request.after === "bad") return { outcome: "cursorInvalid" } as const;
    const keys = all.slice(0, request.limit);
    return {
      outcome: "page",
      keys,
      ...(all.length > keys.length ? { next: keys[keys.length - 1]!.id } : {}),
    } as const;
  }

  async revoke(id: string, request: { by: string | null }) {
    const key = this.keys.get(id);
    if (!key) return { outcome: "absent" } as const;
    if (key.revokedAt !== null) return { outcome: "alreadyRevoked", key } as const;
    const revoked = { ...key, revokedAt: timestampOfMillis(this.now), revokedBy: request.by };
    this.keys.set(id, revoked);
    return { outcome: "revoked", key: revoked } as const;
  }

  async rotate(request: RotateRequest) {
    const old = this.keys.get(request.id);
    if (!old) return { outcome: "absent" } as const;
    if (old.revokedAt !== null) return { outcome: "revoked" } as const;
    const cap = this.now + Number(request.overlap.seconds) * 1000;
    const oldExpiry = old.expiresAt === null ? Infinity : millisOfTimestamp(old.expiresAt);
    const predecessor = { ...old, expiresAt: timestampOfMillis(Math.min(oldExpiry, cap)) };
    const successor: StoredKey = {
      ...old,
      ...request.successor,
      createdAt: timestampOfMillis(this.now),
      lastUsedAt: null,
      rotatedFrom: old.id,
    };
    this.keys.set(old.id, predecessor);
    this.keys.set(successor.id, successor);
    return { outcome: "rotated", predecessor, successor } as const;
  }
}

export function plainSource(store: FakeStore): KeySource {
  return { settings: () => store.settings(), lookup: (id) => store.lookup(id) };
}
