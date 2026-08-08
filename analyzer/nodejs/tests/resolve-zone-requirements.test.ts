import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { buildCallGraph } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import {
  deriveLibraryExportRequirements,
  projectZoneRequirements,
  runZoneAnalysis,
  type ZoneExportCache,
} from "../src/resolve-zone-requirements.js";

// ── Fixture kinds: a correlated provider, its requirer, and edges of every
// `use` the projection distinguishes.

const connectionDef = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "sql" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: {} },
};

const transactionDef = {
  kind: "Telo.Definition",
  metadata: { name: "Transaction", module: "sql" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
      steps: {
        "x-telo-ref": { kind: "telo.Executable", use: "call" },
        "x-telo-provides-zone": "/connection",
      },
    },
  },
};

const commandDef = {
  kind: "Telo.Definition",
  metadata: { name: "Command", module: "sql" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
      transaction: {
        "x-telo-ref": { kind: "sql.Transaction", use: "dependency" },
        "x-telo-requires-zone": {
          zone: "sql.Transaction",
          key: ["/connection", "/transaction/connection"],
          reason: "the statement would execute outside any transaction",
        },
      },
    },
  },
};

/** A plain caller: one `call` slot, so requirements travel through it. */
const callerDef = {
  kind: "Telo.Definition",
  metadata: { name: "Caller", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" } },
    },
  },
};

const routeDef = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "http" },
  capability: "Telo.Service",
  schema: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": { kind: "telo.Invocable", use: "trigger.inbound" } },
    },
  },
};

const streamDef = {
  kind: "Telo.Definition",
  metadata: { name: "OnComplete", module: "record-stream" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": { kind: "telo.Invocable", use: "trigger.consumer" } },
    },
  },
};

const detachDef = {
  kind: "Telo.Definition",
  metadata: { name: "Detach", module: "run" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      invoke: { "x-telo-ref": { kind: "telo.Invocable", use: "detached" } },
    },
  },
};

/** `Cache.View`'s narrowed shape: a case map whose cases are SETS. */
const viewDef = {
  kind: "Telo.Definition",
  metadata: { name: "View", module: "cache" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      revalidate: { type: "string", enum: ["background", "sync", "off"], default: "sync" },
      invoke: {
        "x-telo-ref": {
          kind: "telo.Invocable",
          use: {
            by: "/revalidate",
            cases: { background: ["call", "detached"], sync: "call", off: "call" },
          },
        },
      },
    },
  },
};

/** An unconditional non-call SET — the slot-level union that cannot be
 *  narrowed per instance, so it may block but never error. */
const unionDef = {
  kind: "Telo.Definition",
  metadata: { name: "Union", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      invoke: { "x-telo-ref": { kind: "telo.Invocable", use: ["call", "detached"] } },
    },
  },
};

/** A slot with NO declared use — the legacy bare-string form. */
const legacyDef = {
  kind: "Telo.Definition",
  metadata: { name: "Legacy", module: "test" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { invoke: { "x-telo-ref": "telo.Invocable" } },
  },
};

const appDef = {
  kind: "Telo.Definition",
  metadata: { name: "Application", module: "Telo" },
  schema: {
    type: "object",
    properties: {
      targets: {
        type: "array",
        items: { "x-telo-ref": { kind: ["telo.Runnable", "telo.Invocable"], use: "call" } },
      },
    },
  },
};

const ALL_DEFS = [
  connectionDef,
  transactionDef,
  commandDef,
  callerDef,
  routeDef,
  streamDef,
  detachDef,
  viewDef,
  unionDef,
  legacyDef,
  appDef,
];

const ref = (name: string) => makeTaggedSentinel("ref", name);

function stamp(manifests: unknown[], module = "app", source = "file://app.yaml"): ResourceManifest[] {
  return manifests.map((m) => {
    const r = m as ResourceManifest;
    return {
      ...r,
      metadata: { ...r.metadata, module, source },
    } as ResourceManifest;
  });
}

