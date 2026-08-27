import { describe, expect, it } from "vitest";

import { reconcile, seedDelta } from "../sync";
import type { AgentWorkspace, TreeFile, WorkspaceBridge } from "../types";

/** A workspace surface over an in-memory tree, so a test asserts on what the
 *  sync decided to write and delete rather than on a transport. */
function fakeWorkspace(
  contents: Record<string, string>,
  excludedPaths: string[] = [],
): AgentWorkspace & { applied: Array<{ write: string[]; remove: string[] }> } {
  const files = new Map(Object.entries(contents));
  const applied: Array<{ write: string[]; remove: string[] }> = [];
  return {
    applied,
    excludedPaths: new Set(excludedPaths),
    async tree(): Promise<TreeFile[]> {
      // Content-as-hash: the sync only ever compares hashes for equality.
      return [...files].map(([path, hash]) => ({ path, hash }));
    },
    async readFile(path) {
      return files.get(path) ?? "";
    },
    async apply(write, remove) {
      applied.push({ write: write.map((w) => w.path), remove });
      for (const w of write) files.set(w.path, w.content);
      for (const p of remove) files.delete(p);
    },
  };
}

function fakeBridge(
  contents: Record<string, string>,
): WorkspaceBridge & { applied: Array<{ writes: string[]; deletes: string[] }> } {
  const files = new Map(Object.entries(contents));
  const applied: Array<{ writes: string[]; deletes: string[] }> = [];
  return {
    applied,
    async snapshot() {
      return new Map(files);
    },
    async readFile(path) {
      return files.get(path) ?? "";
    },
    async applyChanges(writes, deletes) {
      applied.push({ writes: writes.map((w) => w.path), deletes });
      for (const w of writes) files.set(w.path, w.content);
      for (const d of deletes) files.delete(d);
    },
  };
}

describe("seedDelta", () => {
  it("pushes only the difference", async () => {
    const workspace = fakeWorkspace({ "telo.yaml": "a", "stale.yaml": "s" });
    await seedDelta(workspace, fakeBridge({ "telo.yaml": "a", "new.yaml": "n" }));
    expect(workspace.applied).toEqual([{ write: ["new.yaml"], remove: ["stale.yaml"] }]);
  });

  it("does nothing when the two already agree", async () => {
    // Load-bearing for a co-resident agent: every write here is a kernel
    // reload, so a turn that changes nothing must not restart the app.
    const workspace = fakeWorkspace({ "telo.yaml": "a" });
    await seedDelta(workspace, fakeBridge({ "telo.yaml": "a" }));
    expect(workspace.applied).toEqual([]);
  });

  it("never deletes a path the workspace owns", async () => {
    // The runner seeds `telo-workspace.yaml` so every app in the session
    // anchors ONE module cache. The editor's bundle does not carry it, so
    // without the exclusion the first seed would delete it and scatter the
    // cache back into one per app — silently, and only visible as slow boots.
    const workspace = fakeWorkspace(
      { "telo.yaml": "a", "telo-workspace.yaml": "marker" },
      ["telo-workspace.yaml"],
    );
    await seedDelta(workspace, fakeBridge({ "telo.yaml": "a" }));
    expect(workspace.applied).toEqual([]);
  });

  it("does not re-push an excluded path the editor happens to hold", async () => {
    // The other half of the same rule: filtering only the workspace side would
    // make the hash never match, so every turn would write the file — and each
    // write is a reload.
    const workspace = fakeWorkspace(
      { "telo.yaml": "a", "telo-workspace.yaml": "theirs" },
      ["telo-workspace.yaml"],
    );
    await seedDelta(
      workspace,
      fakeBridge({ "telo.yaml": "a", "telo-workspace.yaml": "mine" }),
    );
    expect(workspace.applied).toEqual([]);
  });

  it("ignores vendor directories in both directions", async () => {
    const workspace = fakeWorkspace({ "telo.yaml": "a", ".telo/analysis/x.json": "cache" });
    await seedDelta(workspace, fakeBridge({ "telo.yaml": "a", "node_modules/p/i.js": "dep" }));
    expect(workspace.applied).toEqual([]);
  });
});

describe("reconcile", () => {
  it("pulls what the agent wrote and deletes what it removed", async () => {
    const workspace = fakeWorkspace({ "telo.yaml": "written-by-agent" });
    const bridge = fakeBridge({ "telo.yaml": "a", "removed.yaml": "r" });
    await reconcile(workspace, bridge);
    expect(bridge.applied).toEqual([
      { writes: ["telo.yaml"], deletes: ["removed.yaml"] },
    ]);
  });

  it("does not pull runner infrastructure into the user's workspace", async () => {
    const bridge = fakeBridge({ "telo.yaml": "a" });
    await reconcile(
      fakeWorkspace({ "telo.yaml": "a", "telo-workspace.yaml": "marker" }, [
        "telo-workspace.yaml",
      ]),
      bridge,
    );
    expect(bridge.applied).toEqual([]);
  });
});
