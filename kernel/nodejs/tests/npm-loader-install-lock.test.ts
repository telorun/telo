import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing__ } from "../src/controller-loaders/npm-loader.js";

const { withInstallLock, reclaimIfStale, LOCK_STALE_MS, LOCK_HEARTBEAT_MS } = __testing__;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "telo-lock-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const lockPath = () => path.join(root, ".lock");
const exists = async (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** Backdate a file's mtime by `ageMs` to simulate a silent heartbeat. */
async function ageLock(p: string, ageMs: number): Promise<void> {
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(p, t, t);
}

describe("withInstallLock", () => {
  it("runs fn while holding the lock, then releases it", async () => {
    let heldDuringFn = false;
    const result = await withInstallLock(root, async () => {
      heldDuringFn = await exists(lockPath());
      return 42;
    });
    expect(result).toBe(42);
    expect(heldDuringFn).toBe(true);
    // Released afterward.
    expect(await exists(lockPath())).toBe(false);
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withInstallLock(root, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(lockPath())).toBe(false);
  });

  it("serializes two concurrent holders", async () => {
    const order: string[] = [];
    const a = withInstallLock(root, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a-end");
    });
    // Ensure A wins the open() race before B is queued.
    await new Promise((r) => setTimeout(r, 5));
    const b = withInstallLock(root, async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // B must not interleave inside A's critical section.
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("reclaims a stale lock left by a crashed holder (mtime-only, no PID probe)", async () => {
    // A lock file naming a PID that is very much alive (this test process) must
    // still be reclaimed once its heartbeat goes silent — the old PID-liveness
    // probe would have treated it as held forever.
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }),
    );
    await ageLock(lockPath(), LOCK_STALE_MS + 5_000);

    const ran = await withInstallLock(root, async () => "acquired");
    expect(ran).toBe("acquired");
  });

  it(
    "keeps the lock fresh via heartbeat during a long fn so a peer does not reclaim it",
    async () => {
      await withInstallLock(root, async () => {
        const before = (await fs.stat(lockPath())).mtimeMs;
        // Poll until the heartbeat bumps the mtime. Polling (rather than a
        // single check after a fixed sleep) keeps the test robust when a busy
        // event loop delays the unref'd heartbeat timer under full-suite load.
        const deadline = Date.now() + LOCK_HEARTBEAT_MS * 3 + 2_000;
        let after = before;
        while (after <= before && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          after = (await fs.stat(lockPath())).mtimeMs;
        }
        expect(after).toBeGreaterThan(before);
      });
    },
    LOCK_HEARTBEAT_MS * 3 + 5_000,
  );
});

describe("reclaimIfStale", () => {
  it("returns false and leaves a fresh lock untouched", async () => {
    await fs.writeFile(lockPath(), "{}");
    expect(await reclaimIfStale(lockPath())).toBe(false);
    expect(await exists(lockPath())).toBe(true);
  });

  it("reclaims (removes) a stale lock", async () => {
    await fs.writeFile(lockPath(), "{}");
    await ageLock(lockPath(), LOCK_STALE_MS + 5_000);
    expect(await reclaimIfStale(lockPath())).toBe(true);
    expect(await exists(lockPath())).toBe(false);
  });

  it("treats a vanished lock as reclaimable", async () => {
    expect(await reclaimIfStale(lockPath())).toBe(true);
  });

  it("is safe under a concurrent double-reclaim (only one wins, neither throws)", async () => {
    await fs.writeFile(lockPath(), "{}");
    await ageLock(lockPath(), LOCK_STALE_MS + 5_000);
    const [a, b] = await Promise.all([reclaimIfStale(lockPath()), reclaimIfStale(lockPath())]);
    // Both resolve truthy (either won the rename or saw it already gone); no throw.
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(await exists(lockPath())).toBe(false);
    // No tombstone left behind.
    const leftovers = (await fs.readdir(root)).filter((f) => f.includes(".stale."));
    expect(leftovers).toEqual([]);
  });
});
