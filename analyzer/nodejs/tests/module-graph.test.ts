import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { buildCallGraph, resourceId } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { createResolveCtx, resolveThrowsUnion } from "../src/resolve-throws-union.js";
import { manifestFragmentRef, withSchemaFragments } from "../src/manifest-schemas.js";
import {
  buildModuleGraph,
  contentKey,
  edgeClassOf,
  isAmbientHold,
  isOrderedRow,
  isUnwired,
  type ModuleGraphDeps,
} from "../src/module-graph.js";

const connectionDef = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "sql" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: { file: { type: "string" } } },
};

const commandDef = {
  kind: "Telo.Definition",
  metadata: { name: "Command", module: "sql" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
    },
  },
};

const apiDef = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "http" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        "x-telo-topology-role": "entries",
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { "x-telo-topology-role": "matcher", type: "string" },
            method: { "x-telo-topology-role": "matcher", type: "string" },
            handler: {
              "x-telo-topology-role": "handler",
              "x-telo-ref": { kind: "telo.Executable", use: "trigger.inbound", inputs: "/inputs" },
            },
            inputs: { type: "object" },
          },
        },
      },
    },
  },
};

const serverDef = {
  kind: "Telo.Definition",
  metadata: { name: "Server", module: "http" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      mounts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            mount: { "x-telo-ref": { kind: "telo.Mount", use: "dependency" } },
          },
        },
      },
      notFoundHandler: {
        type: "object",
        properties: {
          invoke: { "x-telo-ref": { kind: "telo.Executable", use: "trigger.inbound" } },
        },
      },
    },
  },
};

/** The shared step grammar as fragment expansion leaves it: the `x-telo-fragment`
 *  stamp sits on the ITEMS, which is what marks the array as a step body. */
const stepItems = {
  "x-telo-fragment": "Step",
  type: "object",
  properties: {
    name: { type: "string" },
    invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" } },
    inputs: { type: "object" },
    then: { "x-telo-topology-role": "branch", type: "array" },
  },
};

const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: { "x-telo-topology-role": "steps", type: "array", items: stepItems },
    },
  },
};

const applicationDef = {
  kind: "Telo.Definition",
  metadata: { name: "Application", module: "Telo" },
  capability: "Telo.Template",
  schema: {
    type: "object",
    properties: {
      targets: {
        type: "array",
        items: { "x-telo-ref": { kind: ["Telo.Runnable", "Telo.Service"], use: "call" } },
      },
    },
  },
};

const DEFS = [connectionDef, commandDef, apiDef, serverDef, sequenceDef, applicationDef];

function ref(name: string, kind: string): Record<string, unknown> {
  return { kind, name };
}

/** A node by the name it was declared under. A resource name is module-scoped,
 *  so a node's id carries its module when the loader stamped one — a test that
 *  spelled the id by hand would be asserting the id scheme rather than the
 *  behaviour under test. */
function named(graph: ReturnType<typeof fixture>, name: string) {
  return graph.nodes.find((n) => n.name === name)!;
}

/** Registry + deps over a fixed definition set — the projection takes a
 *  structural contract, so a test needs no AnalysisRegistry. */
function fixture(manifests: ResourceManifest[], root?: ResourceManifest) {
  return fixtureWith([], manifests, root);
}

/** As `fixture`, with extra kind definitions for the case under test. */
function fixtureWith(
  extraDefs: unknown[],
  manifests: ResourceManifest[],
  root?: ResourceManifest,
) {
  const defs = [...DEFS, ...(extraDefs as typeof DEFS)];
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);

  const byKind = new Map(
    defs.map((d) => [`${(d.metadata as { module: string }).module}.${d.metadata.name}`, d]),
  );
  const deps: ModuleGraphDeps = {
    // Module-scoped, as `AnalysisRegistry.resolveDefinitionIn` is: a kind is
    // written in its DECLARING module's alias scope, and `Self` there means that
    // module. Resolving canonically alone is what a flattened application does
    // to a library's own `kind: Self.<Kind>` — nothing.
    definition: (kind, module) =>
      (byKind.get(kind) ??
        (module && kind.startsWith("Self.")
          ? byKind.get(`${module}.${kind.slice("Self.".length)}`)
          : undefined)) as never,
    aliasesForModule: (module) => (module === "database" ? ["Database"] : []),
    throwsOf: (resource) => {
      const union = resolveThrowsUnion(resource, throwsCtx);
      return { codes: [...union.codes.keys()], unbounded: union.unbounded };
    },
    refFields: (resource) => {
      const map = registry.getFieldMap(resource.kind as string);
      if (!map) return [];
      const out = [];
      for (const [path, entry] of map) {
        if (!("refs" in entry)) continue;
        const refs = (entry as { refs: string[] }).refs;
        out.push({
          path,
          isArray: (entry as { isArray: boolean }).isArray,
          refs,
          capabilities: refs.map(
            (r) => (byKind.get(r) as { capability?: string } | undefined)?.capability ?? r,
          ),
        });
      }
      return out;
    },
  };

  // The module doc is IN the manifest list, as `flattenForAnalyzer` leaves it:
  // the call graph walks it like any other resource, which is what makes a boot
  // target an ordinary edge. Passing it only as `options.root` made the fixture
  // disagree with the real pipeline about whether those edges exist at all.
  const all = root ? [...manifests, root] : manifests;
  const callGraph = buildCallGraph(all, registry);
  const entryModule = (root?.metadata?.name as string | undefined) ?? "app";
  const throwsCtx = createResolveCtx(all, registry, new AliasResolver(), new Map(), new Set([entryModule]));
  return buildModuleGraph(all, callGraph, deps, {
    ...(root ? { root } : {}),
    entryModule,
  });
}

describe("edge classes", () => {
  it("reduces six uses to three drawing classes", () => {
    expect(edgeClassOf(["call"])).toBe("flow");
    expect(edgeClassOf(["detached"])).toBe("flow");
    expect(edgeClassOf(["trigger.inbound"])).toBe("flow");
    expect(edgeClassOf(["trigger.consumer"])).toBe("flow");
    expect(edgeClassOf(["dependency"])).toBe("holds");
    expect(edgeClassOf(["schema"])).toBe("shape");
  });

  it("reads a slot that both calls and detaches as flow", () => {
    expect(edgeClassOf(["call", "detached"])).toBe("flow");
  });

  it("reads an undeclared use as flow — the conservative direction", () => {
    expect(edgeClassOf([])).toBe("flow");
  });
});

