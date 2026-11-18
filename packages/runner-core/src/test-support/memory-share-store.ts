import { DEFAULT_MINT_ID, HostIdCollisionError, MAX_ID_DRAWS, type MintId } from "../session-store/host-id.js";
import type { SessionStore } from "../session-store/session-store.js";
import {
  shareLastActiveAt,
  type ConnectShareRequest,
  type ConnectShareResult,
  type CreateShareResult,
  type LeaseHold,
  type LeaseRenewal,
  type ShareOwner,
  type ShareRecord,
  type ShareStore,
} from "../session-store/share-store.js";

/**
 * A `ShareStore` in memory, answering as the Postgres one does — one suite
 * (`share-store.test.ts`) runs both — so the routes and the relay are tested
 * with no database. Not a runner store: nothing here survives the process.
 */
export class MemoryShareStore implements ShareStore {
  readonly shares = new Map<string, ShareRecord>();
  /** The host-id namespace: every id ever drawn, with when it was released. */
  readonly hostIds = new Map<string, { holder: "session" | "share"; releasedAt: Date | null }>();

  constructor(private readonly mintId: MintId = DEFAULT_MINT_ID) {}

  async createShare(input: {
    owner: ShareOwner;
    name: string;
    application: string;
    now: Date;
    maxPerOwner: number;
  }): Promise<CreateShareResult> {
    const mine = [...this.shares.values()].filter((s) => sameOwner(s.owner, input.owner));
    const existing = mine.find((s) => s.name === input.name);
    if (existing) return { kind: "exists", share: { ...existing } };
    if (mine.length >= input.maxPerOwner) return { kind: "limit" };
    let id: string | undefined;
    for (let draw = 0; draw < MAX_ID_DRAWS && id === undefined; draw++) {
      const candidate = this.mintId();
      if (!this.hostIds.has(candidate)) id = candidate;
    }
    if (id === undefined) throw new HostIdCollisionError(MAX_ID_DRAWS);
    this.hostIds.set(id, { holder: "share", releasedAt: null });
    const share: ShareRecord = {
      id,
      owner: input.owner,
      name: input.name,
      application: input.application,
      createdAt: input.now,
      epoch: 0,
      connectedAt: null,
      leaseExpiresAt: null,
    };
    this.shares.set(id, share);
    return { kind: "created", share: { ...share } };
  }

  async getShare(id: string): Promise<ShareRecord | undefined> {
    const share = this.shares.get(id);
    return share && { ...share };
  }

  async listShares(owner: ShareOwner): Promise<ShareRecord[]> {
    return [...this.shares.values()]
      .filter((s) => sameOwner(s.owner, owner))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((s) => ({ ...s }));
  }

  async deleteShare(id: string, owner: ShareOwner, now: Date): Promise<boolean> {
    const share = this.shares.get(id);
    if (!share || !sameOwner(share.owner, owner)) return false;
    this.remove(id, now);
    return true;
  }

  async connectShare(request: ConnectShareRequest): Promise<ConnectShareResult> {
    const share = this.shares.get(request.id);
    if (!share) return { kind: "gone" };
    if (request.epoch !== null && request.epoch !== share.epoch) return { kind: "superseded" };
    const at = request.now.getTime();
    const others = [...this.shares.values()].filter(
      (s) => s.id !== share.id && s.leaseExpiresAt !== null && s.leaseExpiresAt.getTime() > at,
    );
    if (others.filter((s) => sameOwner(s.owner, share.owner)).length >= request.maxConnectedPerOwner) {
      return { kind: "owner_limit" };
    }
    if (others.length >= request.maxConnected) return { kind: "capacity" };
    if (request.epoch === null) share.epoch += 1;
    share.connectedAt = request.now;
    share.leaseExpiresAt = new Date(at + request.leaseMs);
    return { kind: "connected", epoch: share.epoch };
  }

  async renewShareLeases(holds: LeaseHold[], now: Date, leaseMs: number): Promise<LeaseRenewal[]> {
    return holds.map((hold) => {
      const share = this.shares.get(hold.id);
      if (!share) return { ...hold, outcome: "gone" };
      if (share.epoch !== hold.epoch) return { ...hold, outcome: "epoch_moved" };
      share.leaseExpiresAt = new Date(now.getTime() + leaseMs);
      return { ...hold, outcome: "renewed" };
    });
  }

  async releaseShare(hold: LeaseHold, now: Date): Promise<boolean> {
    const share = this.shares.get(hold.id);
    if (!share || share.epoch !== hold.epoch) return false;
    if (share.leaseExpiresAt === null || share.leaseExpiresAt.getTime() <= now.getTime()) return false;
    share.leaseExpiresAt = now;
    return true;
  }

  async sweepExpiredShares(now: Date, retentionMs: number): Promise<string[]> {
    const expired = [...this.shares.values()].filter(
      (s) =>
        (s.leaseExpiresAt === null || s.leaseExpiresAt.getTime() <= now.getTime()) &&
        shareLastActiveAt(s, now).getTime() + retentionMs <= now.getTime(),
    );
    for (const share of expired) this.remove(share.id, now);
    return expired.map((s) => s.id);
  }

  private remove(id: string, now: Date): void {
    this.shares.delete(id);
    this.hostIds.get(id)!.releasedAt = now;
  }
}

function sameOwner(a: ShareOwner, b: ShareOwner): boolean {
  return a.iss === b.iss && a.sub === b.sub;
}

/** `store` with its share operations replaced — a SQLite store beneath, for
 *  the session half, and the shares in memory. */
export function withShares(store: SessionStore, shares: ShareStore): SessionStore {
  return Object.create(store, { shares: { value: shares, enumerable: true } }) as SessionStore;
}
