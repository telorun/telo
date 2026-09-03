import type { GraphNode, GraphPort } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import {
  accepts,
  referenceableTargets,
  referenceName,
  siteOfHandle,
  siteRefs,
  spellingFor,
} from "./wire";
import { handleId } from "./graph-nodes";

const port = (over: Partial<GraphPort> = {}): GraphPort => ({
  slot: "mounts[].mount",
  refs: ["telo.Mount"],
  capabilities: ["Telo.Mount"],
  array: true,
  class: "holds",
  slots: [{ path: "mounts[0].mount", target: "api" }],
  addPath: "mounts[1].mount",
  ...over,
});

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: "id",
  kind: "http.Server",
  name: "server",
  ownership: "named",
  ports: [port()],
  rows: [],
  rowArrays: [],
  ...over,
});

const resolver = (accepted?: Set<string>) => ({
  acceptedKindsForRef: () => accepted,
  resolveKind: (kind: string) => kind,
});

describe("which slot a drag started from", () => {
  it("finds an existing occupancy by its handle", () => {
    const site = siteOfHandle(node(), handleId("mounts[0].mount"));
    expect(site?.spellings[0].concretePath).toBe("mounts[0].mount");
    expect(site?.anchor).toBe("mounts[0].mount");
  });

  it("finds the append slot, which is how a new item is added", () => {
    const site = siteOfHandle(node(), handleId("mounts[1].mount"));
    expect(site?.spellings[0].concretePath).toBe("mounts[1].mount");
  });

  it("is null for a handle that belongs to no port", () => {
    expect(siteOfHandle(node(), handleId("elsewhere"))).toBeNull();
  });
});

describe("a row-owned port answers through its rows", () => {
  /** A boot target: the `targets[]` port is row-owned, so it draws no socket and
   *  no `+` — both belong to the row, which is the only thing that knows the
   *  entry's other spellings. */
  const app = node({
    kind: "Telo.Application",
    name: "Report",
    ports: [
      port({
        slot: "targets[]",
        refs: ["Telo.Runnable", "Telo.Service"],
        slots: [{ path: "targets[0]" }],
        addPath: "targets[1]",
        rowOwned: true,
        class: "flow",
      }),
    ],
    rows: [
      {
        id: "t0",
        kind: "target",
        path: "targets[0]",
        array: "targets",
        index: 0,
        depth: 0,
        dispatch: {
          path: "targets[0]",
          refs: ["Telo.Runnable", "Telo.Service"],
          alternatives: [{ path: "targets[0].invoke", refs: ["Telo.Executable"] }],
        },
      },
    ],
  } as Partial<GraphNode>);

  it("resolves the ROW, keeping the spellings the port cannot carry", () => {
    const site = siteOfHandle(app, handleId("targets[0]"));
    expect(site?.spellings.map((s) => s.concretePath)).toEqual([
      "targets[0]",
      "targets[0].invoke",
    ]);
  });

  it("resolves a `+` that names the row by its DISPATCH path", () => {
    // A route's `+` reports `routes[0].handler` while its drag handle is
    // `routes[0]`; both designate the one site.
    const api = node({
      ports: [],
      rows: [
        {
          id: "r0",
          kind: "entry",
          path: "routes[0]",
          array: "routes",
          index: 0,
          depth: 0,
          dispatch: { path: "routes[0].handler", refs: ["telo.Executable"] },
        },
      ],
    } as Partial<GraphNode>);
    expect(siteOfHandle(api, handleId("routes[0].handler"))?.anchor).toBe("routes[0]");
  });
});

describe("whether a drop is legal", () => {
  it("accepts a kind the constraint expands to", () => {
    const api = node({ kind: "http.Api", name: "api" });
    expect(accepts(port(), api, resolver(new Set(["http.Api"])))).toBe(true);
  });

  it("refuses one it does not", () => {
    const db = node({ kind: "sql.Connection", name: "db" });
    expect(accepts(port(), db, resolver(new Set(["http.Api"])))).toBe(false);
  });

  it("joins on the kind the PROJECTION resolved, not on the spelling written", () => {
    // A library declares its own instances as `kind: Self.WriteLine`, and `Self`
    // means that library. Resolving it here reads it in the ENTRY module's
    // scope, where `Self` is a different module — so every instance an imported
    // library declares of its own kinds was refused by every slot, silently,
    // because the two names simply never matched.
    const writeLine = node({
      kind: "Self.WriteLine",
      canonicalKind: "console.WriteLine",
      name: "writeLine",
      external: true,
      alias: "Console",
    } as Partial<GraphNode>);
    const slot = { refs: ["telo.Executable"] };
    expect(accepts(slot, writeLine, resolver(new Set(["console.WriteLine"])))).toBe(true);
  });

  it("allows the drop when the constraint cannot be resolved at all", () => {
    // An unresolved import must not make every slot refuse every drop — that
    // reads as a broken editor rather than as an unresolved import.
    const anything = node({ kind: "who.Knows", name: "x" });
    expect(accepts(port(), anything, resolver(undefined))).toBe(true);
  });
});

