import { describe, expect, it } from "vitest";
import type { AppCanvasModel, GraphNode } from "./application-canvas-model";
import { buildContainmentTree, type ContainmentTree } from "./containment";
import type { NodePort } from "./node-ports";
import type { LabeledEdge } from "./overview-graph";
import {
  boxKey,
  CONTAINER_HEADER,
  expandableKeys,
  layoutNested,
  type NestedLayout,
} from "./nested-layout";

function node(name: string, capability = "Telo.Service", isRoot = false): GraphNode {
  return { kind: `Demo.${name}`, name, capability, ...(isRoot ? { isRoot: true } : {}) };
}

function edge(from: string, to: string, label = "ref"): LabeledEdge {
  return { from, to, label };
}

/** An array-of-refs port — the shape that carries an add slot. */
function arrayPort(label: string, slots: string[], createKinds: string[]): NodePort {
  return {
    key: `${label}[]`,
    label,
    flavor: "edge",
    refs: ["Telo.Runnable"],
    capabilities: ["Telo.Runnable"],
    slots: slots.map((target, i) => ({ concretePath: `${label}[${i}]`, target })),
    addPath: `${label}[${slots.length}]`,
    createKinds,
  };
}

function open(tree: ContainmentTree, ...paths: string[][]): Set<string> {
  return new Set(paths.map((p) => boxKey(tree, p)));
}

const box = (l: NestedLayout, id: string) => l.boxes.find((b) => b.id === id)!;
const lanesOf = (l: NestedLayout, parentKey?: string) =>
  l.lanes.filter((x) => x.parentKey === parentKey);

/** app ─targets→ server ─mounts→ {api, admin}; api → admin. */
function fixture(): AppCanvasModel {
  const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", ["server"], ["Demo.Job"])] };
  const server = { ...node("server"), ports: [arrayPort("mounts", ["api", "admin"], ["Demo.Api"])] };
  return {
    appName: "app",
    nodes: [app, server, node("api", "Telo.Mount"), node("admin", "Telo.Mount")],
    edges: [
      edge("app", "server", "targets"),
      edge("server", "api", "mounts"),
      edge("server", "admin", "mounts"),
      edge("api", "admin", "handler"),
    ],
    stripItems: [],
  };
}

describe("the view root is not a frame", () => {
  it("draws no box for the focused node — it is always the outermost container", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: new Set() });

    expect(l.boxes.map((b) => b.id)).toEqual(["server"]);
    // Its lanes sit directly on the canvas instead.
    expect(lanesOf(l, undefined).map((x) => x.label)).toEqual(["targets"]);
    expect(box(l, "server").containerKey).toBe("");
  });

  it("roots the whole layout at the focus path", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: ["server"], expanded: new Set() });

    expect(l.boxes.map((b) => b.id).sort()).toEqual(["admin", "api"]);
    expect(lanesOf(l, undefined).map((x) => x.label)).toEqual(["mounts"]);
  });
});

describe("lanes as nodes", () => {
  it("parents a box to its lane and a lane to its container", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: open(tree, ["server"]) });

    const server = box(l, "server");
    const mounts = lanesOf(l, server.key);
    expect(mounts.map((x) => x.label)).toEqual(["mounts"]);
    expect(box(l, "api").laneKey).toBe(mounts[0].key);
    expect(box(l, "api").containerKey).toBe(server.key);
  });

  it("emits every parent before its children", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: open(tree, ["server"]) });

    const ordered = [
      ...l.lanes.map((x) => ({ order: x.order, id: x.key, parent: x.parentKey })),
      ...l.boxes.map((b) => ({ order: b.order, id: b.key, parent: b.laneKey })),
    ].sort((a, b) => a.order - b.order);

    const seen = new Set<string>();
    for (const n of ordered) {
      if (n.parent) expect(seen.has(n.parent)).toBe(true);
      seen.add(n.id);
    }
  });

  it("names the slot once per group and keeps declaration order, leftovers last", () => {
    const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", ["server"], [])] };
    const m: AppCanvasModel = {
      appName: "app",
      nodes: [app, node("server"), node("stray")],
      edges: [edge("app", "server", "targets")],
      stripItems: [],
    };
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: new Set() });

    const lanes = lanesOf(l, undefined);
    expect(lanes.map((x) => x.label)).toEqual(["targets", ""]);
    expect(lanes[0].y).toBeLessThan(lanes[1].y);
  });

  it("gives an addable slot a lane before it holds anything", () => {
    const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", [], ["Demo.Job"])] };
    const m: AppCanvasModel = { appName: "app", nodes: [app], edges: [], stripItems: [] };
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: new Set() });

    expect(lanesOf(l, undefined)[0]).toMatchObject({
      label: "targets",
      addPath: "targets[0]",
      createKinds: ["Demo.Job"],
      owner: { name: "app" },
    });
    expect(lanesOf(l, undefined)[0].height).toBeGreaterThan(0);
  });

  it("leaves the unreferenced group unaddable — it is not a slot", () => {
    const m: AppCanvasModel = {
      appName: "app",
      nodes: [node("app", "Telo.Application", true), node("stray")],
      edges: [],
      stripItems: [],
    };
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: new Set() });

    expect(lanesOf(l, undefined).map((x) => x.label)).toEqual([""]);
    expect(lanesOf(l, undefined)[0].addPath).toBeUndefined();
  });
});

