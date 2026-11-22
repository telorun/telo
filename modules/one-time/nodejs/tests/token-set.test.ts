import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KvStore, VersionedValue } from "@telorun/kv-store";
import { LinkSet, type TokenSettings } from "../src/token-set.js";

/** An in-memory store whose every call yields first, so concurrent callers interleave. */
class YieldingStore implements KvStore {
  readonly cells = new Map<string, { value: unknown; version: number }>();
  private versions = 0;
  failOn: ((op: string, key: string) => Error | undefined) | undefined;
  denyDeletes = false;

  private async step(op: string, key: string): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    const failure = this.failOn?.(op, key);
    if (failure) throw failure;
  }

  async get(key: string): Promise<VersionedValue | null> {
    await this.step("get", key);
    const cell = this.cells.get(key);
    return cell ? { value: cell.value, version: String(cell.version) } : null;
  }

  async putIfAbsent(key: string, value: unknown): Promise<VersionedValue | null> {
    await this.step("putIfAbsent", key);
    if (this.cells.has(key)) return null;
    const version = ++this.versions;
    this.cells.set(key, { value, version });
    return { value, version: String(version) };
  }

  async compareAndSet(key: string, expected: string, value: unknown): Promise<VersionedValue | null> {
    await this.step("compareAndSet", key);
    const cell = this.cells.get(key);
    if (!cell || String(cell.version) !== expected) return null;
    const version = ++this.versions;
    this.cells.set(key, { value, version });
    return { value, version: String(version) };
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    await this.step("compareAndDelete", key);
    if (this.denyDeletes) return false;
    const cell = this.cells.get(key);
    if (!cell || String(cell.version) !== expected) return false;
    this.cells.delete(key);
    return true;
  }
}

const settings: TokenSettings = { name: "reset", expiresInMs: 600_000, reissueMs: 1_000 };
const replica = (store: KvStore, clock: () => number) => new LinkSet(store, settings, 32, "OneTime.Links test", clock);

describe("token set on a store shared by replicas", () => {
  it("lets exactly one of two concurrent redemptions of a link succeed", async () => {
    const store = new YieldingStore();
    const [a, b] = [replica(store, () => 0), replica(store, () => 0)];
    const issued = await a.issue({ subject: "ann" });
    if (!issued.issued) throw new Error("not issued");
    const results = await Promise.all([a.redeemLink(issued.token), b.redeemLink(issued.token)]);
    expect(results.filter((r) => r.redeemed)).toHaveLength(1);
    expect(results.find((r) => !r.redeemed)).toEqual({ redeemed: false, reason: "unknown" });
  });

  it("gives one issued answer to two concurrent issues and keeps the winner's token live", async () => {
    const store = new YieldingStore();
    const [a, b] = [replica(store, () => 0), replica(store, () => 0)];
    const results = await Promise.all([a.issue({ subject: "ann" }), b.issue({ subject: "ann" })]);
    const winners = results.filter((r) => r.issued);
    expect(winners).toHaveLength(1);
    expect(results.find((r) => !r.issued)).toEqual({ issued: false, retryAfter: 1 });
    const winner = winners[0];
    if (!winner?.issued) throw new Error("no winner");
    expect(await a.redeemLink(winner.token)).toMatchObject({ redeemed: true, subject: "ann" });
  });

  it("leaves only the old token live when the process dies before the record is replaced", async () => {
    const store = new YieldingStore();
    let now = 0;
    const links = replica(store, () => now);
    const first = await links.issue({ subject: "ann" });
    if (!first.issued) throw new Error("not issued");
    now = 5_000;
    store.failOn = (op, key) => (op === "compareAndSet" && key.includes("/t/") ? new Error("killed") : undefined);
    await expect(links.issue({ subject: "ann" })).rejects.toMatchObject({ code: "ERR_ONE_TIME_STORE_UNAVAILABLE" });
    store.failOn = undefined;
    expect(await links.redeemLink(first.token)).toMatchObject({ redeemed: true });
  });

  it("leaves only the new token live when the process dies before the old lookup is removed", async () => {
    const store = new YieldingStore();
    let now = 0;
    const links = replica(store, () => now);
    const first = await links.issue({ subject: "ann" });
    if (!first.issued) throw new Error("not issued");
    now = 5_000;
    store.failOn = (op, key) => (op === "compareAndDelete" && key.includes("/l/") ? new Error("killed") : undefined);
    await expect(links.issue({ subject: "ann" })).rejects.toMatchObject({ code: "ERR_ONE_TIME_STORE_UNAVAILABLE" });
    store.failOn = undefined;
    expect(await links.redeemLink(first.token)).toEqual({ redeemed: false, reason: "unknown" });
    const newest = [...store.cells.keys()].filter((k) => k.includes("/l/")).find((k) => !k.endsWith(sha(first.token)));
    expect(newest).toBeDefined();
  });

  it("answers the store's failure as ERR_ONE_TIME_STORE_UNAVAILABLE with the thrown value as cause", async () => {
    const store = new YieldingStore();
    const boom = new Error("disk gone");
    store.failOn = () => boom;
    await expect(replica(store, () => 0).issue({ subject: "ann" })).rejects.toMatchObject({
      code: "ERR_ONE_TIME_STORE_UNAVAILABLE",
      cause: boom,
    });
  });

  it("answers a redemption that keeps losing the race as ERR_ONE_TIME_CONTENDED", async () => {
    const store = new YieldingStore();
    const links = replica(store, () => 0);
    const issued = await links.issue({ subject: "ann" });
    if (!issued.issued) throw new Error("not issued");
    store.denyDeletes = true;
    await expect(links.redeemLink(issued.token)).rejects.toMatchObject({ code: "ERR_ONE_TIME_CONTENDED" });
  });
});

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}