describe("the name a reference is written with", () => {
  it("qualifies one that crosses an import boundary", () => {
    expect(referenceName(node({ external: true, alias: "Redirect", name: "routes" }))).toBe(
      "Redirect.routes",
    );
  });

  it("leaves a local one bare", () => {
    expect(referenceName(node({ name: "server" }))).toBe("server");
  });
});

describe("a ROW is a site too", () => {
  /** A sequence: its `invoke:` is declared on the step item schema, which sits
   *  behind a local `$ref` the reference field map never descends — so there is
   *  no port for it and the row carries the site. */
  const sequence = node({
    kind: "run.Sequence",
    name: "seq",
    ports: [],
    rows: [
      {
        id: "seq#step:one",
        kind: "step",
        name: "one",
        path: "steps[0]",
        array: "steps",
        index: 0,
        depth: 0,
        dispatch: { path: "steps[0].invoke", refs: ["telo.Executable"] },
      },
      {
        id: "seq#step:two",
        kind: "step",
        name: "two",
        path: "steps[1]",
        array: "steps",
        index: 1,
        depth: 0,
        // Declared by the grammar, written by nobody yet.
        dispatch: { path: "steps[1].invoke", refs: ["telo.Executable"] },
      },
    ],
  } as Partial<GraphNode>);

  it("resolves a step row's handle, which used to match nothing", () => {
    // Edges left these rows and no drag could be STARTED from one: every
    // attempt was refused because the handle designated no slot.
    const site = siteOfHandle(sequence, handleId("steps[0]"));
    expect(site?.spellings[0].concretePath).toBe("steps[0].invoke");
    expect(site?.spellings[0].refs).toEqual(["telo.Executable"]);
  });

  it("resolves a row whose dispatch is empty — that is the row worth offering at", () => {
    expect(siteOfHandle(sequence, handleId("steps[1]"))?.spellings[0].concretePath).toBe(
      "steps[1].invoke",
    );
  });

  it("refuses a row the grammar gives no dispatch at all", () => {
    const valueOnly = node({
      ports: [],
      rows: [
        { id: "r", kind: "step", path: "steps[0]", array: "steps", index: 0, depth: 0 },
      ],
    } as Partial<GraphNode>);
    expect(siteOfHandle(valueOnly, handleId("steps[0]"))).toBeNull();
  });

  it("prefers a PORT over a row when both could match, since a port is the slot", () => {
    const both = node({
      rows: [
        {
          id: "r",
          kind: "entry",
          path: "mounts[0].mount",
          array: "mounts",
          index: 0,
          depth: 0,
          dispatch: { path: "elsewhere", refs: [] },
        },
      ],
    });
    expect(siteOfHandle(both, handleId("mounts[0].mount"))?.spellings[0].concretePath).toBe(
      "mounts[0].mount",
    );
  });
});

describe("what a slot may be pointed at", () => {
  const nodes = [
    node({ id: "app", name: "app", root: true, ownership: "root" }),
    node({ id: "api", kind: "http.Api", name: "api" }),
    node({ id: "db", kind: "sql.Connection", name: "db" }),
    node({
      id: "Console.writeLine",
      kind: "console.WriteLine",
      name: "writeLine",
      external: true,
      alias: "Console",
    }),
    node({ id: "inline", kind: "http.Api", name: "inline", ownership: "inline", owner: "api" }),
  ];

  it("offers an imported instance — the one thing a drag can no longer reach", () => {
    const slot = { refs: ["telo.Executable"] };
    const offered = referenceableTargets(slot, nodes, resolver(new Set(["console.WriteLine"])));
    expect(offered.map(referenceName)).toEqual(["Console.writeLine"]);
  });

  it("offers what ANY spelling of the site accepts, not only the primary", () => {
    // A boot target: the bare entry takes a Runnable, its `invoke:` takes any
    // Executable. Reading the primary alone is what left an Invocable
    // unofferable at a site the manifest plainly admits it at.
    const site = {
      source: nodes[0],
      anchor: "targets[0]",
      spellings: [
        { concretePath: "targets[0]", refs: ["Telo.Runnable"] },
        { concretePath: "targets[0].invoke", refs: ["Telo.Executable"] },
      ],
    };
    const byRef = {
      resolveKind: (kind: string) => kind,
      acceptedKindsForRef: (ref: string) =>
        ref === "Telo.Runnable" ? new Set(["run.Sequence"]) : new Set(["console.WriteLine"]),
    };
    expect(referenceableTargets(site, nodes, byRef).map(referenceName)).toEqual([
      "Console.writeLine",
    ]);
    expect(spellingFor(site, { kind: "console.WriteLine" }, byRef)?.concretePath).toBe(
      "targets[0].invoke",
    );
    expect(siteRefs(site)).toEqual(["Telo.Runnable", "Telo.Executable"]);
  });

  it("keeps the slot's own constraint, so the dialog and the drag agree", () => {
    const offered = referenceableTargets(port(), nodes, resolver(new Set(["http.Api"])));
    expect(offered.map((n) => n.id)).toEqual(["api"]);
  });

  it("never offers the root or an owned declaration, which have no name to write", () => {
    const offered = referenceableTargets({ refs: [] }, nodes, resolver(undefined));
    expect(offered.map((n) => n.id)).not.toContain("app");
    expect(offered.map((n) => n.id)).not.toContain("inline");
  });
});
