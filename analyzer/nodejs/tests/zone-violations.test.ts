import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { projectZoneRequirements } from "../src/resolve-zone-requirements.js";
import { validateZoneViolations } from "../src/validate-zone-violations.js";

/** A native step body, which is the shape a workflow kind has — and the shape
 *  that used to discharge nothing, since the edge comes from a step inside the
 *  array while the annotation sits on the array itself. */
const stepSlot = (attributes: Record<string, string>) => ({
  "x-telo-topology-role": "steps",
  "x-telo-step-context": { invoke: "invoke", value: "value" },
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" }, type: "object" },
      retry: { type: "object" },
    },
  },
  "x-telo-provides-zone": attributes,
});

const runAbstract = {
  kind: "Telo.Abstract",
  metadata: { name: "Run", module: "Durable" },
  capability: "Telo.Invocable",
};

const workflowDef = {
  kind: "Telo.Definition",
  metadata: { name: "Workflow", module: "Local" },
  capability: "Telo.Invocable",
  extends: "Durable.Run",
  schema: {
    type: "object",
    properties: {
      steps: stepSlot({ replayed: "every step's outcome is recorded and replayed" }),
    },
  },
};

/** The same kind with the attribute left off — the failure the plan called
 *  `DURABLE_ZONE_UNMARKED`, which no rule may catch by naming a kind. */
const unmarkedWorkflowDef = {
  kind: "Telo.Definition",
  metadata: { name: "Bare", module: "Local" },
  capability: "Telo.Invocable",
  extends: "Durable.Run",
  schema: { type: "object", properties: { steps: stepSlot({}) } },
};

const leaseDef = {
  kind: "Telo.Definition",
  metadata: { name: "Critical", module: "Lease" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      invoke: {
        "x-telo-ref": { kind: "telo.Executable", use: "call" },
        "x-telo-provides-zone": { noSuspend: "the lease expires on its own TTL" },
      },
    },
  },
};

/** A parking kind: it needs a replaying zone, and it cannot honour `noSuspend`. */
const awaitDef = {
  kind: "Telo.Definition",
  metadata: { name: "Await", module: "Durable" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    "x-telo-requires-zone": {
      zone: "Durable.Run",
      attributes: ["replayed"],
      reason: "there would be nothing to park",
    },
    "x-telo-violates-zone": { noSuspend: "this waits for a delivery days away" },
    properties: {},
  },
};

/** Needs the same zone and parks nothing — the case that makes the violation a
 *  declaration of its own rather than something inferable from the requirement. */
const valueDef = {
  kind: "Telo.Definition",
  metadata: { name: "Value", module: "Durable" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    "x-telo-requires-zone": { zone: "Durable.Run", attributes: ["replayed"] },
    properties: {},
  },
};

function registryOf(...defs: unknown[]): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  return registry;
}

const defs = registryOf(runAbstract, workflowDef, unmarkedWorkflowDef, leaseDef, awaitDef, valueDef);
const ref = (name: string) => makeTaggedSentinel("ref", name);
const resolveDef = (kind: string) => defs.resolve(kind);

function violations(resources: unknown[]): string[] {
  const graph = buildCallGraph(resources as ResourceManifest[], defs);
  return validateZoneViolations({
    graph,
    resolveDef,
    reportModules: new Set(["App"]),
  }).map((d) => d.code);
}

function requirements(resources: unknown[]): string[] {
  const graph = buildCallGraph(resources as ResourceManifest[], defs);
  const aliases = { resolveKind: (k: string) => k } as never;
  return projectZoneRequirements({
    graph,
    defs,
    aliases,
    aliasesByModule: new Map(),
    reportModules: new Set(["App"]),
  }).diagnostics.map((d) => d.code);
}

describe("ZONE_ATTRIBUTE_VIOLATED", () => {
  it("rejects a kind that cannot honour what the region it is inside promises", () => {
    expect(
      violations([
        { kind: "Durable.Await", metadata: { name: "approval", module: "App" } },
        {
          kind: "Lease.Critical",
          metadata: { name: "guarded", module: "App" },
          invoke: ref("approval"),
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "run", module: "App" },
          steps: [{ name: "wait", invoke: ref("guarded") }],
        },
      ]),
    ).toEqual(["ZONE_ATTRIBUTE_VIOLATED"]);
  });

  it("says nothing about a kind that needs the same zone and parks nothing", () => {
    // The whole reason a violation is its OWN declaration: `Durable.Value`
    // carries an identical requirement, so nothing about the requirement could
    // have distinguished the two.
    expect(
      violations([
        { kind: "Durable.Value", metadata: { name: "pinned", module: "App" } },
        {
          kind: "Lease.Critical",
          metadata: { name: "guarded", module: "App" },
          invoke: ref("pinned"),
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "run", module: "App" },
          steps: [{ name: "pin", invoke: ref("guarded") }],
        },
      ]),
    ).toEqual([]);
  });

  it("rejects a retry whose backoff would park, inside a region that forbids it", () => {
    expect(
      violations([
        { kind: "Durable.Value", metadata: { name: "work", module: "App" } },
        {
          kind: "Lease.Critical",
          metadata: { name: "guarded", module: "App" },
          invoke: ref("body"),
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "body", module: "App" },
          steps: [
            { name: "slow", invoke: ref("work"), retry: { attempts: 4, delay: "30s" } },
          ],
        },
      ]),
    ).toContain("ZONE_ATTRIBUTE_VIOLATED");
  });

  it("says nothing about a backoff short enough to sleep in process", () => {
    expect(
      violations([
        { kind: "Durable.Value", metadata: { name: "work", module: "App" } },
        {
          kind: "Lease.Critical",
          metadata: { name: "guarded", module: "App" },
          invoke: ref("body"),
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "body", module: "App" },
          steps: [{ name: "quick", invoke: ref("work"), retry: { attempts: 3, delay: "1s" } }],
        },
      ]),
    ).toEqual([]);
  });
});

describe("ZONE_ATTRIBUTE_MISSING", () => {
  it("rejects a zone of the right kind that does not declare the guarantee", () => {
    // This is `DURABLE_ZONE_UNMARKED` without naming a kind: `Local.Bare`
    // extends the marker, so it satisfies every kind test, while its body
    // declares nothing — a zone the durable checks never look inside.
    expect(
      requirements([
        { kind: "Durable.Await", metadata: { name: "approval", module: "App" } },
        {
          kind: "Local.Bare",
          metadata: { name: "run", module: "App" },
          steps: [{ name: "wait", invoke: ref("approval") }],
        },
      ]),
    ).toEqual(["ZONE_ATTRIBUTE_MISSING"]);
  });

  it("discharges a requirement through a NATIVE step body", () => {
    expect(
      requirements([
        { kind: "Durable.Await", metadata: { name: "approval", module: "App" } },
        {
          kind: "Local.Workflow",
          metadata: { name: "run", module: "App" },
          steps: [{ name: "wait", invoke: ref("approval") }],
        },
      ]),
    ).toEqual([]);
  });
});
