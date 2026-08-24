import { beforeEach, describe, expect, it } from "vitest";
import { HistoryManager } from "./manager";
import type { HistoryState, HistoryStore, Snapshot } from "./store";

class InMemoryStore implements HistoryStore {
  state: HistoryState = {};
  saveCount = 0;
  load(): HistoryState {
    return this.state;
  }
  save(state: HistoryState): void {
    this.state = state;
    this.saveCount += 1;
  }
  clear(): void {
    this.state = {};
  }
}

const MODULE = "/ws/app/telo.yaml";
const FILE = "/ws/app/telo.yaml";

function snap(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    filePath: FILE,
    before: "old",
    after: "new",
    timestamp: 1000,
    ...partial,
  };
}

describe("HistoryManager", () => {
  let store: InMemoryStore;
  let mgr: HistoryManager;

  beforeEach(() => {
    store = new InMemoryStore();
    mgr = new HistoryManager(store, "/ws");
  });

  it("starts empty for an unknown module", () => {
    expect(mgr.canUndo(MODULE)).toBe(false);
    expect(mgr.canRedo(MODULE)).toBe(false);
    expect(mgr.peekUndo(MODULE)).toBeNull();
    expect(mgr.peekRedo(MODULE)).toBeNull();
  });

  it("records an edit and exposes it as undo-able", () => {
    mgr.recordEdit(MODULE, snap());
    expect(mgr.canUndo(MODULE)).toBe(true);
    expect(mgr.canRedo(MODULE)).toBe(false);
    expect(mgr.peekUndo(MODULE)).toMatchObject({ before: "old", after: "new" });
  });

  it("undo returns the snapshot to restore and moves the cursor back", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B" }));
    mgr.recordEdit(MODULE, snap({ before: "B", after: "C", timestamp: 3000 }));

    const s1 = mgr.undo(MODULE);
    expect(s1).toMatchObject({ before: "B", after: "C" });
    expect(mgr.canUndo(MODULE)).toBe(true);
    expect(mgr.canRedo(MODULE)).toBe(true);

    const s2 = mgr.undo(MODULE);
    expect(s2).toMatchObject({ before: "A", after: "B" });
    expect(mgr.canUndo(MODULE)).toBe(false);
    expect(mgr.canRedo(MODULE)).toBe(true);

    expect(mgr.undo(MODULE)).toBeNull();
  });

  it("redo walks forward through the stack", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B" }));
    mgr.recordEdit(MODULE, snap({ before: "B", after: "C", timestamp: 3000 }));
    mgr.undo(MODULE);
    mgr.undo(MODULE);

    expect(mgr.redo(MODULE)).toMatchObject({ before: "A", after: "B" });
    expect(mgr.redo(MODULE)).toMatchObject({ before: "B", after: "C" });
    expect(mgr.redo(MODULE)).toBeNull();
  });

  it("a new edit after undo truncates the redo tail", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B" }));
    mgr.recordEdit(MODULE, snap({ before: "B", after: "C", timestamp: 3000 }));
    mgr.undo(MODULE);
    expect(mgr.canRedo(MODULE)).toBe(true);

    // A fresh edit beyond the coalescing window — truncates redo.
    mgr.recordEdit(MODULE, snap({ before: "B", after: "D", timestamp: 10000 }));
    expect(mgr.canRedo(MODULE)).toBe(false);
    expect(mgr.peekUndo(MODULE)).toMatchObject({ before: "B", after: "D" });
  });

  it("coalesces same-file edits within 1s into the latest `after`, preserving the earliest `before`", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B", timestamp: 1000 }));
    mgr.recordEdit(MODULE, snap({ before: "B", after: "C", timestamp: 1500 }));
    mgr.recordEdit(MODULE, snap({ before: "C", after: "D", timestamp: 1900 }));

    // Only one snapshot survives — its `before` is the earliest, `after` the latest.
    expect(mgr.peekUndo(MODULE)).toMatchObject({ before: "A", after: "D" });
    mgr.undo(MODULE);
    expect(mgr.canUndo(MODULE)).toBe(false);
  });

  it("does NOT coalesce when the gap is >= 1s", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B", timestamp: 1000 }));
    mgr.recordEdit(MODULE, snap({ before: "B", after: "C", timestamp: 2000 }));

    expect(mgr.peekUndo(MODULE)).toMatchObject({ before: "B", after: "C" });
    mgr.undo(MODULE);
    expect(mgr.peekUndo(MODULE)).toMatchObject({ before: "A", after: "B" });
  });

  it("does NOT coalesce across different files", () => {
    mgr.recordEdit(MODULE, snap({ filePath: "/ws/app/telo.yaml", timestamp: 1000 }));
    mgr.recordEdit(MODULE, snap({ filePath: "/ws/app/routes.yaml", timestamp: 1100 }));

    expect(mgr.peekUndo(MODULE)).toMatchObject({ filePath: "/ws/app/routes.yaml" });
    mgr.undo(MODULE);
    expect(mgr.peekUndo(MODULE)).toMatchObject({ filePath: "/ws/app/telo.yaml" });
  });

  it("enforces per-module cap, dropping oldest", () => {
    const small = new HistoryManager(store, "/ws", 3);
    for (let i = 0; i < 5; i++) {
      small.recordEdit(MODULE, snap({ before: `v${i}`, after: `v${i + 1}`, timestamp: 1000 + i * 2000 }));
    }
    // Cap=3: should keep v2→v3, v3→v4, v4→v5.
    expect(small.peekUndo(MODULE)).toMatchObject({ before: "v4", after: "v5" });
    small.undo(MODULE);
    small.undo(MODULE);
    small.undo(MODULE);
    expect(small.canUndo(MODULE)).toBe(false);
    // Cannot undo past the oldest retained entry.
  });

  it("keeps per-module stacks independent", () => {
    const OTHER = "/ws/other/telo.yaml";
    mgr.recordEdit(MODULE, snap({ before: "a", after: "b" }));
    mgr.recordEdit(OTHER, snap({ before: "x", after: "y", timestamp: 2000 }));

    expect(mgr.canUndo(MODULE)).toBe(true);
    expect(mgr.canUndo(OTHER)).toBe(true);
    mgr.undo(MODULE);
    expect(mgr.canUndo(MODULE)).toBe(false);
    expect(mgr.canUndo(OTHER)).toBe(true); // unaffected
  });

  it("persists via the store on every mutation and reloads on construction", () => {
    mgr.recordEdit(MODULE, snap({ before: "A", after: "B" }));
    expect(store.saveCount).toBeGreaterThan(0);

    // Reconstruct from the same store — state should round-trip.
    const mgr2 = new HistoryManager(store, "/ws");
    expect(mgr2.canUndo(MODULE)).toBe(true);
    expect(mgr2.peekUndo(MODULE)).toMatchObject({ before: "A", after: "B" });
  });

  it("pruneStaleModules drops entries for modules no longer in the workspace", () => {
    mgr.recordEdit("/ws/app/telo.yaml", snap());
    mgr.recordEdit("/ws/ghost/telo.yaml", snap({ timestamp: 2000 }));

    mgr.pruneStaleModules(new Set(["/ws/app/telo.yaml"]));

    expect(mgr.canUndo("/ws/app/telo.yaml")).toBe(true);
    expect(mgr.canUndo("/ws/ghost/telo.yaml")).toBe(false);
  });

  it("pruneStaleSnapshots drops entries whose file no longer exists and clamps cursor", () => {
    mgr.recordEdit(MODULE, snap({ filePath: "/ws/app/telo.yaml", timestamp: 1000 }));
    mgr.recordEdit(MODULE, snap({ filePath: "/ws/app/gone.yaml", timestamp: 3000 }));
    mgr.recordEdit(MODULE, snap({ filePath: "/ws/app/telo.yaml", timestamp: 5000 }));
    // cursor = 3 (end)

    mgr.pruneStaleSnapshots(MODULE, new Set(["/ws/app/telo.yaml"]));

    // The gone.yaml entry should be filtered out; two entries remain.
    expect(mgr.canUndo(MODULE)).toBe(true);
    mgr.undo(MODULE);
    mgr.undo(MODULE);
    expect(mgr.canUndo(MODULE)).toBe(false);
  });
});