describe("ports", () => {
  it("declares a port for an EMPTY slot", () => {
    const graph = fixture([
      { kind: "http.Server", metadata: { name: "server" }, mounts: [] } as never,
    ]);
    const server = graph.nodeById(resourceId("http.Server", "server"))!;
    const port = server.ports.find((p) => p.slot === "notFoundHandler.invoke");
    expect(port).toBeDefined();
    expect(port!.slots.filter((s) => s.target)).toHaveLength(0);
  });

  it("keeps two slots of one kind apart, with their own classes", () => {
    const graph = fixture([
      {
        kind: "http.Server",
        metadata: { name: "server" },
        mounts: [{ path: "/", mount: ref("api", "http.Api") }],
        notFoundHandler: { invoke: ref("fallback", "run.Sequence") },
      } as never,
      { kind: "http.Api", metadata: { name: "api" }, routes: [] } as never,
      { kind: "run.Sequence", metadata: { name: "fallback" }, steps: [] } as never,
    ]);
    const server = graph.nodeById(resourceId("http.Server", "server"))!;
    expect(server.ports.find((p) => p.slot === "mounts[].mount")!.class).toBe("holds");
    expect(server.ports.find((p) => p.slot === "notFoundHandler.invoke")!.class).toBe("flow");
  });

  it("records the concrete write path of each occupancy plus the append path", () => {
    const graph = fixture([
      {
        kind: "http.Server",
        metadata: { name: "server" },
        mounts: [{ path: "/", mount: ref("api", "http.Api") }],
      } as never,
      { kind: "http.Api", metadata: { name: "api" }, routes: [] } as never,
    ]);
    const port = graph
      .nodeById(resourceId("http.Server", "server"))!
      .ports.find((p) => p.slot === "mounts[].mount")!;
    expect(port.slots[0]).toMatchObject({ path: "mounts[0].mount", target: "api" });
  });
});