function analyze(
  manifests: unknown[],
  opts: { rootModules?: string[] } = {},
): { code?: string | number; message: string }[] {
  const defs = new DefinitionRegistry();
  for (const def of ALL_DEFS) defs.register(def as never);
  const aliases = new AliasResolver();
  const aliasesByModule = new Map<string, AliasResolver>();
  const resources = stamp(manifests);
  const graph = buildCallGraph(resources, defs, { aliases, aliasesByModule });
  const { diagnostics } = projectZoneRequirements({
    graph,
    defs,
    aliases,
    aliasesByModule,
    reportModules: new Set(opts.rootModules ?? ["app"]),
  });
  return diagnostics.map((d) => ({ code: d.code, message: d.message }));
}

describe("zone projection — discharge", () => {
  it("discharges a requirement at a providing slot with matching correlation", () => {
    expect(
      analyze([
        { kind: "sql.Connection", metadata: { name: "db" } },
        {
          kind: "sql.Transaction",
          metadata: { name: "tx" },
          connection: ref("db"),
          steps: ref("body"),
        },
        { kind: "test.Caller", metadata: { name: "body" }, invoke: ref("stmt") },
        {
          kind: "sql.Command",
          metadata: { name: "stmt" },
          connection: ref("db"),
          transaction: ref("tx"),
        },
      ]),
    ).toEqual([]);
  });

  it("correlates through a traversing key pointer when the direct field is absent", () => {
    // `stmt` declares no `connection:`; the key's SECOND pointer reads it off
    // the transaction it names — the idiomatic manifest, which a single
    // pointer would leave uncorrelated.
    expect(
      analyze([
        { kind: "sql.Connection", metadata: { name: "db" } },
        {
          kind: "sql.Transaction",
          metadata: { name: "tx" },
          connection: ref("db"),
          steps: ref("body"),
        },
        { kind: "test.Caller", metadata: { name: "body" }, invoke: ref("stmt") },
        { kind: "sql.Command", metadata: { name: "stmt" }, transaction: ref("tx") },
      ]),
    ).toEqual([]);
  });

  it("does NOT discharge when the provider correlates on a different resource", () => {
    const found = analyze([
      { kind: "sql.Connection", metadata: { name: "dbA" } },
      { kind: "sql.Connection", metadata: { name: "dbB" } },
      {
        kind: "sql.Transaction",
        metadata: { name: "tx" },
        connection: ref("dbB"),
        steps: ref("body"),
      },
      { kind: "test.Caller", metadata: { name: "body" }, invoke: ref("stmt") },
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("dbA"),
        transaction: ref("tx"),
      },
      { kind: "Telo.Application", metadata: { name: "App" }, targets: [ref("tx")] },
    ]);
    // The requirement passes the provider undischarged and surfaces at boot.
    expect(found.map((d) => d.code)).toContain("ZONE_REQUIREMENT_UNSATISFIED");
  });

  it("discharges an uncorrelated requirement by kind alone", () => {
    const uncorrelatedCommand = {
      ...commandDef,
      metadata: { name: "Loose", module: "sql" },
      schema: {
        type: "object",
        properties: {
          transaction: {
            "x-telo-ref": { kind: "sql.Transaction", use: "dependency" },
            "x-telo-requires-zone": "sql.Transaction",
          },
        },
      },
    };
    const defs = new DefinitionRegistry();
    for (const def of [...ALL_DEFS, uncorrelatedCommand]) defs.register(def as never);
    const aliases = new AliasResolver();
    const resources = stamp([
      { kind: "sql.Connection", metadata: { name: "db" } },
      {
        kind: "sql.Transaction",
        metadata: { name: "tx" },
        connection: ref("db"),
        steps: ref("body"),
      },
      { kind: "test.Caller", metadata: { name: "body" }, invoke: ref("stmt") },
      { kind: "sql.Loose", metadata: { name: "stmt" }, transaction: ref("tx") },
    ]);
    const graph = buildCallGraph(resources, defs, { aliases, aliasesByModule: new Map() });
    const { diagnostics } = projectZoneRequirements({
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      reportModules: new Set(["app"]),
    });
    expect(diagnostics).toEqual([]);
  });
});

