import type { SessionOwner } from "./session-store.js";

/** The identity that owns a share: shares refuse a resume secret. */
export type ShareOwner = Extract<SessionOwner, { kind: "identity" }>;

export interface ShareRecord {
  id: string;
  owner: ShareOwner;
  /** The client's name for the share, unique per owner. */
  name: string;
  /** The root Application's name, for display. */
  application: string;
  createdAt: Date;
  /** Bumped by every `hello null`; the fence of a run. */
  epoch: number;
  connectedAt: Date | null;
  leaseExpiresAt: Date | null;
}

/** `connected` is `lease_expires_at > now`. */
export function shareConnected(share: ShareRecord, now: Date): boolean {
  return share.leaseExpiresAt !== null && share.leaseExpiresAt.getTime() > now.getTime();
}

/** The latest of creation, last connect and the lease once it is past. */
export function shareLastActiveAt(share: ShareRecord, now: Date): Date {
  let latest = share.createdAt.getTime();
  if (share.connectedAt) latest = Math.max(latest, share.connectedAt.getTime());
  if (share.leaseExpiresAt && share.leaseExpiresAt.getTime() <= now.getTime()) {
    latest = Math.max(latest, share.leaseExpiresAt.getTime());
  }
  return new Date(latest);
}

export type CreateShareResult =
  | { kind: "created"; share: ShareRecord }
  | { kind: "exists"; share: ShareRecord }
  /** The owner keeps `maxPerOwner` shares already. */
  | { kind: "limit" };

export interface ConnectShareRequest {
  id: string;
  /** The epoch the tunnel presents: null on a run's first connect. */
  epoch: number | null;
  now: Date;
  leaseMs: number;
  maxConnected: number;
  maxConnectedPerOwner: number;
}

export type ConnectShareResult =
  /** The epoch the tunnel now holds. */
  | { kind: "connected"; epoch: number }
  /** Unknown or deleted. */
  | { kind: "gone" }
  /** The presented epoch is not the stored one: another run took over. */
  | { kind: "superseded" }
  | { kind: "owner_limit" }
  | { kind: "capacity" };

export interface LeaseHold {
  id: string;
  epoch: number;
}

export type LeaseRenewal = LeaseHold & { outcome: "renewed" | "gone" | "epoch_moved" };

/**
 * The share operations of a store the relay process shares with the control
 * plane. The relay calls the fence, renewal and release; the control plane the
 * rest. A share is not a session: it has no workspace and no workload.
 */
export interface ShareStore {
  /** Get-or-create by `(owner, name)`, bounded by `maxPerOwner`. */
  createShare(input: {
    owner: ShareOwner;
    name: string;
    application: string;
    now: Date;
    maxPerOwner: number;
  }): Promise<CreateShareResult>;
  /** Any share by id, whoever owns it; undefined when unknown or deleted. */
  getShare(id: string): Promise<ShareRecord | undefined>;
  listShares(owner: ShareOwner): Promise<ShareRecord[]>;
  /** Deletes the owner's share and releases its id in one transaction; false
   *  for an unknown, deleted or another owner's id. */
  deleteShare(id: string, owner: ShareOwner, now: Date): Promise<boolean>;
  /** The fence: one write that moves the epoch (or checks it), sets the
   *  connection and the lease, and holds both connected-share limits. */
  connectShare(request: ConnectShareRequest): Promise<ConnectShareResult>;
  /** Renews every lease whose epoch still holds, in one write. */
  renewShareLeases(holds: LeaseHold[], now: Date, leaseMs: number): Promise<LeaseRenewal[]>;
  /** A clean close: the lease ends now, conditioned on the epoch. True when the
   *  epoch held and the share was connected. */
  releaseShare(hold: LeaseHold, now: Date): Promise<boolean>;
  /** Deletes every share not connected whose `lastActiveAt + retentionMs` has
   *  passed, releasing their ids; returns the ids. */
  sweepExpiredShares(now: Date, retentionMs: number): Promise<string[]>;
}
