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
    ...overrides,
  };
}

describe("views at depth", () => {
  it("lands on the step list for a kind that carries a step body", () => {
    // The whole point of the focus resolving the view: descending onto a
    // sequence is asking for its steps. The generic level views stay behind it.
    const sequence = ctx({
      kind: { fullKind: "Run.Sequence" },
      hasSteps: true,
    });
    expect(resolveView(sequence, undefined)?.id).toBe("sequence");
    expect(candidateViews(sequence).map((v) => v.id)).toEqual(["sequence", "form"]);
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
    // `Http.Server.mounts`: mount order is match order, and a picture of nodes
    // puts the order nowhere on screen. The list wins the default; the module
    // graph stays behind it.
    const server = ctx({
      kind: { fullKind: "Http.Server", capability: "Telo.Service" },
      hasEntries: true,
    });
    expect(candidateViews(server).map((v) => v.id)).toEqual(["entries", "form"]);
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

  it("consumes nothing for a view that declares nothing", () => {
    expect(consumedFields(null, serverSchema)).toEqual([]);
  });
});

describe("worth focusing", () => {
  it("is false for a leaf whose only view is the form the panel already shows", () => {
    expect(worthFocusing(ctx({ kind: { fullKind: "Sql.Query" } }))).toBe(false);
  });

  it("is true for a kind that declares a canvas of its own", () => {
    // Focusing is worth it when the kind has something the panel's field form
    // does not already show: a body it runs, or an ordered list it dispatches
    // through. A plain resource has neither — the module graph already draws it
    // and its references, so descending onto it would cost the reader their
    // place for nothing.
    expect(worthFocusing(ctx({ kind: { fullKind: "Run.Sequence" }, hasSteps: true }))).toBe(true);
    expect(worthFocusing(ctx({ kind: { fullKind: "Http.Server" }, hasEntries: true }))).toBe(true);
    expect(worthFocusing(ctx({ kind: { fullKind: "Sql.Connection" } }))).toBe(false);
  });
});
