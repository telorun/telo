import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSessionId } from "../session/session-id.js";
import { MemoryShareStore } from "../test-support/memory-share-store.js";
import { HostIdCollisionError } from "./host-id.js";
import { PostgresSessionStore } from "./postgres-session-store.js";
import {
  shareConnected,
  shareLastActiveAt,
  type ShareOwner,
  type ShareRecord,
  type ShareStore,
} from "./share-store.js";

/** Postgres runs only when `RUNNER_SESSION_STORE_TEST_URL` names a THROWAWAY database. */
const POSTGRES_URL = process.env.RUNNER_SESSION_STORE_TEST_URL?.trim() || undefined;

const drawn: string[] = [];
const mintId = () => drawn.shift() ?? generateSessionId();

interface Opened {
  shares: ShareStore;
  /** Every id in the host-id namespace and whether it is released. */
  hostIds(): Promise<Array<{ id: string; holder: string; released: boolean }>>;
  /** Holds `id` as a session's, where the backend has sessions. */
  claimSessionId?(id: string): Promise<void>;
  close(): Promise<void>;
}

const backends: Array<[string, () => Promise<Opened>]> = [
  [
    "memory",
    async () => {
      const store = new MemoryShareStore(mintId);
      return {
        shares: store,
        hostIds: async () =>
          [...store.hostIds].map(([id, v]) => ({ id, holder: v.holder, released: v.releasedAt !== null })),
        close: async () => undefined,
      };
    },
  ],
];

if (POSTGRES_URL) {
  backends.push([
    "postgres",
    async () => {
      const admin = new pg.Pool({ connectionString: POSTGRES_URL });
      await admin.query(
        "DROP TABLE IF EXISTS runner_shares, runner_host_ids, runner_sessions, runner_dpop_jtis, runner_schema_version",
      );
      const store = await PostgresSessionStore.open(POSTGRES_URL, {
        mintId,
        onIdleClientError: (err) => {
          throw err;
        },
      });
      return {
        shares: store.shares,
        hostIds: async () =>
          (await admin.query("SELECT id, holder, released_at FROM runner_host_ids ORDER BY id")).rows.map((r) => ({
            id: r.id,
            holder: r.holder,
            released: r.released_at !== null,
          })),
        claimSessionId: async (id) => {
          drawn.push(id);
          await store.create({
            owner: { kind: "identity", iss: "https://id.example", sub: "session-owner" },
            workspace: "w",
            agent: null,
            apps: [],
            config: {},
            status: "running",
            createdAt: new Date(0),
            lastActiveAt: new Date(0),
            suspendedAt: null,
            containerEngine: null,
          });
        },
        close: async () => {
          await store.close();
          await admin.end();
        },
      };
    },
  ]);
}

const ALICE: ShareOwner = { kind: "identity", iss: "https://id.example", sub: "alice" };
const BOB: ShareOwner = { kind: "identity", iss: "https://id.example", sub: "bob" };
const T0 = new Date(1_000_000);
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE = 15_000;
const LIMITS = { maxConnected: 100, maxConnectedPerOwner: 100 };