describe("rows", () => {
  it("names a step row after the step, not its index", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [{ name: "first", invoke: ref("cmd", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const rows = graph.nodeById(resourceId("run.Sequence", "seq"))!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toContain("#step:first");
    expect(rows[0].name).toBe("first");
  });

  it("keeps a step's identity when a sibling is inserted above it", () => {
    const before = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [{ name: "second", invoke: ref("cmd", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const after = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [
          { name: "first", invoke: ref("cmd", "sql.Command") },
          { name: "second", invoke: ref("cmd", "sql.Command") },
        ],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const id = (g: typeof before) =>
      g.nodeById(resourceId("run.Sequence", "seq"))!.rows.find((r) => r.name === "second")!.id;
    expect(id(after)).toBe(id(before));
    // …and the path still points at where it actually is now.
    expect(
      after.nodeById(resourceId("run.Sequence", "seq"))!.rows.find((r) => r.name === "second")!.path,
    ).toBe("steps[1]");
  });

  it("nests a branch step under its parent row, with depth", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [
          { name: "outer", then: [{ name: "inner", invoke: ref("cmd", "sql.Command") }] },
        ],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const rows = graph.nodeById(resourceId("run.Sequence", "seq"))!.rows;
    const inner = rows.find((r) => r.name === "inner")!;
    const outer = rows.find((r) => r.name === "outer")!;
    expect(inner.parent).toBe(outer.id);
    expect(inner.depth).toBe(1);
    expect(inner.id.startsWith(outer.id)).toBe(true);
  });

  it("identifies an entry row by what matches, not by position", () => {
    const routes = (extra: boolean) => [
      ...(extra ? [{ path: "/added", method: "GET", handler: ref("seq", "run.Sequence") }] : []),
      { path: "/orders", method: "POST", handler: ref("seq", "run.Sequence") },
    ];
    const build = (extra: boolean) =>
      fixture([
        { kind: "http.Api", metadata: { name: "api" }, routes: routes(extra) } as never,
        { kind: "run.Sequence", metadata: { name: "seq" }, steps: [] } as never,
      ]);
    const orders = (extra: boolean) =>
      build(extra)
        .nodeById(resourceId("http.Api", "api"))!
        .rows.find((r) => (r.match as { path: string }).path === "/orders")!;
    expect(orders(true).id).toBe(orders(false).id);
    expect(orders(true).index).toBe(1);
    expect(orders(true).target).toBe("seq");
  });

  it("makes the root's targets ordered rows", () => {
    const graph = fixture(
      [{ kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never],
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [ref("migrate", "run.Sequence")],
      } as never,
    );
    expect(graph.root!.rows).toMatchObject([{ kind: "target", index: 0, target: "migrate" }]);
  });
});

describe("edges", () => {
  it("attributes a step's edge to the resource whose body declares it, naming the row", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [{ name: "run", invoke: ref("cmd", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const seqId = resourceId("run.Sequence", "seq");
    const edge = graph.edgesFrom(seqId).find((e) => e.toName === "cmd")!;
    expect(edge.from).toBe(seqId);
    expect(edge.row).toBe(graph.nodeById(seqId)!.rows[0].id);
    expect(edge.class).toBe("flow");
    expect(edge.inputs).toBe("/inputs");
  });

  it("emits boot edges from the root, flagged and ordered", () => {
    const graph = fixture(
      [
        { kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never,
        { kind: "http.Server", metadata: { name: "server" }, mounts: [] } as never,
      ],
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [ref("migrate", "run.Sequence"), ref("server", "http.Server")],
      } as never,
    );
    const boot = graph.edgesFrom(graph.root!.id);
    expect(boot.map((e) => e.toName)).toEqual(["migrate", "server"]);
    expect(boot.every((e) => e.boot && e.class === "flow")).toBe(true);
    expect(boot[0].to).toBe(resourceId("run.Sequence", "migrate"));
  });

  it("keeps an edge whose target resolves to nothing", () => {
    const graph = fixture([
      {
        kind: "sql.Command",
        metadata: { name: "cmd" },
        connection: ref("missing", "sql.Connection"),
      } as never,
    ]);
    const edge = graph.edgesFrom(resourceId("sql.Command", "cmd"))[0];
    expect(edge.toName).toBe("missing");
    expect(edge.to).toBeUndefined();
  });

  it("collapses a hold on infrastructure, and only that", () => {
    const graph = fixture([
      {
        kind: "http.Server",
        metadata: { name: "server" },
        mounts: [{ path: "/", mount: ref("api", "http.Api") }],
      } as never,
      { kind: "http.Api", metadata: { name: "api" }, routes: [] } as never,
      {
        kind: "sql.Command",
        metadata: { name: "cmd" },
        connection: ref("db", "sql.Connection"),
      } as never,
      { kind: "sql.Connection", metadata: { name: "db" } } as never,
    ]);
    const mount = graph.edgesFrom(resourceId("http.Server", "server"))[0];
    const connection = graph.edgesFrom(resourceId("sql.Command", "cmd"))[0];
    expect(mount.class).toBe("holds");
    expect(connection.class).toBe("holds");
    // The server→mount spine stays drawn; the connection fan-in collapses.
    expect(isAmbientHold(mount, graph)).toBe(false);
    expect(isAmbientHold(connection, graph)).toBe(true);
  });
});

describe("a declaration written at a dispatch site", () => {
  /** `invoke: { kind: sql.Command, connection: !ref chatDb }` — a resource the
   *  manifest genuinely declares, which the graph used to see nothing of. */
  const inlineFixture = () =>
    fixture([
      { kind: "sql.Connection", metadata: { name: "chatDb" } } as never,
      {
        kind: "run.Sequence",
        metadata: { name: "main" },
        steps: [
          {
            name: "write",
            invoke: {
              kind: "sql.Command",
              connection: { kind: "sql.Connection", name: "chatDb" },
            },
          },
        ],
      } as never,
    ]);

  const seqRows = (graph: ReturnType<typeof fixture>) =>
    graph.nodeById(resourceId("run.Sequence", "main"))!.rows;

  it("hangs a row for the declaration under the step that declares it", () => {
    const rows = seqRows(inlineFixture());
    expect(rows.map((r) => [r.kind, r.declares ?? r.name, r.depth])).toEqual([
      ["step", "write", 0],
      ["inline", "sql.Command", 1],
      ["reference", "connection", 2],
    ]);
    expect(rows[1].parent).toBe(rows[0].id);
    expect(rows[2].parent).toBe(rows[1].id);
  });

  it("addresses each row at the site, so an edit lands where it was written", () => {
    const rows = seqRows(inlineFixture());
    expect(rows[1].path).toBe("steps[0].invoke");
    expect(rows[2].path).toBe("steps[0].invoke.connection");
  });

  it("puts the hold back on the graph — it was invisible, so its target read as unreferenced", () => {
    const graph = inlineFixture();
    const db = graph.nodeById(resourceId("sql.Connection", "chatDb"))!;
    expect(graph.edgesTo(db.id).map((e) => [e.class, e.path])).toEqual([
      ["holds", "steps[0].invoke.connection"],
    ]);
    expect(isUnwired(db, graph)).toBe(false);
  });

  it("attributes the edge to the reference row, and its branch to the host's property", () => {
    const graph = inlineFixture();
    const [edge] = graph.edgesTo(resourceId("sql.Connection", "chatDb"));
    const rows = seqRows(graph);
    expect(edge.row).toBe(rows[2].id);
    // `steps[].invoke.connection` — the branch a view collapses is `steps`.
    expect(edge.slot.startsWith("steps[]")).toBe(true);
  });

  it("emits ONE site where both walks reach it", () => {
    // A step's `invoke:` is a step dispatch slot AND a row-owned port slot.
    const rows = seqRows(inlineFixture());
    expect(rows.filter((r) => r.kind === "inline")).toHaveLength(1);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("nests a declaration written inside another one", () => {
    const viewDef = {
      kind: "Telo.Definition",
      metadata: { name: "View", module: "cache" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" } } },
      },
    };
    const graph = fixtureWith([viewDef], [
      { kind: "sql.Connection", metadata: { name: "chatDb" } } as never,
      {
        kind: "run.Sequence",
        metadata: { name: "main" },
        steps: [
          {
            name: "cached",
            invoke: {
              kind: "cache.View",
              invoke: {
                kind: "sql.Command",
                connection: { kind: "sql.Connection", name: "chatDb" },
              },
            },
          },
        ],
      } as never,
    ] as never);
    expect(seqRows(graph).map((r) => [r.kind, r.declares ?? r.name, r.depth])).toEqual([
      ["step", "cached", 0],
      ["inline", "cache.View", 1],
      ["inline", "sql.Command", 2],
      ["reference", "connection", 3],
    ]);
  });

  it("marks a declaration whose kind resolves to nothing rather than dropping it", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "main" },
        steps: [{ name: "x", invoke: { kind: "Nope.Thing", a: 1 } }],
      } as never,
    ]);
    expect(seqRows(graph)[1]).toMatchObject({ kind: "inline", declares: "Nope.Thing", unknownKind: true });
  });

  it("says which rows are ordered entries — a declaration is not one", () => {
    const rows = seqRows(inlineFixture());
    expect(rows.map(isOrderedRow)).toEqual([true, false, false]);
  });
});

describe("where a row's call is written", () => {
  const graph = () =>
    fixture(
      [
        { kind: "sql.Command", metadata: { name: "q" } } as never,
        {
          kind: "http.Api",
          metadata: { name: "api" },
          routes: [
            { path: "/a", method: "GET", handler: { kind: "sql.Command", name: "q" } },
            { path: "/b", method: "GET" },
          ],
        } as never,
        {
          kind: "run.Sequence",
          metadata: { name: "seq" },
          steps: [{ name: "one", invoke: { kind: "sql.Command", name: "q" } }, { name: "two" }],
        } as never,
      ],
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [{ kind: "run.Sequence", name: "seq" }],
      } as never,
    );

  const rowsOf = (name: string, kind: string) =>
    graph().nodeById(resourceId(kind, name))!.rows;

  it("marks a dispatch already occupied by a declaration written at the site", () => {
    // Nothing can be wired into one without destroying what is written there,
    // and it is the one thing that can be given a name of its own. A REFERENCE
    // is not one — `{kind, name}` names a resource declared elsewhere.
    const occupied = fixture([
      { kind: "sql.Command", metadata: { name: "q" } } as never,
      {
        kind: "http.Api",
        metadata: { name: "api" },
        routes: [
          { path: "/a", method: "GET", handler: { kind: "sql.Command" } },
          { path: "/b", method: "GET", handler: { kind: "sql.Command", name: "q" } },
        ],
      } as never,
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [
          { name: "declared", invoke: { kind: "sql.Command" } },
          { name: "referenced", invoke: { kind: "sql.Command", name: "q" } },
          { name: "empty" },
        ],
      } as never,
    ]);
    const steps = occupied
      .nodeById(resourceId("run.Sequence", "seq"))!
      .rows.filter((r) => r.kind === "step");
    expect(steps.map((r) => [r.name, r.dispatch?.inline])).toEqual([
      ["declared", true],
      ["referenced", undefined],
      ["empty", undefined],
    ]);
    const routes = occupied
      .nodeById(resourceId("http.Api", "api"))!
      .rows.filter((r) => r.kind === "entry");
    expect(routes.map((r) => r.dispatch?.inline)).toEqual([true, undefined]);
  });

  it("addresses a step's dispatch even when nothing fills it yet", () => {
    // The step item schema sits behind a local `$ref` the field map never
    // descends, so a sequence has no port for `invoke:` — the row is the only
    // thing that can carry the site.
    const rows = rowsOf("seq", "run.Sequence").filter((r) => r.kind === "step");
    expect(rows.map((r) => r.dispatch?.path)).toEqual(["steps[0].invoke", "steps[1].invoke"]);
    expect(rows[0].dispatch?.refs).toEqual(["telo.Executable"]);
  });

  it("addresses an ENTRY's handler on the entry that has none", () => {
    const rows = rowsOf("api", "http.Api");
    expect(rows.map((r) => r.dispatch?.path)).toEqual(["routes[0].handler", "routes[1].handler"]);
  });

  it("makes a boot target its own site", () => {
    const [row] = graph().root!.rows;
    expect(row.dispatch).toEqual({
      path: "targets[0]",
      refs: ["Telo.Runnable", "Telo.Service"],
    });
  });

  it("reports a boot target's invoke: site beside its bare reference", () => {
    // The REAL `Telo.Application`, whose `targets` entry is a union: a bare
    // `!ref` to a Runnable/Service, and an invoke step taking any Executable.
    // Reporting only the first left every Invocable in an application
    // unbootable from an editor — legal in the manifest, offered nowhere.
    const writeLine = {
      kind: "Telo.Definition",
      metadata: { name: "WriteLine", module: "console" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: {} },
    };
    const registry = new DefinitionRegistry();
    registry.register(writeLine as never);
    const root = {
      kind: "Telo.Application",
      metadata: { name: "Report" },
      targets: [{}],
    } as unknown as ResourceManifest;
    const all = [root];
    const callGraph = buildCallGraph(all, registry);
    const throwsCtx = createResolveCtx(
      all,
      registry,
      new AliasResolver(),
      new Map(),
      new Set(["Report"]),
    );
    const built = buildModuleGraph(
      all,
      callGraph,
      {
        definition: (kind) => (kind === "console.WriteLine" ? (writeLine as never) : undefined),
        aliasesForModule: () => [],
        throwsOf: (resource) => {
          const union = resolveThrowsUnion(resource, throwsCtx);
          return { codes: [...union.codes.keys()], unbounded: union.unbounded };
        },
        refFields: (resource) => {
          const map = registry.getFieldMap(resource.kind as string);
          if (!map) return [];
          const out = [];
          for (const [path, entry] of map) {
            if (!("refs" in entry)) continue;
            const refs = (entry as { refs: string[] }).refs;
            out.push({
              path,
              isArray: (entry as { isArray: boolean }).isArray,
              refs,
              capabilities: refs,
            });
          }
          return out;
        },
      },
      { root, entryModule: "Report" },
    );
    const [row] = built.root!.rows;
    expect(row.dispatch?.path).toBe("targets[0]");
    expect(row.dispatch?.refs).toEqual(["Telo.Runnable", "Telo.Service"]);
    // `targets[0].ref` accepts exactly what the bare form does, so it is the
    // same site under a second spelling and is not listed again.
    expect(row.dispatch?.alternatives).toEqual([
      { path: "targets[0].invoke", refs: ["Telo.Executable"] },
    ]);
  });

  it("gives a declaration row no dispatch — it IS what is dispatched to", () => {
    const rows = rowsOf("seq", "run.Sequence").filter((r) => r.kind !== "step");
    expect(rows.every((r) => r.dispatch === undefined)).toBe(true);
  });
});

describe("what a statement IS", () => {
  /** The REAL step grammar, expanded as the loader expands it — the whole point
   *  is that the variant comes from the schema's own branches. */
  const grammarSequence = {
    kind: "Telo.Definition",
    metadata: { name: "Sequence", module: "run" },
    capability: "Telo.Runnable",
    schema: withSchemaFragments({
      type: "object",
      properties: {
        steps: {
          "x-telo-topology-role": "steps",
          type: "array",
          items: { $ref: manifestFragmentRef("Step") },
        },
      },
    }),
  };

  /** A body with one of every control-flow shape, plus a guarded dispatch. */
  const body = () =>
    fixtureWith(
      [grammarSequence],
      [
        { kind: "sql.Command", metadata: { name: "q" } } as never,
        {
          kind: "run.Sequence",
          metadata: { name: "seq" },
          steps: [
            { name: "plain", invoke: { kind: "sql.Command", name: "q" } },
            { name: "guarded", invoke: { kind: "sql.Command", name: "q" }, when: "inputs.dry" },
            { name: "loop", while: "steps.plain.result != 'x'", do: [] },
            { name: "branch", if: "inputs.ok", then: [] },
            { name: "pick", switch: "inputs.mode", cases: {} },
            { name: "guard", try: [], catch: [] },
            { name: "raise", throw: { code: "ERR_X" } },
            { name: "pure", value: 1 },
            { name: "blank" },
          ],
        } as never,
      ] as never,
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [
          { kind: "run.Sequence", name: "seq" },
          { ref: { kind: "run.Sequence", name: "seq" }, when: "variables.migrate" },
        ],
      } as never,
    );

  const steps = () =>
    body()
      .nodeById(resourceId("run.Sequence", "seq"))!
      .rows.filter((r) => r.kind === "step");

  it("labels each step with the grammar branch's own title", () => {
    expect(steps().map((r) => [r.name, r.variantLabel])).toEqual([
      ["plain", "invoke"],
      ["guarded", "invoke"],
      ["loop", "while/do"],
      ["branch", "if/then/else"],
      ["pick", "switch/cases/default"],
      ["guard", "try/catch/finally"],
      ["raise", "throw"],
      ["pure", "value"],
      // A step just added, still empty, matches no branch — and saying nothing
      // is the honest answer, not a guess at what the author meant.
      ["blank", undefined],
    ]);
  });

  it("identifies the branch by its REQUIRED KEYS, which no author can reword", () => {
    // The title is prose. A consumer that branched on it — or sliced a keyword
    // out of it — would break the day someone wrote `title: Loop over items`.
    expect(steps().map((r) => [r.name, r.variant])).toEqual([
      ["plain", "invoke"],
      ["guarded", "invoke"],
      ["loop", "do+while"],
      ["branch", "if+then"],
      ["pick", "cases+switch"],
      ["guard", "try"],
      ["raise", "throw"],
      ["pure", "value"],
      ["blank", undefined],
    ]);
  });

  it("carries the expression the statement turns on, whichever keyword spells it", () => {
    expect(steps().map((r) => [r.name, r.predicate])).toEqual([
      ["plain", undefined],
      // A dispatch's `when:` is the same fact a loop's condition is, found
      // through the annotation rather than by knowing the keyword.
      ["guarded", "inputs.dry"],
      ["loop", "steps.plain.result != 'x'"],
      ["branch", "inputs.ok"],
      ["pick", "inputs.mode"],
      ["guard", undefined],
      ["raise", undefined],
      ["pure", undefined],
      ["blank", undefined],
    ]);
  });

  it("carries a boot target's guard, so a conditional one does not read as always", () => {
    expect(body().root!.rows.map((r) => r.predicate)).toEqual([undefined, "variables.migrate"]);
  });
});

