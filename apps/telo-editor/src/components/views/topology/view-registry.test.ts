import { describe, expect, it } from "vitest";
import type { TopologyViewContext } from "./topology-view";
import {
  candidateViews,
  consumedFields,
  resolveView,
  worthFocusing,
  TOPOLOGY_VIEWS,
} from "./view-registry";

/** A context with everything absent, so each case states only what it is about. */
function ctx(overrides: Partial<TopologyViewContext> = {}): TopologyViewContext {
  return {
    kind: null,
    hasSteps: false,
    hasEntries: false,
    isModuleRoot: false,
    hasInterior: false,
    ...overrides,
  };
}

describe("module-root views", () => {
  const root = ctx({ isModuleRoot: true, hasInterior: true });

  it("offers one containment view per SHAPE, not one per level renderer", () => {
    // The boot list is the top LEVEL of the levels view, not an alternative to
    // it: a list and a graph of the same root are not a choice a reader can
    // make, since only one of them can carry the boot order.
    expect(candidateViews(root).map((v) => v.id)).toEqual(["drill", "subflow"]);
    expect(resolveView(root, undefined)?.id).toBe("drill");
  });

  it("still honours the view the user picked", () => {
    expect(resolveView(root, "subflow")?.id).toBe("subflow");
  });

  it("falls back rather than rendering nothing for a view that no longer exists", () => {
    expect(resolveView(root, "boot")?.id).toBe("drill");
  });

  it("offers the containment views at the root even with nothing in it", () => {
    // An empty module still has to be somewhere you can add the first resource.
    expect(candidateViews(ctx({ isModuleRoot: true })).map((v) => v.id)).toEqual([
      "drill",
      "subflow",
    ]);
  });
});

describe("views at depth", () => {
  it("lands on the step list for a kind that carries a step body", () => {
    // The whole point of the focus resolving the view: descending onto a
    // sequence is asking for its steps. The generic level views stay behind it.
    const sequence = ctx({
      kind: { fullKind: "Run.Sequence" },
      hasSteps: true,
      hasInterior: true,
    });
    expect(resolveView(sequence, undefined)?.id).toBe("sequence");
    expect(candidateViews(sequence).map((v) => v.id)).toEqual([
      "sequence",
      "drill",
      "subflow",
      "form",
    ]);
  });

  it("offers the step list to ANY kind carrying a body, not only the ones that declared a topology", () => {
    // The step grammar is a shared manifest fragment, so a composer written
    // after it — a transaction, a durable workflow — carries a body without
    // declaring `topology: Sequence`. Keying on the declaration would have left
    // exactly those kinds with no view of the thing they run.
    const transaction = ctx({ kind: { fullKind: "Sql.Transaction" }, hasSteps: true });
    expect(candidateViews(transaction).map((v) => v.id)).toEqual(["sequence", "form"]);
  });

  it("does not offer it to a kind with no body, whatever its declared topology", () => {
    const router = ctx({ kind: { fullKind: "Http.Api", topology: "Router" } });
    expect(candidateViews(router).map((v) => v.id)).toEqual(["router", "form"]);
  });

  it("lists an ordered attachment list rather than drawing it as nodes", () => {
    // `Http.Server.mounts`: mount order is match order, and the containment
    // views draw each mount as a node with the order nowhere on screen. The
    // list wins the default; the graph views stay behind it.
    const server = ctx({
      kind: { fullKind: "Http.Server", capability: "Telo.Service" },
      hasEntries: true,
      hasInterior: true,
    });
    expect(candidateViews(server).map((v) => v.id)).toEqual([
      "entries",
      "drill",
      "subflow",
      "form",
    ]);
    expect(resolveView(server, undefined)?.id).toBe("entries");
  });

  it("does not draw an interior for a node that has none", () => {
    const leaf = ctx({ kind: { fullKind: "Sql.Query" } });
    expect(candidateViews(leaf).map((v) => v.id)).toEqual(["form"]);
    expect(resolveView(leaf, undefined)?.id).toBe("form");
  });
});

describe("what a view consumes", () => {
  const serverSchema = {
    properties: {
      port: { type: "integer" },
      mounts: {
        "x-telo-topology-role": "entries",
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { "x-telo-topology-role": "matcher", type: "string" },
            mount: { "x-telo-topology-role": "handler", "x-telo-ref": { kind: "Telo.Mount", use: "dependency" } },
          },
        },
      },
    },
  };

  const view = (id: string) => TOPOLOGY_VIEWS.find((v) => v.id === id) ?? null;

  it("names the one field the entry list draws, so the rail keeps the rest", () => {
    expect(consumedFields(view("entries"), serverSchema)).toEqual(["mounts"]);
  });

  it("names the step field for the step list", () => {
    const schema = { properties: { body: { "x-telo-topology-role": "steps" }, retry: {} } };
    expect(consumedFields(view("sequence"), schema)).toEqual(["body"]);
  });

  it("has the form view consume everything, which is what empties the rail", () => {
    expect(consumedFields(view("form"), serverSchema)).toEqual(["port", "mounts"]);
  });

  it("has the containment views consume nothing by name", () => {
    // They draw the reference graph rather than any particular field, so every
    // property stays reachable on the rail beside them.
    expect(consumedFields(view("drill"), serverSchema)).toEqual([]);
    expect(consumedFields(view("subflow"), serverSchema)).toEqual([]);
  });
});

describe("worth focusing", () => {
  it("is false for a leaf whose only view is the form the panel already shows", () => {
    expect(worthFocusing(ctx({ kind: { fullKind: "Sql.Query" } }))).toBe(false);
  });

  it("is true for a node with an interior, and for a kind that carries a body", () => {
    expect(worthFocusing(ctx({ kind: { fullKind: "Http.Server" }, hasInterior: true }))).toBe(true);
    // No children, but the kind runs a body of its own — which is exactly the
    // case the containment relation cannot see.
    expect(worthFocusing(ctx({ kind: { fullKind: "Run.Sequence" }, hasSteps: true }))).toBe(true);
  });
});
