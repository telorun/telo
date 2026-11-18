import { describe, expect, it } from "vitest";

import { MemoryShareStore } from "../test-support/memory-share-store.js";
import { ShareRetention } from "./share-retention.js";

const ALICE = { kind: "identity", iss: "https://id.example", sub: "alice" } as const;

describe("the share retention sweep", () => {
  it("deletes a share that stayed unconnected past retention, and never a connected one", async () => {
    const store = new MemoryShareStore();
    const t0 = new Date(0);
    const created = async (name: string) =>
      (await store.createShare({ owner: ALICE, name, application: "A", now: t0, maxPerOwner: 10 }));
    const idle = (await created("idle")) as { share: { id: string } };
    const live = (await created("live")) as { share: { id: string } };
    await store.connectShare({ id: live.share.id, epoch: null, now: t0, leaseMs: 10 ** 9, maxConnected: 9, maxConnectedPerOwner: 9 });
    let now = new Date(999);
    const logged: unknown[] = [];
    const sweep = new ShareRetention({
      store,
      retentionMs: 1_000,
      log: { info: (o) => logged.push(o), error: (o) => logged.push(o) },
      now: () => now,
    });
    expect(await sweep.tick()).toEqual([]);
    now = new Date(1_000);
    expect(await sweep.tick()).toEqual([idle.share.id]);
    now = new Date(10 ** 8);
    expect(await sweep.tick()).toEqual([]);
    expect(await store.getShare(live.share.id)).toBeDefined();
    expect(logged).toEqual([{ shares: [idle.share.id] }]);
  });
});