describe("nodes", () => {
  it("marks a resource whose kind resolves to nothing rather than dropping it", () => {
    const graph = fixture([
      { kind: "Unknown.Thing", metadata: { name: "mystery" } } as never,
    ]);
    const node = graph.nodeById(resourceId("Unknown.Thing", "mystery"))!;
    expect(node.unknownKind).toBe(true);
    expect(node.capability).toBeUndefined();
  });

  it("reads ownership off the declaration, not off a name pattern", () => {
    const graph = fixture([
      {
        kind: "sql.Command",
        metadata: {
          name: "seq_steps_0_invoke",
          xTeloOrigin: { parentKind: "run.Sequence", parentName: "seq", pathFromParent: "steps[0].invoke" },
        },
      } as never,
      { kind: "run.Sequence", metadata: { name: "seq" }, steps: [] } as never,
    ]);
    const inline = graph.nodeById(resourceId("sql.Command", "seq_steps_0_invoke"))!;
    expect(inline.ownership).toBe("inline");
    expect(inline.owner).toBe(resourceId("run.Sequence", "seq"));
    expect(graph.regions).toMatchObject([
      { kind: "inline", owner: resourceId("run.Sequence", "seq"), members: [inline.id] },
    ]);
  });

  it("resolves a kind written in ITS OWN module's alias scope", () => {
    // A library declares its own instances as `kind: Self.<Kind>`, and `Self`
    // means that library. Carried into a flattened application the spelling
    // survives and resolves to nothing there, so every consumer joining on a
    // kind — which slots accept it, which instances a kind has, what schema a
    // form uses — silently missed the whole library.
    const writeLineDef = {
      kind: "Telo.Definition",
      metadata: { name: "WriteLine", module: "console" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: {} },
    };
    const graph = fixtureWith(
      [writeLineDef],
      [
        writeLineDef as never,
        {
          kind: "Self.WriteLine",
          metadata: { name: "writeLine", module: "console", forwardedExport: true },
        } as never,
      ],
    );
    const node = named(graph, "writeLine");
    expect(node.kind).toBe("Self.WriteLine");
    expect(node.canonicalKind).toBe("console.WriteLine");
    expect(node.unknownKind).toBeUndefined();
    // And the kind plane joins on it, so the kind knows its own instances.
    expect(graph.kinds.find((k) => k.id === "console.WriteLine")?.instances).toEqual([node.id]);
  });

  it("leaves a kind already written canonically alone", () => {
    const graph = fixture([{ kind: "sql.Connection", metadata: { name: "db" } } as never]);
    expect(named(graph, "db").canonicalKind).toBeUndefined();
  });

  it("marks an instance declared outside the entry module as external", () => {
    const graph = fixture([
      {
        kind: "sql.Connection",
        metadata: { name: "db", module: "database", forwardedExport: true },
      } as never,
    ]);
    const node = named(graph, "db");
    expect(node.ownership).toBe("imported");
    expect(node.external).toBe(true);
  });
});