describe.each(backends)("%s share store", (_name, open) => {
  let opened: Opened;
  let shares: ShareStore;

  beforeEach(async () => {
    drawn.length = 0;
    opened = await open();
    shares = opened.shares;
  });
  afterEach(async () => {
    await opened.close();
  });
  afterAll(() => undefined);

  const create = async (owner: ShareOwner, name: string, id?: string, now = T0): Promise<ShareRecord> => {
    if (id) drawn.push(id);
    const outcome = await shares.createShare({ owner, name, application: "App", now, maxPerOwner: 10 });
    if (outcome.kind === "limit") throw new Error("limit");
    return outcome.share;
  };
  const connect = (id: string, epoch: number | null, now: Date, limits: Partial<typeof LIMITS> = {}) =>
    shares.connectShare({ id, epoch, now, leaseMs: LEASE, ...LIMITS, ...limits });

  it("gets or creates by name per owner, and refuses past the owner's limit", async () => {
    drawn.push("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    const first = await shares.createShare({ owner: ALICE, name: "demo", application: "App", now: T0, maxPerOwner: 2 });
    expect(first).toMatchObject({ kind: "created", share: { id: "aaaaaaaaaaaa", name: "demo", epoch: 0 } });
    const again = await shares.createShare({ owner: ALICE, name: "demo", application: "Other", now: at(5), maxPerOwner: 2 });
    expect(again).toMatchObject({ kind: "exists", share: { id: "aaaaaaaaaaaa", application: "App" } });
    const bobs = await shares.createShare({ owner: BOB, name: "demo", application: "App", now: T0, maxPerOwner: 2 });
    expect(bobs).toMatchObject({ kind: "created", share: { id: "bbbbbbbbbbbb" } });
    await shares.createShare({ owner: ALICE, name: "two", application: "App", now: T0, maxPerOwner: 2 });
    expect(await shares.createShare({ owner: ALICE, name: "three", application: "App", now: T0, maxPerOwner: 2 })).toEqual({
      kind: "limit",
    });
    expect(await shares.createShare({ owner: ALICE, name: "demo", application: "App", now: T0, maxPerOwner: 2 })).toMatchObject({
      kind: "exists",
    });
  });

  it("looks a share up by id with its owner, and lists an owner's own", async () => {
    const mine = await create(ALICE, "a", "aaaaaaaaaaaa");
    await create(BOB, "b", "bbbbbbbbbbbb");
    expect(await shares.getShare("aaaaaaaaaaaa")).toEqual(mine);
    expect(await shares.getShare("nope")).toBeUndefined();
    expect((await shares.listShares(ALICE)).map((s) => s.id)).toEqual(["aaaaaaaaaaaa"]);
  });

  it("deletes only the owner's share, releasing its id, which is never drawn again", async () => {
    await create(ALICE, "a", "aaaaaaaaaaaa");
    expect(await shares.deleteShare("aaaaaaaaaaaa", BOB, at(1))).toBe(false);
    expect(await shares.deleteShare("nope", ALICE, at(1))).toBe(false);
    expect(await shares.deleteShare("aaaaaaaaaaaa", ALICE, at(1))).toBe(true);
    expect(await shares.deleteShare("aaaaaaaaaaaa", ALICE, at(2))).toBe(false);
    expect(await shares.getShare("aaaaaaaaaaaa")).toBeUndefined();
    expect(await opened.hostIds()).toEqual([{ id: "aaaaaaaaaaaa", holder: "share", released: true }]);
    const reborn = await create(ALICE, "a", undefined);
    drawn.push("aaaaaaaaaaaa", "cccccccccccc");
    const next = await create(ALICE, "again");
    expect(next.id).toBe("cccccccccccc");
    expect(reborn.id).not.toBe("aaaaaaaaaaaa");
  });

  it("draws again when an id is held or released, and fails after three collisions", async () => {
    await create(ALICE, "a", "aaaaaaaaaaaa");
    await shares.deleteShare("aaaaaaaaaaaa", ALICE, at(1));
    await create(ALICE, "b", "bbbbbbbbbbbb");
    drawn.push("aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc");
    expect((await create(ALICE, "c")).id).toBe("cccccccccccc");
    drawn.push("aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc");
    await expect(create(ALICE, "d")).rejects.toThrow(HostIdCollisionError);
    expect(await shares.listShares(ALICE)).toHaveLength(2);
  });

  it("draws again when an id is held by a session", async (ctx) => {
    if (!opened.claimSessionId) return ctx.skip();
    await opened.claimSessionId("ssssssssssss");
    drawn.push("ssssssssssss", "dddddddddddd");
    expect((await create(ALICE, "a")).id).toBe("dddddddddddd");
  });

  it("fences: a first connect takes epoch 1, another first connect takes over, a stale epoch is superseded", async () => {
    const { id } = await create(ALICE, "a");
    expect(await connect(id, null, at(0))).toEqual({ kind: "connected", epoch: 1 });
    expect(await connect(id, null, at(1_000))).toEqual({ kind: "connected", epoch: 2 });
    expect(await connect(id, 1, at(2_000))).toEqual({ kind: "superseded" });
    expect(await connect(id, 2, at(3_000))).toEqual({ kind: "connected", epoch: 2 });
    expect(await connect("nope", null, at(0))).toEqual({ kind: "gone" });
    const share = (await shares.getShare(id))!;
    expect(share).toMatchObject({ epoch: 2, connectedAt: at(3_000), leaseExpiresAt: at(3_000 + LEASE) });
  });

  it("answers gone for a deleted share", async () => {
    const { id } = await create(ALICE, "a");
    await shares.deleteShare(id, ALICE, at(1));
    expect(await connect(id, null, at(2))).toEqual({ kind: "gone" });
  });

  it("holds the runner-wide and per-owner limits in the connect, counting a takeover once", async () => {
    const a1 = await create(ALICE, "a1");
    const a2 = await create(ALICE, "a2");
    const b1 = await create(BOB, "b1");
    expect(await connect(a1.id, null, at(0), { maxConnected: 2, maxConnectedPerOwner: 1 })).toMatchObject({ kind: "connected" });
    // A takeover of the owner's own share is not a second connection.
    expect(await connect(a1.id, null, at(1), { maxConnected: 2, maxConnectedPerOwner: 1 })).toEqual({ kind: "connected", epoch: 2 });
    expect(await connect(a2.id, null, at(2), { maxConnected: 2, maxConnectedPerOwner: 1 })).toEqual({ kind: "owner_limit" });
    expect(await connect(b1.id, null, at(2), { maxConnected: 1, maxConnectedPerOwner: 1 })).toEqual({ kind: "capacity" });
    expect(await connect(b1.id, null, at(2), { maxConnected: 2, maxConnectedPerOwner: 1 })).toMatchObject({ kind: "connected" });
    // The first lease lapsed: it holds no slot.
    expect(await connect(a2.id, null, at(1 + LEASE + 1), { maxConnected: 2, maxConnectedPerOwner: 1 })).toMatchObject({
      kind: "connected",
    });
  });

  it("holds the runner-wide limit across connects made at once", async () => {
    const made = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => create(n % 2 ? ALICE : BOB, `s${n}`)));
    const outcomes = await Promise.all(made.map((s) => connect(s.id, null, at(0), { maxConnected: 2 })));
    expect(outcomes.filter((o) => o.kind === "connected")).toHaveLength(2);
    expect(outcomes.filter((o) => o.kind === "capacity")).toHaveLength(4);
  });

  it("renews many leases in one write, saying which are renewed, gone or moved on", async () => {
    const a = await create(ALICE, "a");
    const b = await create(ALICE, "b");
    const c = await create(ALICE, "c");
    await connect(a.id, null, at(0));
    await connect(b.id, null, at(0));
    await connect(b.id, null, at(1)); // b is now epoch 2
    await connect(c.id, null, at(0));
    await shares.deleteShare(c.id, ALICE, at(2));
    const renewals = await shares.renewShareLeases(
      [
        { id: a.id, epoch: 1 },
        { id: b.id, epoch: 1 },
        { id: c.id, epoch: 1 },
        { id: "nope", epoch: 1 },
      ],
      at(5_000),
      LEASE,
    );
    expect(renewals.map((r) => [r.id, r.outcome])).toEqual([
      [a.id, "renewed"],
      [b.id, "epoch_moved"],
      [c.id, "gone"],
      ["nope", "gone"],
    ]);
    expect((await shares.getShare(a.id))!.leaseExpiresAt).toEqual(at(5_000 + LEASE));
    expect((await shares.getShare(b.id))!.leaseExpiresAt).toEqual(at(1 + LEASE));
    expect(await shares.renewShareLeases([], at(0), LEASE)).toEqual([]);
  });

  it("releases on a clean close only for the epoch held, so a fenced close leaves the share connected", async () => {
    const { id } = await create(ALICE, "a");
    await connect(id, null, at(0));
    await connect(id, null, at(1_000)); // takeover: epoch 2
    expect(await shares.releaseShare({ id, epoch: 1 }, at(2_000))).toBe(false);
    expect(shareConnected((await shares.getShare(id))!, at(2_000))).toBe(true);
    expect(await shares.releaseShare({ id, epoch: 2 }, at(3_000))).toBe(true);
    expect(shareConnected((await shares.getShare(id))!, at(3_000))).toBe(false);
    expect(await shares.releaseShare({ id, epoch: 2 }, at(4_000))).toBe(false);
  });

  it("sweeps a share not connected past its retention, never a connected one", async () => {
    const retention = 100_000;
    const never = await create(ALICE, "never");
    const closed = await create(ALICE, "closed");
    const live = await create(ALICE, "live");
    await connect(closed.id, null, at(0));
    await shares.releaseShare({ id: closed.id, epoch: 1 }, at(10_000));
    await connect(live.id, null, at(0));
    await shares.renewShareLeases([{ id: live.id, epoch: 1 }], at(0), 10_000_000);
    // `never` expires `retention` after its creation, `closed` after its close.
    expect(await shares.sweepExpiredShares(at(retention - 1), retention)).toEqual([]);
    expect(await shares.sweepExpiredShares(at(retention), retention)).toEqual([never.id]);
    expect(await shares.sweepExpiredShares(at(10_000 + retention - 1), retention)).toEqual([]);
    expect(await shares.sweepExpiredShares(at(10_000 + retention), retention)).toEqual([closed.id]);
    // Connected, `live` outlasts the window; once its lease lapses it ages like any other.
    expect(await shares.sweepExpiredShares(at(9_999_999), retention)).toEqual([]);
    expect(await shares.getShare(live.id)).toBeDefined();
    const released = (await opened.hostIds()).filter((r) => r.released).map((r) => r.id).sort();
    expect(released).toEqual([closed.id, never.id].sort());
  });
});

describe("a share's clock", () => {
  const base: ShareRecord = {
    id: "x",
    owner: ALICE,
    name: "n",
    application: "a",
    createdAt: at(0),
    epoch: 0,
    connectedAt: null,
    leaseExpiresAt: null,
  };

  it("is connected while its lease lies ahead", () => {
    const share = { ...base, connectedAt: at(10), leaseExpiresAt: at(100) };
    expect(shareConnected(share, at(99))).toBe(true);
    expect(shareConnected(share, at(100))).toBe(false);
    expect(shareConnected(base, at(0))).toBe(false);
  });

  it("was last active at the latest of its creation, last connect and a lease that is past", () => {
    const share = { ...base, connectedAt: at(10), leaseExpiresAt: at(100) };
    expect(shareLastActiveAt(base, at(5)).getTime()).toBe(at(0).getTime());
    expect(shareLastActiveAt(share, at(50)).getTime()).toBe(at(10).getTime());
    expect(shareLastActiveAt(share, at(200)).getTime()).toBe(at(100).getTime());
  });
});
