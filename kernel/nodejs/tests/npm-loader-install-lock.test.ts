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

// Package installs dedupe per alias, so N controllers are N withInstallLock
// calls on ONE root. They must queue in memory rather than each polling the
// filesystem lock and printing the cross-process wait notice — `telo install`
// with 52 controllers printed 51 of them.
describe("same-process queuing", () => {
  /** Capture stderr for the duration of `fn`. */
  async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
    const original = process.stderr.write;
    let out = "";
    (process.stderr as NodeJS.WriteStream).write = ((chunk: unknown) => {
      out += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return out;
  }

  it("does not print a wait notice when the holder is this process", async () => {
    // The holder runs longer than LOCK_WAIT_NOTICE_MS (2s): pre-fix each waiter
    // crossed that threshold on the fs lock and announced itself.
    const out = await captureStderr(async () => {
      const calls = Array.from({ length: 8 }, (_, i) =>
        withInstallLock(root, async () => {
          if (i === 0) await new Promise((r) => setTimeout(r, 2_500));
        }),
      );
      await Promise.all(calls);
    });
    expect(out).not.toContain("waiting for controller install lock");
  }, 20_000);

  it("leaves no lock file behind and runs every queued caller exactly once", async () => {
    let runs = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withInstallLock(root, async () => {
          runs++;
        }),
      ),
    );
    expect(runs).toBe(8);
    expect(await exists(lockPath())).toBe(false);
  });

  it("never overlaps two queued callers' critical sections", async () => {
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withInstallLock(root, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });

  it("a failing caller does not wedge the queue behind it", async () => {
    const results = await Promise.allSettled([
      withInstallLock(root, async () => {
        throw new Error("boom");
      }),
      withInstallLock(root, async () => "second"),
      withInstallLock(root, async () => "third"),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "second" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "third" });
  });

  it("still prints the notice when another PROCESS holds the lock", async () => {
    // A foreign, heartbeat-fresh lock: the notice's actual purpose. Kept fresh
    // so `reclaimIfStale` can't repossess it mid-wait.
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid + 1, host: "elsewhere", startedAt: Date.now() }),
    );
    const beat = setInterval(() => {
      const now = new Date();
      void fs.utimes(lockPath(), now, now).catch(() => {});
    }, 1_000);
    try {
      const out = await captureStderr(async () => {
        const attempt = withInstallLock(root, async () => "unreachable");
        await new Promise((r) => setTimeout(r, 2_800));
        await fs.rm(lockPath(), { force: true });
        await attempt;
      });
      expect(out).toContain("waiting for controller install lock");
    } finally {
      clearInterval(beat);
    }
  }, 20_000);
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
