import { describe, expect, it } from "vitest";

import { applyReverted, reconcile, seedDelta } from "../sync";
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
    editorFile: () => null,
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

  it("never touches the agent's own state directory", async () => {
    // `.telo-agent` holds the agent's database on the shared volume: pushing
    // the editor's view would delete it, pulling it would make it a project file.
    const workspace = fakeWorkspace({ "telo.yaml": "a", ".telo-agent/agent.sqlite": "db" });
    await seedDelta(workspace, fakeBridge({ "telo.yaml": "a" }));
    expect(workspace.applied).toEqual([]);
    const bridge = fakeBridge({ "telo.yaml": "a" });
    await reconcile(workspace, bridge);
    expect(bridge.applied).toEqual([]);
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

describe("applyReverted", () => {
  // Content-as-hash, as above: a digest is the content it stands for.
  const revertOf = (path: string, before: string | null, after: string | null) => [
    { turnId: "t1", files: [{ path, before, after }] },
  ];
  // A second file, so the tree is not empty.
  const other = { "other.yaml": "o" };

  it("does nothing, and reports nothing, where the workspace does not hold what the revert restored", async () => {
    const bridge = fakeBridge({ "a.yaml": "after", ...other });
    const kept = await applyReverted(fakeWorkspace({ "a.yaml": "later", ...other }), bridge, revertOf("a.yaml", "before", "after"));
    expect(bridge.applied).toEqual([]);
    expect(kept.get("t1")).toEqual([]);
  });

  it("does nothing where the editor already holds what the revert restored", async () => {
    const bridge = fakeBridge({ "a.yaml": "before", ...other });
    const kept = await applyReverted(fakeWorkspace({ "a.yaml": "before", ...other }), bridge, revertOf("a.yaml", "before", "after"));
    expect(bridge.applied).toEqual([]);
    expect(kept.get("t1")).toEqual([]);
  });

  it("replaces an editor copy still holding what the turn left with the workspace's content", async () => {
    const bridge = fakeBridge({ "a.yaml": "after", ...other });
    const kept = await applyReverted(fakeWorkspace({ "a.yaml": "before", ...other }), bridge, revertOf("a.yaml", "before", "after"));
    expect(bridge.applied).toEqual([{ writes: ["a.yaml"], deletes: [] }]);
    expect(await bridge.readFile("a.yaml")).toBe("before");
    expect(kept.get("t1")).toEqual([]);
  });

  it("leaves an editor copy holding anything else, and reports its path as kept", async () => {
    const bridge = fakeBridge({ "a.yaml": "my edit", ...other });
    const kept = await applyReverted(fakeWorkspace({ "a.yaml": "before", ...other }), bridge, revertOf("a.yaml", "before", "after"));
    expect(bridge.applied).toEqual([]);
    expect(kept.get("t1")).toEqual(["a.yaml"]);
  });

  it("deletes a file the turn created whose editor copy still holds what the turn left", async () => {
    const bridge = fakeBridge({ "new.yaml": "after", ...other });
    await applyReverted(fakeWorkspace(other), bridge, revertOf("new.yaml", null, "after"));
    expect(bridge.applied).toEqual([{ writes: [], deletes: ["new.yaml"] }]);
  });

  it("writes back a file the turn deleted that the editor does not have", async () => {
    const bridge = fakeBridge(other);
    await applyReverted(fakeWorkspace({ "gone.yaml": "before", ...other }), bridge, revertOf("gone.yaml", "before", null));
    expect(bridge.applied).toEqual([{ writes: ["gone.yaml"], deletes: [] }]);
    expect(await bridge.readFile("gone.yaml")).toBe("before");
  });

  it("on an empty tree, deletes a created file still holding what the turn left and keeps an edited one, which alone is seeded back", async () => {
    const workspace = fakeWorkspace({});
    const bridge = fakeBridge({ "p.yaml": "after", "q.yaml": "my edit" });

    const kept = await applyReverted(workspace, bridge, [
      {
        turnId: "t1",
        files: [
          { path: "p.yaml", before: null, after: "after" },
          { path: "q.yaml", before: null, after: "after" },
        ],
      },
    ]);

    expect(bridge.applied).toEqual([{ writes: [], deletes: ["p.yaml"] }]);
    expect(kept.get("t1")).toEqual(["q.yaml"]);

    await seedDelta(workspace, bridge);
    expect(workspace.applied).toEqual([{ write: ["q.yaml"], remove: [] }]);
  });

  it("on an empty tree, leaves a modified file alone and reports nothing: the workspace does not hold what was restored", async () => {
    const bridge = fakeBridge({ "r.yaml": "after" });
    const kept = await applyReverted(fakeWorkspace({}), bridge, revertOf("r.yaml", "before", "after"));
    expect(bridge.applied).toEqual([]);
    expect(kept.get("t1")).toEqual([]);
  });

  it("on an empty tree, does nothing for a file the turn deleted that the editor does not have", async () => {
    const bridge = fakeBridge({});
    const kept = await applyReverted(fakeWorkspace({}), bridge, revertOf("s.yaml", "before", null));
    expect(bridge.applied).toEqual([]);
    expect(kept.get("t1")).toEqual([]);
  });

  it("rejects, changing nothing, when the workspace's tree cannot be read", async () => {
    const workspace = fakeWorkspace({});
    workspace.tree = async () => {
      throw new Error("GET /workspace failed (500)");
    };
    const bridge = fakeBridge({ "p.yaml": "after" });

    await expect(applyReverted(workspace, bridge, revertOf("p.yaml", null, "after"))).rejects.toThrow(
      "GET /workspace failed (500)",
    );
    expect(bridge.applied).toEqual([]);
  });
});
