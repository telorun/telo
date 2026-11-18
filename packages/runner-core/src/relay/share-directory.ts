import type {
  ConnectShareResult,
  LeaseHold,
  LeaseRenewal,
  ShareOwner,
  ShareStore,
} from "../session-store/share-store.js";

/**
 * What the relay asks about shares, and the four writes it makes: one tunnel's
 * connect with the fence, the batched lease renewal, and the release on a
 * clean close. It is read only when a tunnel connects and on the renewal tick,
 * never per visitor request.
 */
export interface ShareDirectory {
  /** The share's owner; `undefined` when it is unknown or deleted. */
  lookUp(id: string): Promise<{ owner: ShareOwner } | undefined>;
  /** The fence: `null` takes the share over with a new epoch, a number must be
   *  the stored one. Takes the lease and holds both connected-share limits. */
  connect(id: string, epoch: number | null): Promise<ConnectShareResult>;
  /** Renews every held lease whose epoch still holds, in one write. */
  renew(holds: LeaseHold[]): Promise<LeaseRenewal[]>;
  /** Ends the lease now, when the epoch still holds. */
  release(hold: LeaseHold): Promise<boolean>;
}

/** How long a lease lasts past its last renewal. */
export const SHARE_LEASE_MS = 15_000;

export interface StoreShareDirectoryOptions {
  maxConnected: number;
  maxConnectedPerOwner: number;
  leaseMs?: number;
  now?: () => Date;
}

/** The share directory over the store the control plane writes shares to. */
export function storeShareDirectory(store: ShareStore, options: StoreShareDirectoryOptions): ShareDirectory {
  const leaseMs = options.leaseMs ?? SHARE_LEASE_MS;
  const now = options.now ?? (() => new Date());
  return {
    async lookUp(id) {
      const share = await store.getShare(id);
      return share && { owner: share.owner };
    },
    connect(id, epoch) {
      return store.connectShare({
        id,
        epoch,
        now: now(),
        leaseMs,
        maxConnected: options.maxConnected,
        maxConnectedPerOwner: options.maxConnectedPerOwner,
      });
    },
    renew(holds) {
      return store.renewShareLeases(holds, now(), leaseMs);
    },
    release(hold) {
      return store.releaseShare(hold, now());
    },
  };
}