describe("zone projection — severity follows the edge's guarantee", () => {
  const withEdge = (kind: string, slot: string) => [
    { kind: "sql.Connection", metadata: { name: "db" } },
    { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
    { kind, metadata: { name: "edge" }, [slot]: ref("stmt") },
    {
      kind: "sql.Command",
      metadata: { name: "stmt" },
      connection: ref("db"),
      transaction: ref("tx"),
    },
  ];

  it("errors at a trigger.inbound edge — the runtime guarantees a fresh context", () => {
    const found = analyze(withEdge("http.Api", "handler"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_UNSATISFIED"]);
    expect(found[0]!.message).toMatch(/inbound trigger registration/);
    // The author's `reason:` is quoted after the path.
    expect(found[0]!.message).toMatch(/outside any transaction/);
  });

  it("errors at a detached edge", () => {
    const found = analyze(withEdge("run.Detach", "invoke"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_UNSATISFIED"]);
    expect(found[0]!.message).toMatch(/detaches there/);
  });

  it("only WARNS at a trigger.consumer edge — the drain site decides", () => {
    const found = analyze(withEdge("record-stream.OnComplete", "handler"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_DEFERRED"]);
    expect(found[0]!.message).toMatch(/drained/);
  });

  it("ERRORS at a use set containing a guaranteed-cleared member", () => {
    // A set says several relations hold at once, not that one of them might.
    // `[call, detached]` therefore means the controller DOES detach on some
    // dispatch, and the detached dispatch is never inside the caller's zone —
    // decidably wrong, unlike a drain site that might be.
    const found = analyze(withEdge("test.Union", "invoke"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_UNSATISFIED"]);
    expect(found[0]!.message).toMatch(/guaranteed a fresh context/);
  });

  it("only WARNS at a set whose non-call member is trigger.consumer", () => {
    // Here the unknown really is unknowable: a consumer may drain the value
    // inside the zone, so no static reading settles it.
    const consumerSetDef = {
      kind: "Telo.Definition",
      metadata: { name: "ConsumerSet", module: "test" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: {
          invoke: {
            "x-telo-ref": { kind: "telo.Invocable", use: ["call", "trigger.consumer"] },
          },
        },
      },
    };
    const defs = new DefinitionRegistry();
    for (const def of [...ALL_DEFS, consumerSetDef]) defs.register(def as never);
    const aliases = new AliasResolver();
    const resources = stamp([
      { kind: "sql.Connection", metadata: { name: "db" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
      { kind: "test.ConsumerSet", metadata: { name: "edge" }, invoke: ref("stmt") },
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("db"),
        transaction: ref("tx"),
      },
    ]);
    const graph = buildCallGraph(resources, defs, { aliases, aliasesByModule: new Map() });
    const { diagnostics } = projectZoneRequirements({
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      reportModules: new Set(["app"]),
    });
    expect(diagnostics.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_DEFERRED"]);
  });

  it("only WARNS at an edge whose slot declares no use", () => {
    const found = analyze(withEdge("test.Legacy", "invoke"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_DEFERRED"]);
    expect(found[0]!.message).toMatch(/declares no use/);
  });

  it("errors when an open requirement reaches an application's boot targets", () => {
    const found = analyze([
      { kind: "sql.Connection", metadata: { name: "db" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("db"),
        transaction: ref("tx"),
      },
      { kind: "Telo.Application", metadata: { name: "App" }, targets: [ref("stmt")] },
    ]);
    expect(found.map((d) => d.code)).toContain("ZONE_REQUIREMENT_UNSATISFIED");
    expect(found.find((d) => d.code === "ZONE_REQUIREMENT_UNSATISFIED")!.message).toMatch(
      /boot targets, which nothing encloses/,
    );
  });
});

describe("zone projection — Cache.View's narrowed case map", () => {
  const throughCache = (revalidate?: string) => [
    { kind: "sql.Connection", metadata: { name: "db" } },
    { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("view") },
    {
      kind: "cache.View",
      metadata: { name: "view" },
      ...(revalidate ? { revalidate } : {}),
      invoke: ref("stmt"),
    },
    {
      kind: "sql.Command",
      metadata: { name: "stmt" },
      connection: ref("db"),
      transaction: ref("tx"),
    },
  ];

  it("produces NO diagnostic under the default revalidate: sync", () => {
    // The unconditional [call, detached] union would have hard-warned every
    // working cached transactional call; the case map resolves this instance's
    // slot to a plain `call`, so the requirement travels through and the
    // enclosing transaction discharges it.
    expect(analyze(throughCache())).toEqual([]);
  });

  it("produces no diagnostic under an explicit revalidate: off", () => {
    expect(analyze(throughCache("off"))).toEqual([]);
  });

  it("errors under revalidate: background, where the slot really detaches", () => {
    // The background refresh reaches the statement through `runDetached`, so it
    // throws ERR_ZONE_REQUIRED on every stale revalidation. The miss path
    // works, which is what makes it worth catching before production.
    const found = analyze(throughCache("background"));
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_UNSATISFIED"]);
  });
});

describe("zone projection — a correlation pointer never crosses a module boundary", () => {
  it("leaves a requirement uncorrelated when a key hop traverses an imported ref", () => {
    // `!ref Other.conn` names an instance in another module's scope, and the
    // only index here is flat and module-unscoped — taking the bare name would
    // bind to whatever local resource happened to share it. The kernel's
    // `referencedName` holds the identical rule, so both halves agree.
    const found = analyze([
      { kind: "sql.Connection", metadata: { name: "conn" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("conn"), steps: ref("body") },
      { kind: "test.Caller", metadata: { name: "body" }, invoke: ref("stmt") },
      // The statement's own `connection:` is a CROSS-MODULE ref that happens to
      // share a local name. Correlation must not silently bind to the local
      // `conn` — it discharges uncorrelated instead, so the enclosing
      // transaction satisfies it and nothing is invented.
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("Other.conn"),
        transaction: ref("tx"),
      },
    ]);
    expect(found).toEqual([]);
  });
});

describe("zone projection — propagation", () => {
  it("propagates through a chain of call edges", () => {
    const found = analyze([
      { kind: "sql.Connection", metadata: { name: "db" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
      { kind: "test.Caller", metadata: { name: "outer" }, invoke: ref("mid") },
      { kind: "test.Caller", metadata: { name: "mid" }, invoke: ref("inner") },
      { kind: "http.Api", metadata: { name: "api" }, handler: ref("outer") },
      {
        kind: "sql.Command",
        metadata: { name: "inner" },
        connection: ref("db"),
        transaction: ref("tx"),
      },
    ]);
    expect(found.map((d) => d.code)).toEqual(["ZONE_REQUIREMENT_UNSATISFIED"]);
    // The path names every hop, so the author can see where the zone was lost.
    expect(found[0]!.message).toMatch(/inner.*mid.*outer/s);
  });

  it("terminates a propagation cycle instead of spinning", () => {
    const found = analyze([
      { kind: "sql.Connection", metadata: { name: "db" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
      { kind: "test.Caller", metadata: { name: "a" }, invoke: ref("b") },
      { kind: "test.Caller", metadata: { name: "b" }, invoke: ref("a") },
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("db"),
        transaction: ref("tx"),
      },
      { kind: "test.Caller", metadata: { name: "c" }, invoke: ref("stmt") },
    ]);
    // Nothing to assert beyond termination and no invented failure: `stmt` is
    // reached only by `c`, which nothing calls, so no edge terminates it.
    expect(found).toEqual([]);
  });

  it("a requirement whose field is absent is never raised", () => {
    // A statement with no `transaction:` asserts nothing — it joins an open
    // transaction ambiently, exactly as before.
    expect(
      analyze([
        { kind: "sql.Connection", metadata: { name: "db" } },
        { kind: "http.Api", metadata: { name: "api" }, handler: ref("stmt") },
        { kind: "sql.Command", metadata: { name: "stmt" }, connection: ref("db") },
      ]),
    ).toEqual([]);
  });

  it("discharges at a slot that both provides and terminates", () => {
    // A `detached` provider slot: incoming requirements fail there, EXCEPT the
    // zone it provides — checked before termination.
    const durableRunDef = {
      kind: "Telo.Definition",
      metadata: { name: "Run", module: "durable" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: {
          connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
          invoke: {
            "x-telo-ref": { kind: "telo.Invocable", use: "detached" },
            "x-telo-provides-zone": "/connection",
          },
        },
      },
    };
    // Requires `durable.Run`'s zone, which that same slot provides.
    const sleepDef = {
      kind: "Telo.Definition",
      metadata: { name: "Sleep", module: "durable" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: {
          connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
          run: {
            "x-telo-ref": { kind: "durable.Run", use: "dependency" },
            "x-telo-requires-zone": { zone: "durable.Run", key: ["/connection"] },
          },
        },
      },
    };
    const defs = new DefinitionRegistry();
    for (const def of [...ALL_DEFS, durableRunDef, sleepDef]) defs.register(def as never);
    const aliases = new AliasResolver();
    const resources = stamp([
      { kind: "sql.Connection", metadata: { name: "db" } },
      {
        kind: "durable.Run",
        metadata: { name: "wf" },
        connection: ref("db"),
        invoke: ref("sleep"),
      },
      {
        kind: "durable.Sleep",
        metadata: { name: "sleep" },
        connection: ref("db"),
        run: ref("wf"),
      },
    ]);
    const graph = buildCallGraph(resources, defs, { aliases, aliasesByModule: new Map() });
    const { diagnostics } = projectZoneRequirements({
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      reportModules: new Set(["app"]),
    });
    expect(diagnostics).toEqual([]);
  });
});

describe("zone projection — extends-aware discharge", () => {
  it("accepts a provider whose kind EXTENDS the required kind", () => {
    const auditedTx = {
      kind: "Telo.Definition",
      metadata: { name: "AuditedTransaction", module: "audit" },
      capability: "Telo.Invocable",
      extends: "sql.Transaction",
      schema: {
        type: "object",
        properties: {
          connection: { "x-telo-ref": { kind: "sql.Connection", use: "dependency" } },
          steps: {
            "x-telo-ref": { kind: "telo.Executable", use: "call" },
            "x-telo-provides-zone": "/connection",
          },
        },
      },
    };
    const defs = new DefinitionRegistry();
    for (const def of [...ALL_DEFS, auditedTx]) defs.register(def as never);
    const aliases = new AliasResolver();
    const resources = stamp([
      { kind: "sql.Connection", metadata: { name: "db" } },
      { kind: "sql.Transaction", metadata: { name: "tx" }, connection: ref("db"), steps: ref("x") },
      {
        kind: "audit.AuditedTransaction",
        metadata: { name: "atx" },
        connection: ref("db"),
        steps: ref("stmt"),
      },
      {
        kind: "sql.Command",
        metadata: { name: "stmt" },
        connection: ref("db"),
        transaction: ref("tx"),
      },
    ]);
    const graph = buildCallGraph(resources, defs, { aliases, aliasesByModule: new Map() });
    const { diagnostics } = projectZoneRequirements({
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      reportModules: new Set(["app"]),
    });
    // Liskov: a child kind is accepted wherever its ancestor is.
    expect(diagnostics).toEqual([]);
  });
});

describe("zone projection — per-library export derivation", () => {
  const libraryDocs = () => ({
    module: "billing",
    sourceId: "file://billing/telo.yaml",
    exportedNames: ["billingWrites"],
    manifests: stamp(
      [
        {
          kind: "Telo.Library",
          metadata: { name: "billing" },
          exports: { resources: ["billingWrites"] },
        },
        { kind: "sql.Connection", metadata: { name: "billingDb" } },
        {
          kind: "sql.Transaction",
          metadata: { name: "billingTx" },
          connection: ref("billingDb"),
          steps: ref("billingWrites"),
        },
        { kind: "test.Caller", metadata: { name: "billingWrites" }, invoke: ref("charge") },
        {
          kind: "sql.Command",
          metadata: { name: "charge" },
          connection: ref("billingDb"),
          transaction: ref("billingTx"),
        },
      ],
      "billing",
      "file://billing/telo.yaml",
    ),
  });

  function derive(cache?: ZoneExportCache) {
    const defs = new DefinitionRegistry();
    for (const def of ALL_DEFS) defs.register(def as never);
    return deriveLibraryExportRequirements(
      libraryDocs(),
      defs,
      new AliasResolver(),
      new Map(),
      cache,
    );
  }

  it("derives the open requirement an exported resource carries", () => {
    const contracts = derive();
    const specs = contracts.get("billingWrites");
    expect(specs).toHaveLength(1);
    expect(specs![0]).toMatchObject({
      zone: "sql.Transaction",
      correlationName: "billingDb",
    });
  });

  it("caches per library — the same library analyzed twice builds one graph", () => {
    const cache: ZoneExportCache = new Map();
    const first = derive(cache);
    const second = derive(cache);
    // Same object identity: the second call hit the cache rather than
    // rebuilding the library's call graph. This is a requirement, not an
    // optimization — the editor re-analyzes on every keystroke.
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("invalidates when the library's documents change", () => {
    const defs = new DefinitionRegistry();
    for (const def of ALL_DEFS) defs.register(def as never);
    const cache: ZoneExportCache = new Map();
    const docs = libraryDocs();
    const first = deriveLibraryExportRequirements(docs, defs, new AliasResolver(), new Map(), cache);
    // A workspace library's documents change between runs precisely because
    // the user is editing them, so an identity-only key would serve a stale
    // contract. Drop the requiring statement and the contract must move.
    const edited = {
      ...docs,
      manifests: docs.manifests.filter((m) => m.metadata?.name !== "charge"),
    };
    const second = deriveLibraryExportRequirements(
      edited,
      defs,
      new AliasResolver(),
      new Map(),
      cache,
    );
    expect(second).not.toBe(first);
    expect(second.get("billingWrites")).toBeUndefined();
  });
});

describe("zone analysis — ZONE_EXPORT_UNSATISFIABLE", () => {
  it("errors at the exporting library when the correlation target is not exported", () => {
    const defs = new DefinitionRegistry();
    for (const def of ALL_DEFS) defs.register(def as never);
    const manifests = stamp(
      [
        {
          kind: "Telo.Library",
          metadata: { name: "billing" },
          exports: { resources: ["billingWrites"] },
        },
        { kind: "sql.Connection", metadata: { name: "billingDb" } },
        {
          kind: "sql.Transaction",
          metadata: { name: "billingTx" },
          connection: ref("billingDb"),
          steps: ref("billingWrites"),
        },
        { kind: "test.Caller", metadata: { name: "billingWrites" }, invoke: ref("charge") },
        {
          kind: "sql.Command",
          metadata: { name: "charge" },
          connection: ref("billingDb"),
          transaction: ref("billingTx"),
        },
      ],
      "billing",
      "file://billing/telo.yaml",
    );
    const aliases = new AliasResolver();
    const graph = buildCallGraph(manifests, defs, { aliases, aliasesByModule: new Map() });
    const diagnostics = runZoneAnalysis({
      manifests,
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      rootModules: new Set(["billing"]),
    });
    const unsatisfiable = diagnostics.filter((d) => d.code === "ZONE_EXPORT_UNSATISFIABLE");
    expect(unsatisfiable).toHaveLength(1);
    // Names both the fix options at the one desk where they apply.
    expect(unsatisfiable[0]!.message).toMatch(/billingDb/);
    expect(unsatisfiable[0]!.message).toMatch(/does not export/);
  });

  it("stays silent when the correlation target IS exported", () => {
    const defs = new DefinitionRegistry();
    for (const def of ALL_DEFS) defs.register(def as never);
    const manifests = stamp(
      [
        {
          kind: "Telo.Library",
          metadata: { name: "billing" },
          exports: { resources: ["billingWrites", "billingDb"] },
        },
        { kind: "sql.Connection", metadata: { name: "billingDb" } },
        {
          kind: "sql.Transaction",
          metadata: { name: "billingTx" },
          connection: ref("billingDb"),
          steps: ref("billingWrites"),
        },
        { kind: "test.Caller", metadata: { name: "billingWrites" }, invoke: ref("charge") },
        {
          kind: "sql.Command",
          metadata: { name: "charge" },
          connection: ref("billingDb"),
          transaction: ref("billingTx"),
        },
      ],
      "billing",
      "file://billing/telo.yaml",
    );
    const aliases = new AliasResolver();
    const graph = buildCallGraph(manifests, defs, { aliases, aliasesByModule: new Map() });
    const diagnostics = runZoneAnalysis({
      manifests,
      graph,
      defs,
      aliases,
      aliasesByModule: new Map(),
      rootModules: new Set(["billing"]),
    });
    expect(diagnostics.filter((d) => d.code === "ZONE_EXPORT_UNSATISFIABLE")).toEqual([]);
  });
});
