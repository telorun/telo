import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import type { GraphNode } from "./application-canvas-model";
import { buildBootModel, readBootTarget } from "./boot-model";
import type { ContainmentTree } from "./containment";

const declared = new Set(["server", "worker", "db"]);

function node(name: string, isRoot = false): GraphNode {
  return { kind: "Http.Server", name, capability: "Telo.Service", ...(isRoot ? { isRoot } : {}) };
}

function ambient(name: string, capability: string): GraphNode {
  return { kind: `Demo.${name}`, name, capability };
}

function tree(nodes: GraphNode[], referrers: Record<string, number>): ContainmentTree {
  return {
    rootId: "app",
    childrenOf: new Map(),
    referrers: new Map(Object.entries(referrers)),
    nodeById: new Map(nodes.map((n) => [n.name, n])),
  };
}

describe("readBootTarget", () => {
  it("reads a !ref entry", () => {
    expect(readBootTarget(makeTaggedSentinel("ref", "server"), 0, declared)).toEqual({
      index: 0,
      form: "ref",
      name: "server",
      unresolved: false,
    });
  });

  it("reads a gated entry with its condition", () => {
    expect(
      readBootTarget(
        { ref: makeTaggedSentinel("ref", "worker"), when: makeTaggedSentinel("cel", "variables.x") },
        1,
        declared,
      ),
    ).toEqual({
      index: 1,
      form: "gated",
      name: "worker",
      when: "variables.x",
      unresolved: false,
    });
  });

  it("reads an inline invoke step, keeping the step's own name", () => {
    expect(
      readBootTarget(
        { name: "migrate", invoke: makeTaggedSentinel("ref", "db"), inputs: { to: 3 } },
        2,
        declared,
      ),
    ).toEqual({
      index: 2,
      form: "step",
      name: "db",
      stepName: "migrate",
      // Recorded whether or not a contract could be resolved: the arguments are
      // in the manifest either way, and a row that showed nothing would be
      // hiding them.
      inputKeys: ["to"],
      unresolved: false,
    });
  });

  it("reports an entry naming a resource the module does not declare", () => {
    expect(readBootTarget(makeTaggedSentinel("ref", "ghost"), 0, declared).unresolved).toBe(true);
  });

  it("does not mistake a !ref sentinel for an object-form entry", () => {
    // A sentinel IS a tagged object, so testing for `ref` / `invoke` keys first
    // would read every plain reference as some other shape.
    expect(readBootTarget(makeTaggedSentinel("ref", "server"), 0, declared).form).toBe("ref");
  });

  it("passes an unrecognised entry through rather than guessing at it", () => {
    expect(readBootTarget(42, 0, declared)).toEqual({ index: 0, form: "unknown", unresolved: false });
  });
});

describe("step signatures", () => {
  const signature = (name: string) =>
    name === "db"
      ? {
          input: { set: true, schema: { type: "object", properties: { to: { type: "integer" } } } },
          output: { set: true, name: "MigrationReport" },
        }
      : undefined;

  it("offers an inputs pointer and the result, for a step whose target declares them", () => {
    const t = readBootTarget(
      { name: "migrate", invoke: makeTaggedSentinel("ref", "db"), inputs: { to: 3 } },
      2,
      declared,
      signature,
    );
    expect(t.inputs).toEqual({
      pointer: "/targets/2/inputs",
      schema: { type: "object", properties: { to: { type: "integer" } } },
    });
    expect(t.inputKeys).toEqual(["to"]);
    expect(t.output).toEqual({ set: true, name: "MigrationReport" });
  });

  it("offers the pointer before anything is written there", () => {
    const t = readBootTarget({ invoke: makeTaggedSentinel("ref", "db") }, 0, declared, signature);
    expect(t.inputs?.pointer).toBe("/targets/0/inputs");
    expect(t.inputKeys).toBeUndefined();
  });

  it("offers nothing when the target declares no input contract", () => {
    // A freeform object here would fall through to the form's JSON-SCHEMA
    // editor, writing a declaration where arguments belong.
    const t = readBootTarget({ invoke: makeTaggedSentinel("ref", "server") }, 0, declared, signature);
    expect(t.inputs).toBeUndefined();
    expect(t.output).toBeUndefined();
  });

  it("records written arguments even when nothing can type them", () => {
    // The strip still shows them read-only; a row that rendered nothing would
    // be hiding what the manifest says.
    const t = readBootTarget(
      { invoke: makeTaggedSentinel("ref", "server"), inputs: { raw: 1 } },
      0,
      declared,
      signature,
    );
    expect(t.inputs).toBeUndefined();
    expect(t.inputKeys).toEqual(["raw"]);
  });

  it("never offers inputs on a bare or gated entry", () => {
    // Those are `run()`, which the invocation contract defines as parameterless
    // and void — there is nothing to pass and nothing to read back.
    expect(readBootTarget(makeTaggedSentinel("ref", "db"), 0, declared, signature).inputs).toBeUndefined();
    expect(
      readBootTarget({ ref: makeTaggedSentinel("ref", "db") }, 0, declared, signature).inputs,
    ).toBeUndefined();
  });
});

