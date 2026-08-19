import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCallGraph, resourceId } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { containmentIndex, findZoneRegions } from "../src/resolve-zone-containment.js";

/** A transaction: a ref-slot body carrying two attributes. */
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
        "x-telo-provides-zone": {
          key: "/connection",
          atomic: "a rollback erases writes a journal recorded as done",
          noSuspend: "the transaction holds a connection a parked run would lose",
        },
      },
    },
  },
};

const connectionDef = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "sql" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: {} },
};

const echoDef = {
  kind: "Telo.Definition",
  metadata: { name: "Echo", module: "test" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: {} },
};

/** A sequence whose steps call on. Declared with the legacy step-context
 *  spelling, which the call graph still reads — the containment walk must not
 *  care which spelling a step array uses. */
const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    $defs: {
      step: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: {
            "x-telo-ref": { kind: "telo.Executable", use: "call", inputs: "/inputs" },
            type: "object",
          },
          inputs: { type: "object" },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-step-context": { invoke: "invoke" },
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
};

/** A workflow carrying its body natively, with the durable attribute on the
 *  step slot — the shape a backend's `Workflow` kind takes. */
const workflowDef = {
  kind: "Telo.Definition",
  metadata: { name: "Workflow", module: "durableLocal" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    $defs: {
      step: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" }, type: "object" },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-step-context": { invoke: "invoke" },
        type: "array",
        items: { $ref: "#/$defs/step" },
        "x-telo-provides-zone": {
          replayed: "every step is journaled and replayed from the record on resume",
        },
      },
    },
  },
};

/** A detacher, for the boundary case. */
const detachDef = {
  kind: "Telo.Definition",
  metadata: { name: "Detach", module: "run" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      invoke: { "x-telo-ref": { kind: "telo.Executable", use: "detached" } },
    },
  },
};

function registryOf(...defs: unknown[]): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  return registry;
}

const ref = (name: string) => makeTaggedSentinel("ref", name);
const defs = registryOf(
  transactionDef,
  connectionDef,
  echoDef,
  sequenceDef,
  workflowDef,
  detachDef,
);
const resolveDef = (kind: string) => defs.resolve(kind);

describe("findZoneRegions — a ref-slot body", () => {
  const resources = [
    { kind: "sql.Connection", metadata: { name: "db" } },
    { kind: "test.Echo", metadata: { name: "write" } },
    {
      kind: "run.Sequence",
      metadata: { name: "body" },
      steps: [{ name: "insert", invoke: ref("write") }],
    },
    {
      kind: "sql.Transaction",
      metadata: { name: "tx" },
      connection: ref("db"),
      steps: ref("body"),
    },
  ] as unknown as ResourceManifest[];

  const graph = buildCallGraph(resources, defs);

  it("reaches the body and everything it calls, transitively", () => {
    const [region] = findZoneRegions(graph, resolveDef, "noSuspend");
    expect(region).toBeDefined();
    expect(region!.provider.name).toBe("tx");
    expect(region!.slot).toBe("steps");
    const names = [...region!.contents.values()].map((c) =>
      c.node.type === "resource" ? c.node.name : `step:${c.node.name}`,
    );
    expect(names).toContain("body");
    expect(names).toContain("step:insert");
    expect(names).toContain("write");
  });

  it("excludes the provider itself — a zone constrains its contents, not its opener", () => {
    const [region] = findZoneRegions(graph, resolveDef, "noSuspend");
    expect(region!.contents.has(resourceId("sql.Transaction", "tx"))).toBe(false);
  });

  it("excludes a dependency the provider merely holds", () => {
    const [region] = findZoneRegions(graph, resolveDef, "noSuspend");
    expect(region!.contents.has(resourceId("sql.Connection", "db"))).toBe(false);
  });

  it("carries the author's reason and every attribute the slot declares", () => {
    const [region] = findZoneRegions(graph, resolveDef, "atomic");
    expect(region!.reason).toMatch(/rollback erases/);
    // A consumer deciding collapse reads both off one region rather than
    // walking twice.
    expect(Object.keys(region!.attributes).sort()).toEqual(["atomic", "noSuspend"]);
  });

  it("finds nothing for an attribute the slot does not declare", () => {
    expect(findZoneRegions(graph, resolveDef, "replayed")).toEqual([]);
    expect(findZoneRegions(graph, resolveDef, "idempotent")).toEqual([]);
  });
});

describe("findZoneRegions — a native step body", () => {
  const resources = [
    { kind: "test.Echo", metadata: { name: "charge" } },
    {
      kind: "durableLocal.Workflow",
      metadata: { name: "onboard" },
      steps: [{ name: "createAccount", invoke: ref("charge") }],
    },
  ] as unknown as ResourceManifest[];

  const graph = buildCallGraph(resources, defs);

  it("enters through the slot's own step nodes rather than through an edge", () => {
    const [region] = findZoneRegions(graph, resolveDef, "replayed");
    expect(region).toBeDefined();
    const names = [...region!.contents.values()].map((c) =>
      c.node.type === "resource" ? c.node.name : `step:${c.node.name}`,
    );
    expect(names).toContain("step:createAccount");
    expect(names).toContain("charge");
    // The workflow is the opener, not a member of its own region.
    expect(region!.contents.has(resourceId("durableLocal.Workflow", "onboard"))).toBe(false);
  });
});

describe("findZoneRegions — the zone's lifetime stops at a detach", () => {
  const resources = [
    { kind: "test.Echo", metadata: { name: "background" } },
    { kind: "run.Detach", metadata: { name: "fireAndForget" }, invoke: ref("background") },
    {
      kind: "run.Sequence",
      metadata: { name: "body" },
      steps: [{ name: "spawn", invoke: ref("fireAndForget") }],
    },
    { kind: "sql.Connection", metadata: { name: "db" } },
    {
      kind: "sql.Transaction",
      metadata: { name: "tx" },
      connection: ref("db"),
      steps: ref("body"),
    },
  ] as unknown as ResourceManifest[];

  const graph = buildCallGraph(resources, defs);
  const [region] = findZoneRegions(graph, resolveDef, "noSuspend");

  it("records the detaching dispatch as a boundary rather than following it", () => {
    // The detacher IS inside the region — it is called there — while what it
    // detaches to is not, because the zone's lifetime does not reach it.
    const names = [...region!.contents.values()]
      .filter((c) => c.node.type === "resource")
      .map((c) => (c.node as { name: string }).name);
    expect(names).toContain("fireAndForget");
    expect(names).not.toContain("background");

    expect(region!.boundaries).toHaveLength(1);
    expect(region!.boundaries[0]!.from.name).toBe("fireAndForget");
    expect(region!.boundaries[0]!.escaping).toEqual(["detached"]);
  });
});

describe("containmentIndex", () => {
  it("maps every contained node to the region holding it", () => {
    const resources = [
      { kind: "test.Echo", metadata: { name: "write" } },
      {
        kind: "run.Sequence",
        metadata: { name: "body" },
        steps: [{ name: "insert", invoke: ref("write") }],
      },
      { kind: "sql.Connection", metadata: { name: "db" } },
      {
        kind: "sql.Transaction",
        metadata: { name: "tx" },
        connection: ref("db"),
        steps: ref("body"),
      },
    ] as unknown as ResourceManifest[];
    const graph = buildCallGraph(resources, defs);
    const index = containmentIndex(findZoneRegions(graph, resolveDef, "noSuspend"));
    expect(index.get(resourceId("test.Echo", "write"))?.provider.name).toBe("tx");
    expect(index.has(resourceId("sql.Connection", "db"))).toBe(false);
  });
});
