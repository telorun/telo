import type { Pool, PoolClient } from "pg";

import { HostIdCollisionError, MAX_ID_DRAWS, type MintId } from "./host-id.js";
import { inTransaction } from "./postgres-transaction.js";
import { ownerColumns } from "./session-store.js";
import type {
  ConnectShareRequest,
  ConnectShareResult,
  CreateShareResult,
  LeaseHold,
  LeaseRenewal,
  ShareOwner,
  ShareRecord,
  ShareStore,
} from "./share-store.js";

/** Serializes one owner's share creations, so `maxPerOwner` holds. */
function ownerLockKey(ownerKey: string): string {
  return `runner-share-owner:${ownerKey}`;
}

/** Serializes every connect, so the runner-wide and per-owner limits are
 *  checked and the lease written with no other connect between them. */
const CONNECT_LOCK = 0x73686172;

const COLUMNS =
  "id, owner_iss, owner_sub, name, application, created_at, epoch, connected_at, lease_expires_at";

interface ShareRow {
  id: string;
  owner_iss: string;
  owner_sub: string;
  name: string;
  application: string;
  created_at: string;
  epoch: string;
  connected_at: string | null;
  lease_expires_at: string | null;
}

function decode(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    owner: { kind: "identity", iss: row.owner_iss, sub: row.owner_sub },
    name: row.name,
    application: row.application,
    createdAt: new Date(Number(row.created_at)),
    epoch: Number(row.epoch),
    connectedAt: row.connected_at === null ? null : new Date(Number(row.connected_at)),
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(Number(row.lease_expires_at)),
  };
}

/** The share operations in Postgres, over `runner_shares` and the host-id
 *  namespace it draws from. */
export class PostgresShareStore implements ShareStore {
  constructor(
    private readonly pool: Pool,
    private readonly mintId: MintId,
  ) {}