describe("buildBootModel", () => {
  it("keeps target order and index, including a repeated resource", () => {
    const model = buildBootModel(
      [
        makeTaggedSentinel("ref", "db"),
        makeTaggedSentinel("ref", "server"),
        makeTaggedSentinel("ref", "db"),
      ],
      [...declared],
      null,
    );
    // Indices are identity here: the tree folds both `db` edges into one link,
    // so a row numbered from it would edit the wrong entry.
    expect(model.targets.map((t) => [t.index, t.name])).toEqual([
      [0, "db"],
      [1, "server"],
      [2, "db"],
    ]);
  });

  it("lists only resources nothing references, and never the root", () => {
    const model = buildBootModel(
      [],
      [...declared],
      tree([node("app", true), node("server"), node("worker"), node("db")], {
        server: 1,
        worker: 0,
        db: 2,
      }),
    );
    expect(model.unreferenced.map((n) => n.name)).toEqual(["worker"]);
  });

  it("does not report a library's exported instances as unwired", () => {
    // Their referrers are importers, which are outside this module by
    // definition — so counting local references alone would flag exactly the
    // resources that are doing their job.
    const model = buildBootModel(
      [],
      [...declared],
      tree([node("app", true), node("server"), node("worker")], { server: 0, worker: 0 }),
      ["server", "Other.thing"],
    );
    expect(model.unreferenced.map((n) => n.name)).toEqual(["worker"]);
  });

  it("reports nothing unreferenced before the first analysis pass", () => {
    expect(buildBootModel([], [...declared], null).unreferenced).toEqual([]);
  });
});

describe("ambient grouping", () => {
  const groups = (nodes: GraphNode[]) =>
    buildBootModel([], [], null, [], nodes).ambient.map((g) => [
      g.capability,
      g.items.map((i) => i.name),
    ]);

  it("keeps providers and types apart, providers first", () => {
    // The canvas lumps them because neither is drawable; this view asks what
    // runs and what reaches what, where the two answer differently — so one
    // sentence cannot describe both without being false about one.
    expect(
      groups([
        ambient("Row", "Telo.Type"),
        ambient("connection", "Telo.Provider"),
        ambient("journal", "Telo.Provider"),
      ]),
    ).toEqual([
      ["Telo.Provider", ["connection", "journal"]],
      ["Telo.Type", ["Row"]],
    ]);
  });

  it("gives an unrecognised ambient capability its own group, after the known ones", () => {
    // Never folded into a known group: it would then be described by a hint
    // that is not about it, which is the whole reason the split exists.
    expect(groups([ambient("policy", "Telo.Policy"), ambient("cfg", "Telo.Provider")])).toEqual([
      ["Telo.Provider", ["cfg"]],
      ["Telo.Policy", ["policy"]],
    ]);
  });

  it("emits no group for a capability with nothing in it", () => {
    expect(groups([ambient("cfg", "Telo.Provider")])).toEqual([["Telo.Provider", ["cfg"]]]);
    expect(groups([])).toEqual([]);
  });
});