describe("content keys", () => {
  it("is stable across key order and distinct across values", () => {
    expect(contentKey({ a: 1, b: 2 })).toBe(contentKey({ b: 2, a: 1 }));
    expect(contentKey({ path: "/a" })).not.toBe(contentKey({ path: "/b" }));
  });
});

describe("regions", () => {
  /** A transaction whose `steps:` slot opens a zone, over the shared grammar. */
  const txDef = {
    kind: "Telo.Definition",
    metadata: { name: "Transaction", module: "sql" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      properties: {
        steps: {
          "x-telo-topology-role": "steps",
          "x-telo-provides-zone": { atomic: "effects are discarded together" },
          type: "array",
          items: stepItems,
        },
      },
    },
  };

  it("draws a zone as a region over what its body reaches, quoting the author", () => {
    const graph = fixtureWith([txDef], [
      {
        kind: "sql.Transaction",
        metadata: { name: "tx" },
        steps: [{ name: "debit", invoke: ref("cmd", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const zone = graph.regions.find((r) => r.kind === "zone")!;
    expect(zone.owner).toBe(resourceId("sql.Transaction", "tx"));
    expect(zone.site).toBe("steps");
    expect(zone.members).toContain(resourceId("sql.Command", "cmd"));
    expect(zone.attributes).toEqual({ atomic: "effects are discarded together" });
    // The provider is never inside the zone it opens.
    expect(zone.members).not.toContain(zone.owner);
  });

  it("finds a zone that declares no attributes at all", () => {
    const bare = {
      ...txDef,
      metadata: { name: "Bare", module: "sql" },
      schema: {
        type: "object",
        properties: {
          steps: {
            "x-telo-topology-role": "steps",
            "x-telo-provides-zone": true,
            type: "array",
            items: stepItems,
          },
        },
      },
    };
    const graph = fixtureWith([bare], [
      {
        kind: "sql.Bare",
        metadata: { name: "bare" },
        steps: [{ name: "s", invoke: ref("cmd", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    expect(graph.regions.filter((r) => r.kind === "zone")).toHaveLength(1);
  });
});

describe("data edges", () => {
  const configDef = {
    kind: "Telo.Definition",
    metadata: { name: "Config", module: "cfg" },
    capability: "Telo.Provider",
    schema: { type: "object", properties: {} },
  };
  const serviceDef = {
    kind: "Telo.Definition",
    metadata: { name: "Listener", module: "net" },
    capability: "Telo.Service",
    schema: {
      type: "object",
      properties: { port: { "x-telo-eval": "compile", type: "integer" } },
    },
  };

  it("draws a CEL read of another resource's state, naming what is read", () => {
    const graph = fixtureWith([configDef, serviceDef], [
      {
        kind: "net.Listener",
        metadata: { name: "listener" },
        port: "${{ resources.settings.status.port }}",
      } as never,
      { kind: "cfg.Config", metadata: { name: "settings" } } as never,
    ]);
    const edge = graph
      .edgesFrom(resourceId("net.Listener", "listener"))
      .find((e) => e.class === "data")!;
    expect(edge.to).toBe(resourceId("cfg.Config", "settings"));
    expect(edge.read).toBe("resources.settings.status.port");
  });

  it("reads a name inside a string literal as nothing — it parses, never scans", () => {
    const graph = fixtureWith([configDef, serviceDef], [
      {
        kind: "net.Listener",
        metadata: { name: "listener" },
        port: "${{ 'resources.settings.status.port' }}",
      } as never,
      { kind: "cfg.Config", metadata: { name: "settings" } } as never,
    ]);
    expect(graph.edges.filter((e) => e.class === "data")).toHaveLength(0);
  });

  it("states one read once, however many sites make it", () => {
    const graph = fixtureWith([configDef, serviceDef], [
      {
        kind: "net.Listener",
        metadata: { name: "listener" },
        port: "${{ resources.settings.status.port }}-${{ resources.settings.status.port }}",
      } as never,
      { kind: "cfg.Config", metadata: { name: "settings" } } as never,
    ]);
    expect(graph.edges.filter((e) => e.class === "data")).toHaveLength(1);
  });
});

describe("the kind plane", () => {
  const webhookDef = {
    kind: "Telo.Definition",
    metadata: { name: "Webhook", module: "notify" },
    capability: "Telo.Invocable",
    schema: { type: "object", properties: {} },
    resources: [{ kind: "http.Api", metadata: { name: "post" } }],
    invoke: { kind: "http.Api", name: "post" },
  };
  const slackDef = {
    kind: "Telo.Definition",
    metadata: { name: "Slack", module: "notify" },
    extends: "notify.Webhook",
    schema: { type: "object", properties: {} },
  };
  const modelAbstract = {
    kind: "Telo.Abstract",
    metadata: { name: "Model", module: "ai" },
    capability: "Telo.Provider",
    schema: { type: "object", properties: {} },
  };

  const manifests = [
    webhookDef as never,
    slackDef as never,
    modelAbstract as never,
    { kind: "notify.Slack", metadata: { name: "alerts", module: "notify" } } as never,
  ];
  const root = {
    kind: "Telo.Library",
    metadata: { name: "notify" },
    exports: { kinds: ["Webhook"] },
  } as never;

  function plane() {
    const graph = fixtureWith([webhookDef, slackDef, modelAbstract], manifests, root);
    return { graph, kinds: graph.kinds };
  }

  it("keeps kinds out of the instance plane and in one of their own", () => {
    const { graph, kinds } = plane();
    expect(graph.nodes.filter((n) => !n.root).map((n) => n.name)).toEqual(["alerts"]);
    expect(kinds.map((k) => k.id).sort()).toEqual(["ai.Model", "notify.Slack", "notify.Webhook"]);
  });

  it("resolves lineage to the kind it specializes", () => {
    const slack = plane().kinds.find((k) => k.id === "notify.Slack")!;
    expect(slack.extendsId).toBe("notify.Webhook");
    expect(slack.extendsName).toBe("notify.Webhook");
  });

  it("marks a kind with a body of its own, and an abstract as non-instantiable", () => {
    const kinds = plane().kinds;
    expect(kinds.find((k) => k.id === "notify.Webhook")!.template).toBe(true);
    expect(kinds.find((k) => k.id === "notify.Slack")!.template).toBe(false);
    expect(kinds.find((k) => k.id === "ai.Model")!.abstract).toBe(true);
  });

  it("joins the two planes: a kind names the instances declared of it", () => {
    const { graph, kinds } = plane();
    const slack = kinds.find((k) => k.id === "notify.Slack")!;
    expect(slack.instances).toEqual([named(graph, "alerts").id]);
  });

  it("reports the export gate for the module's OWN kinds, and claims nothing about a dependency's", () => {
    const kinds = plane().kinds;
    expect(kinds.find((k) => k.id === "notify.Webhook")!.exported).toBe(true);
    expect(kinds.find((k) => k.id === "notify.Slack")!.exported).toBe(false);
    expect(kinds.find((k) => k.id === "ai.Model")!.exported).toBeUndefined();
  });
});

describe("what a row learns from its edge", () => {
  it("carries where the call resolved and where its arguments are written", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [{ name: "run", invoke: ref("cmd", "sql.Command"), inputs: { sql: "SELECT 1" } }],
      } as never,
      { kind: "sql.Command", metadata: { name: "cmd" } } as never,
    ]);
    const row = graph.nodeById(resourceId("run.Sequence", "seq"))!.rows[0];
    expect(row.target).toBe("cmd");
    expect(row.targetNode).toBe(resourceId("sql.Command", "cmd"));
    expect(row.inputs).toBe("steps[0].inputs");
  });

  it("gives an entry row the same, from its handler slot", () => {
    const graph = fixture([
      {
        kind: "http.Api",
        metadata: { name: "api" },
        routes: [{ path: "/x", method: "GET", handler: ref("seq", "run.Sequence"), inputs: {} }],
      } as never,
      { kind: "run.Sequence", metadata: { name: "seq" }, steps: [] } as never,
    ]);
    const row = graph.nodeById(resourceId("http.Api", "api"))!.rows[0];
    expect(row.targetNode).toBe(resourceId("run.Sequence", "seq"));
    expect(row.inputs).toBe("routes[0].inputs");
  });
});

describe("unwired", () => {
  it("marks a declaration nothing reaches", () => {
    const graph = fixture([
      { kind: "run.Sequence", metadata: { name: "orphan" }, steps: [] } as never,
    ]);
    const node = graph.nodeById(resourceId("run.Sequence", "orphan"))!;
    expect(isUnwired(node, graph)).toBe(true);
  });

  it("does not mark one that is HELD rather than called", () => {
    const graph = fixture([
      {
        kind: "sql.Command",
        metadata: { name: "cmd" },
        connection: ref("db", "sql.Connection"),
      } as never,
      { kind: "sql.Connection", metadata: { name: "db" } } as never,
    ]);
    expect(isUnwired(graph.nodeById(resourceId("sql.Connection", "db"))!, graph)).toBe(false);
  });

  it("never marks an imported export, which is not the reader's to remove", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "unused", module: "database", forwardedExport: true },
        steps: [],
      } as never,
    ]);
    const node = named(graph, "unused");
    expect(node.external).toBe(true);
    expect(isUnwired(node, graph)).toBe(false);
  });
});

describe("module-scoped identity", () => {
  /** Two libraries each exporting an `Http.Api` named `routes` — the shape that
   *  collapsed onto one node when identity was `(kind, name)`. */
  const twoRoutes = [
    {
      kind: "http.Api",
      metadata: { name: "routes", module: "Redirect", forwardedExport: true },
      routes: [{ path: "/{code}", method: "GET", handler: ref("resolve", "run.Sequence") }],
    } as never,
    {
      kind: "http.Api",
      metadata: { name: "routes", module: "Admin", forwardedExport: true },
      routes: [{ path: "/links", method: "GET", handler: ref("list", "run.Sequence") }],
    } as never,
  ];

  it("keeps two same-named exports from different libraries apart", () => {
    const graph = fixture(twoRoutes);
    const boxes = graph.nodes.filter((n) => n.name === "routes");
    expect(boxes).toHaveLength(2);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(2);
    // …and each keeps its OWN rows, which is what the collapse was taking.
    expect(boxes.map((b) => b.rows.length)).toEqual([1, 1]);
    expect(boxes.flatMap((b) => b.rows.map((r) => (r.match as { path: string }).path)).sort()).toEqual([
      "/links",
      "/{code}",
    ]);
  });

  it("resolves a bare name in the module that wrote it", () => {
    const graph = fixture([
      {
        kind: "run.Sequence",
        metadata: { name: "caller", module: "A" },
        steps: [{ name: "go", invoke: ref("helper", "sql.Command") }],
      } as never,
      { kind: "sql.Command", metadata: { name: "helper", module: "A" } } as never,
      { kind: "sql.Command", metadata: { name: "helper", module: "B" } } as never,
    ]);
    const edge = graph.edges.find((e) => e.toName === "helper")!;
    expect(graph.nodeById(edge.to!)!.module).toBe("A");
  });
});

describe("the error contract", () => {
  const raisingDef = {
    kind: "Telo.Definition",
    metadata: { name: "Guard", module: "guard" },
    capability: "Telo.Invocable",
    throws: { codes: { ERR_DENIED: {} } },
    schema: { type: "object", properties: {} },
  };
  /** A router whose entries carry an error branch under each of the two
   *  annotations that mark one. */
  const routerDef = (marker: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Router", module: "web" },
    capability: "Telo.Mount",
    schema: {
      type: "object",
      properties: {
        routes: {
          "x-telo-topology-role": "entries",
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { "x-telo-topology-role": "matcher", type: "string" },
              handler: {
                "x-telo-topology-role": "handler",
                "x-telo-ref": { kind: "telo.Executable", use: "trigger.inbound" },
              },
              catches: { type: "array", ...marker },
            },
          },
        },
      },
    },
  });

  it("carries what a resource can raise", () => {
    const graph = fixtureWith([raisingDef], [
      { kind: "guard.Guard", metadata: { name: "guard" } } as never,
    ]);
    expect(graph.nodes.find((n) => n.name === "guard")!.throws).toEqual({
      codes: ["ERR_DENIED"],
      unbounded: false,
    });
  });

  for (const [label, marker] of [
    ["the CEL error-context annotation", { "x-telo-error-context": { type: "object" } }],
    ["the dispatch outcome vocabulary", { "x-telo-outcome-list": "catches" }],
  ] as const) {
    it(`marks a row that discharges an error, by ${label}`, () => {
      const graph = fixtureWith([routerDef(marker), raisingDef], [
        {
          kind: "web.Router",
          metadata: { name: "api" },
          routes: [
            { path: "/a", handler: ref("guard", "guard.Guard"), catches: [{ status: 403 }] },
            { path: "/b", handler: ref("guard", "guard.Guard") },
          ],
        } as never,
        { kind: "guard.Guard", metadata: { name: "guard" } } as never,
      ]);
      const rows = graph.nodes.find((n) => n.name === "api")!.rows;
      expect(rows.map((r) => r.catches ?? false)).toEqual([true, false]);
    });
  }
});