  async createShare(input: {
    owner: ShareOwner;
    name: string;
    application: string;
    now: Date;
    maxPerOwner: number;
  }): Promise<CreateShareResult> {
    const columns = ownerColumns(input.owner);
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ownerLockKey(columns.ownerKey)]);
      const existing = await client.query(
        `SELECT ${COLUMNS} FROM runner_shares WHERE owner_key = $1 AND name = $2`,
        [columns.ownerKey, input.name],
      );
      if (existing.rowCount === 1) return { kind: "exists", share: decode(existing.rows[0]) };
      const count = await client.query("SELECT count(*) AS n FROM runner_shares WHERE owner_key = $1", [
        columns.ownerKey,
      ]);
      if (Number(count.rows[0].n) >= input.maxPerOwner) return { kind: "limit" };
      const id = await this.drawHostId(client, input.now);
      await client.query(
        `INSERT INTO runner_shares (id, owner_key, owner_iss, owner_sub, name, application, created_at, epoch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
        [
          id,
          columns.ownerKey,
          input.owner.iss,
          input.owner.sub,
          input.name,
          input.application,
          input.now.getTime(),
        ],
      );
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
      return { kind: "created", share };
    });
  }

  async getShare(id: string): Promise<ShareRecord | undefined> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM runner_shares WHERE id = $1`, [id]);
    return result.rows[0] ? decode(result.rows[0]) : undefined;
  }

  async listShares(owner: ShareOwner): Promise<ShareRecord[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM runner_shares WHERE owner_key = $1 ORDER BY created_at, id`,
      [ownerColumns(owner).ownerKey],
    );
    return result.rows.map(decode);
  }

  async deleteShare(id: string, owner: ShareOwner, now: Date): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const deleted = await client.query("DELETE FROM runner_shares WHERE id = $1 AND owner_key = $2", [
        id,
        ownerColumns(owner).ownerKey,
      ]);
      if (deleted.rowCount !== 1) return false;
      await client.query("UPDATE runner_host_ids SET released_at = $2 WHERE id = $1", [id, now.getTime()]);
      return true;
    });
  }

  async connectShare(request: ConnectShareRequest): Promise<ConnectShareResult> {
    const now = request.now.getTime();
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CONNECT_LOCK]);
      const found = await client.query(
        "SELECT owner_key, epoch FROM runner_shares WHERE id = $1 FOR UPDATE",
        [request.id],
      );
      if (found.rowCount !== 1) return { kind: "gone" };
      const stored = Number(found.rows[0].epoch);
      if (request.epoch !== null && request.epoch !== stored) return { kind: "superseded" };
      // The share itself is left out: a takeover or a reconnect of one's own
      // share never counts twice.
      const others = await client.query(
        `SELECT count(*) AS total, count(*) FILTER (WHERE owner_key = $3) AS mine
         FROM runner_shares WHERE id <> $1 AND lease_expires_at > $2`,
        [request.id, now, found.rows[0].owner_key],
      );
      if (Number(others.rows[0].mine) >= request.maxConnectedPerOwner) return { kind: "owner_limit" };
      if (Number(others.rows[0].total) >= request.maxConnected) return { kind: "capacity" };
      const epoch = request.epoch === null ? stored + 1 : stored;
      await client.query(
        "UPDATE runner_shares SET epoch = $2, connected_at = $3, lease_expires_at = $4 WHERE id = $1",
        [request.id, epoch, now, now + request.leaseMs],
      );
      return { kind: "connected", epoch };
    });
  }

  async renewShareLeases(holds: LeaseHold[], now: Date, leaseMs: number): Promise<LeaseRenewal[]> {
    if (holds.length === 0) return [];
    const result = await this.pool.query(
      `WITH input (id, epoch, n) AS (SELECT * FROM unnest($1::text[], $2::bigint[]) WITH ORDINALITY),
            renewed AS (
              UPDATE runner_shares s SET lease_expires_at = $3
              FROM input i WHERE s.id = i.id AND s.epoch = i.epoch
              RETURNING s.id
            )
       SELECT i.id, i.epoch, (r.id IS NOT NULL) AS renewed, (s.id IS NOT NULL) AS present
       FROM input i
       LEFT JOIN renewed r ON r.id = i.id
       LEFT JOIN runner_shares s ON s.id = i.id
       ORDER BY i.n`,
      [holds.map((h) => h.id), holds.map((h) => h.epoch), now.getTime() + leaseMs],
    );
    return result.rows.map((row: { id: string; epoch: string; renewed: boolean; present: boolean }) => ({
      id: row.id,
      epoch: Number(row.epoch),
      outcome: row.renewed ? "renewed" : row.present ? "epoch_moved" : "gone",
    }));
  }

  async releaseShare(hold: LeaseHold, now: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE runner_shares SET lease_expires_at = $3
       WHERE id = $1 AND epoch = $2 AND lease_expires_at > $3`,
      [hold.id, hold.epoch, now.getTime()],
    );
    return result.rowCount === 1;
  }

  async sweepExpiredShares(now: Date, retentionMs: number): Promise<string[]> {
    return inTransaction(this.pool, async (client) => {
      const deleted = await client.query(
        `DELETE FROM runner_shares
         WHERE (lease_expires_at IS NULL OR lease_expires_at <= $1)
           AND GREATEST(created_at, COALESCE(connected_at, 0), COALESCE(lease_expires_at, 0)) + $2 <= $1
         RETURNING id`,
        [now.getTime(), retentionMs],
      );
      const ids: string[] = deleted.rows.map((row: { id: string }) => row.id);
      if (ids.length > 0) {
        await client.query("UPDATE runner_host_ids SET released_at = $2 WHERE id = ANY($1::text[])", [
          ids,
          now.getTime(),
        ]);
      }
      return ids;
    });
  }

  private async drawHostId(client: PoolClient, createdAt: Date): Promise<string> {
    for (let draw = 0; draw < MAX_ID_DRAWS; draw++) {
      const id = this.mintId();
      const inserted = await client.query(
        `INSERT INTO runner_host_ids (id, holder, created_at, released_at) VALUES ($1, 'share', $2, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [id, createdAt.getTime()],
      );
      if (inserted.rowCount === 1) return id;
    }
    throw new HostIdCollisionError(MAX_ID_DRAWS);
  }
}