describe("sizing", () => {
  it("grows a container around its interior, clear of the header", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const shut = layoutNested(tree, m, { focusPath: [], expanded: new Set() });
    const open2 = layoutNested(tree, m, { focusPath: [], expanded: open(tree, ["server"]) });

    expect(box(open2, "server").width).toBeGreaterThan(box(shut, "server").width);
    expect(lanesOf(open2, box(open2, "server").key)[0].y).toBeGreaterThanOrEqual(CONTAINER_HEADER);
  });
});

describe("links", () => {
  it("links boxes sharing a container and leaves containment to the nesting", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: open(tree, ["server"]) });

    const byKey = new Map(l.boxes.map((b) => [b.key, b] as const));
    const pairs = l.edges.map((e) => [byKey.get(e.sourceKey)!.id, byKey.get(e.targetKey)!.id]);
    expect(pairs).toContainEqual(["api", "admin"]);
    expect(pairs).not.toContainEqual(["server", "api"]);
  });
});

describe("hoisting", () => {
  /** Two sequences both invoking one shared helper. */
  function sharedModel(): AppCanvasModel {
    const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", ["a", "b"], [])] };
    return {
      appName: "app",
      nodes: [app, node("a"), node("b"), node("helper", "Telo.Invocable")],
      edges: [
        edge("app", "a", "targets"),
        edge("app", "b", "targets"),
        edge("a", "helper", "invoke"),
        edge("b", "helper", "invoke"),
      ],
      stripItems: [],
    };
  }

  it("diverts a child several containers reference, once, instead of drawing it in each", () => {
    const m = sharedModel();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, {
      focusPath: [],
      expanded: open(tree, [], ["a"], ["b"]),
      hoist: (c) => c.shared,
    });

    expect(l.boxes.map((b) => b.id).sort()).toEqual(["a", "b"]);
    // What was diverted is simply not drawn: this view cannot afford a box per
    // referrer, and the levels view draws it at each of them.
    expect(l.boxes.some((b) => b.id === "helper")).toBe(false);
  });

  it("stops offering the open control when every child was diverted", () => {
    const m = sharedModel();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: new Set(), hoist: (c) => c.shared });

    // `a` holds only the shared helper, so this view draws nothing inside it.
    expect(box(l, "a")).toMatchObject({ childCount: 0, openable: false });
  });

  it("keeps it when the view does not hoist", () => {
    const m = sharedModel();
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, { focusPath: [], expanded: open(tree, [], ["a"], ["b"]) });

    expect(l.boxes.filter((b) => b.id === "helper")).toHaveLength(2);
  });
});

describe("depth budget", () => {
  /** A chain deeper than any budget worth drawing. */
  function chainModel(depth: number): AppCanvasModel {
    const names = Array.from({ length: depth }, (_, i) => `n${i}`);
    const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", [names[0]], [])] };
    return {
      appName: "app",
      nodes: [app, ...names.map((n) => node(n))],
      edges: [
        edge("app", names[0], "targets"),
        ...names.slice(1).map((n, i) => edge(names[i], n, "next")),
      ],
      stripItems: [],
    };
  }

  it("marks a box at the budget as re-rooting instead of expanding in place", () => {
    const m = chainModel(6);
    const tree = buildContainmentTree(m);
    const all = expandableKeys(tree, { focusPath: [], maxDepth: 99 });
    const l = layoutNested(tree, m, { focusPath: [], expanded: all, maxDepth: 2 });

    // Depth 0 and 1 open as frames; depth 2 is the budget and re-roots.
    expect(box(l, "n0")).toMatchObject({ depth: 0, expanded: true, reroots: false });
    expect(box(l, "n1")).toMatchObject({ depth: 1, expanded: true, reroots: false });
    expect(box(l, "n2")).toMatchObject({ depth: 2, expanded: false, reroots: true, openable: true });
    // Nothing below the budget is drawn at all.
    expect(l.boxes.map((b) => b.id)).toEqual(["n0", "n1", "n2"]);
  });

  it("re-rooting there shows the same subtree with the budget spent again", () => {
    const m = chainModel(6);
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, {
      // The path the re-rooting box hands to `onFocusPath`.
      focusPath: ["n0", "n1", "n2"],
      expanded: expandableKeys(tree, { focusPath: ["n0", "n1", "n2"], maxDepth: 99 }),
      maxDepth: 2,
    });

    expect(l.boxes.map((b) => b.id)).toEqual(["n3", "n4", "n5"]);
  });

  it("never expands a cyclic occurrence, however the expansion set is seeded", () => {
    const app = { ...node("app", "Telo.Application", true), ports: [arrayPort("targets", ["a"], [])] };
    const m: AppCanvasModel = {
      appName: "app",
      nodes: [app, node("a"), node("b")],
      edges: [edge("app", "a", "targets"), edge("a", "b", "next"), edge("b", "a", "back")],
      stripItems: [],
    };
    const tree = buildContainmentTree(m);
    const l = layoutNested(tree, m, {
      focusPath: [],
      expanded: expandableKeys(tree, { focusPath: [], maxDepth: 99 }),
      maxDepth: 99,
    });

    const cyclic = l.boxes.filter((b) => b.cyclic);
    expect(cyclic.length).toBeGreaterThan(0);
    expect(cyclic.every((b) => !b.expanded && !b.openable)).toBe(true);
  });
});

describe("expandableKeys", () => {
  it("stops at the budget and skips what the view hoists", () => {
    const m = fixture();
    const tree = buildContainmentTree(m);

    expect(expandableKeys(tree, { focusPath: [], maxDepth: 0 })).toEqual(open(tree, []));
    expect(expandableKeys(tree, { focusPath: [], maxDepth: 1 })).toEqual(open(tree, [], ["server"]));
  });
});