describe("what a box offers as a slot", () => {
  it("folds the anyOf sub-shapes of one array into ONE port", () => {
    // A boot target may be written bare, as `{ref, when}`, or as an inline
    // invoke step — three spellings of one position, not three sockets.
    const graph = fixture(
      [{ kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never],
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [ref("migrate", "run.Sequence")],
      } as never,
    );
    expect(graph.root!.ports.map((p) => p.slot)).toEqual(["targets[]"]);
  });

  it("does not offer a port for occupancy already drawn as rows", () => {
    const graph = fixture(
      [{ kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never],
      {
        kind: "Telo.Application",
        metadata: { name: "app" },
        targets: [ref("migrate", "run.Sequence")],
      } as never,
    );
    // The row IS the target; a port beside it would be a second control for it.
    expect(graph.root!.ports.find((p) => p.slot === "targets[]")!.rowOwned).toBe(true);
    expect(graph.root!.rows.map((r) => r.target)).toEqual(["migrate"]);
  });
});

describe("what identifies an entry row", () => {
  const nestedMatcherDef = {
    kind: "Telo.Definition",
    metadata: { name: "Router", module: "web" },
    capability: "Telo.Mount",
    schema: {
      type: "object",
      properties: {
        routes: {
          "x-telo-topology-role": "entries",
          type: "array",
          items: {
            type: "object",
            properties: {
              // A matcher whose value is an OBJECT — the shape `Http.Api` uses,
              // where the request schema sits beside the path and method.
              request: { "x-telo-topology-role": "matcher", type: "object" },
              handler: {
                "x-telo-topology-role": "handler",
                "x-telo-ref": { kind: "telo.Executable", use: "trigger.inbound" },
              },
            },
          },
        },
      },
    },
  };

  const routeWith = (schema: unknown) => ({
    kind: "web.Router",
    metadata: { name: "api" },
    routes: [
      {
        request: { path: "/hello", method: "GET", ...(schema ? { schema } : {}) },
        handler: ref("h", "run.Sequence"),
      },
    ],
  });

  it("reads the scalars out of a nested matcher rather than the whole object", () => {
    const graph = fixtureWith([nestedMatcherDef], [
      routeWith(undefined) as never,
      { kind: "run.Sequence", metadata: { name: "h" }, steps: [] } as never,
    ]);
    expect(graph.nodes.find((n) => n.name === "api")!.rows[0].match).toEqual({
      path: "/hello",
      method: "GET",
    });
  });

  it("keeps a row's identity when its request SCHEMA changes", () => {
    const id = (schema: unknown) =>
      fixtureWith([nestedMatcherDef], [
        routeWith(schema) as never,
        { kind: "run.Sequence", metadata: { name: "h" }, steps: [] } as never,
      ]).nodes.find((n) => n.name === "api")!.rows[0].id;
    // Editing a property the row does not show must not detach the selection.
    expect(id({ query: { type: "object" } })).toBe(id(undefined));
  });
});

describe("an unwritten slot", () => {
  it("still carries the path a value would be written at", () => {
    // A server that declares no `notFoundHandler` at all: the slot exists
    // because the kind declares it, and filling it has to have somewhere to go.
    const graph = fixture([
      { kind: "http.Server", metadata: { name: "server" }, mounts: [] } as never,
    ]);
    const port = graph
      .nodeById(resourceId("http.Server", "server"))!
      .ports.find((p) => p.slot === "notFoundHandler.invoke")!;
    expect(port.slots).toEqual([{ path: "notFoundHandler.invoke" }]);
  });

  it("leaves an array slot to its append path rather than inventing an item", () => {
    const graph = fixture([
      { kind: "http.Server", metadata: { name: "server" }, mounts: [] } as never,
    ]);
    const port = graph
      .nodeById(resourceId("http.Server", "server"))!
      .ports.find((p) => p.slot === "mounts[].mount")!;
    expect(port.slots).toEqual([]);
    expect(port.addPath).toBe("mounts[0].mount");
  });
});

describe("ordered arrays a box can be added to", () => {
  it("declares an empty entry list, so the first entry can be added", () => {
    const graph = fixture([
      { kind: "http.Api", metadata: { name: "api" }, routes: [] } as never,
    ]);
    const node = graph.nodeById(resourceId("http.Api", "api"))!;
    expect(node.rows).toEqual([]);
    expect(node.rowArrays).toEqual([{ field: "routes", kind: "entry" }]);
    // …and the handler slot is still row-owned, so the box does not offer both
    // a port and an add control for the same list.
    expect(node.ports.find((p) => p.slot === "routes[].handler")!.rowOwned).toBe(true);
  });

  it("declares a step body the same way", () => {
    const graph = fixture([
      { kind: "run.Sequence", metadata: { name: "seq" }, steps: [] } as never,
    ]);
    expect(graph.nodeById(resourceId("run.Sequence", "seq"))!.rowArrays).toEqual([
      { field: "steps", kind: "step" },
    ]);
  });

  it("always gives the root its boot list", () => {
    const graph = fixture([], {
      kind: "Telo.Application",
      metadata: { name: "app" },
    } as never);
    expect(graph.root!.rowArrays).toEqual([{ field: "targets", kind: "target" }]);
  });
});

describe("the boot list", () => {
  const app = (targets: unknown[]) =>
    ({ kind: "Telo.Application", metadata: { name: "app" }, targets }) as never;

  it("draws an inline boot target ONCE", () => {
    // `targets` carries the step grammar, so the call graph mints a step node
    // for every entry that is not a bare `!ref`. Collecting those beside the
    // boot rows listed each inline target twice.
    const graph = fixture(
      [{ kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never],
      app([ref("migrate", "run.Sequence"), { name: "extra", invoke: ref("migrate", "run.Sequence") }]),
    );
    expect(graph.root!.rows.map((r) => r.path)).toEqual(["targets[0]", "targets[1]"]);
  });

  it("emits ONE edge per target, flagged as boot", () => {
    const graph = fixture(
      [
        { kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never,
        { kind: "http.Server", metadata: { name: "server" }, mounts: [] } as never,
      ],
      app([ref("migrate", "run.Sequence"), ref("server", "http.Server")]),
    );
    const boot = graph.edgesFrom(graph.root!.id);
    expect(boot.map((e) => e.toName)).toEqual(["migrate", "server"]);
    expect(boot.every((e) => e.boot)).toBe(true);
  });

  it("drops the edge when the reference is removed, leaving the row", () => {
    const graph = fixture(
      [{ kind: "run.Sequence", metadata: { name: "migrate" }, steps: [] } as never],
      app([{}]),
    );
    expect(graph.edgesFrom(graph.root!.id)).toEqual([]);
    expect(graph.root!.rows).toHaveLength(1);
  });
});

describe("reading the reference annotation", () => {
  /** A column-style slot: a value vocabulary OR a `!ref`, the sanctioned union.
   *  The annotation lives in a branch, which a hand-parser reading the node's
   *  own `x-telo-ref` cannot see. */
  const tableDef = {
    kind: "Telo.Definition",
    metadata: { name: "Table", module: "pg" },
    capability: "Telo.Provider",
    schema: {
      type: "object",
      properties: {
        columns: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              type: {
                oneOf: [
                  { title: "Storage class", type: "string", enum: ["text", "integer"] },
                  { title: "Enum type", type: "object", "x-telo-ref": { kind: "pg.Enum", use: "schema" } },
                ],
              },
            },
          },
        },
      },
    },
  };
  const enumDef = {
    kind: "Telo.Definition",
    metadata: { name: "Enum", module: "pg" },
    capability: "Telo.Provider",
    schema: { type: "object", properties: {} },
  };

  it("classes a reference declared in a union BRANCH by its own use", () => {
    const graph = fixtureWith([tableDef, enumDef], [
      {
        kind: "pg.Table",
        metadata: { name: "users" },
        columns: { role: { type: ref("mood", "pg.Enum") } },
      } as never,
      { kind: "pg.Enum", metadata: { name: "mood" } } as never,
    ]);
    const port = graph.nodes.find((n) => n.name === "users")!.ports[0];
    // `schema` names a shape: no runtime relation, and never a control transfer.
    expect(port.class).toBe("shape");
    const edge = graph.edges.find((e) => e.toName === "mood")!;
    expect(edge.class).toBe("shape");
  });
});

describe("a bare name inside a declaration", () => {
  const twoModules = (extra: ResourceManifest[] = []) => [
    { kind: "sql.Command", metadata: { name: "helper", module: "A" } } as never,
    { kind: "sql.Command", metadata: { name: "helper", module: "B" } } as never,
    ...extra,
  ];

  it("resolves a CEL state read in the module that wrote it", () => {
    const graph = fixture(
      twoModules([
        {
          kind: "run.Sequence",
          metadata: { name: "seq", module: "B" },
          steps: [],
          outputs: "${{ resources.helper.status.done }}",
        } as never,
      ]),
    );
    const edge = graph.edges.find((e) => e.class === "data")!;
    expect(graph.nodeById(edge.to!)!.module).toBe("B");
  });
});
