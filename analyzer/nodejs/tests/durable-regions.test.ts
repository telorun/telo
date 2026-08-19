import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { validateDurableRegions } from "../src/validate-durable-regions.js";

/** A step slot spelled the legacy way, so the fixtures need no fragment
 *  expansion. The pass reads the slot through `isStepSlot`, which accepts both
 *  spellings — what is under test is the region, not which grammar declared it. */
const stepSlot = (attributes: Record<string, string>) => ({
  "x-telo-topology-role": "steps",
  "x-telo-step-context": { invoke: "invoke", value: "value" },
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      invoke: { "x-telo-ref": { kind: "telo.Executable", use: "call" }, type: "object" },
      inputs: { type: "object" },
    },
  },
  "x-telo-provides-zone": attributes,
});

const workflowDef = {
  kind: "Telo.Definition",
  metadata: { name: "Workflow", module: "Local" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      steps: stepSlot({ replayed: "every step's outcome is recorded and replayed" }),
    },
  },
};

const idempotentDef = {
  kind: "Telo.Definition",
  metadata: { name: "Idempotent", module: "Durable" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      reason: { type: "string" },
      steps: stepSlot({ idempotent: "the author asserts re-running this region is a no-op" }),
    },
  },
};

const detachDef = {
  kind: "Telo.Definition",
  metadata: { name: "Detach", module: "Run" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { invoke: { "x-telo-ref": { kind: "telo.Executable", use: "detached" } } },
  },
};

const scriptDef = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "JS" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: {} },
};

/** A kind whose declared output is a live handle — the unjournalable case, named
 *  through the value-type vocabulary rather than by type name. */
const streamerDef = {
  kind: "Telo.Definition",
  metadata: { name: "Streamer", module: "JS" },
  capability: "Telo.Invocable",
  outputType: { "x-telo-type": { name: "Telo.Stream", of: { type: "string" } } },
  schema: { type: "object", properties: {} },
};

function registryOf(...defs: unknown[]): DefinitionRegistry {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  return registry;
}

const defs = registryOf(workflowDef, idempotentDef, detachDef, scriptDef, streamerDef);
const ref = (name: string) => makeTaggedSentinel("ref", name);

function check(resources: unknown[], reportModules = ["App"]): string[] {
  const graph = buildCallGraph(resources as ResourceManifest[], defs);
  return validateDurableRegions({
    graph,
    resolveDef: (kind) => defs.resolve(kind),
    reportModules: new Set(reportModules),
  }).map((d) => d.code);
}

describe("DURABLE_DETACH_FORBIDDEN", () => {
  it("rejects a detached dispatch reached from a durable body", () => {
    expect(
      check([
        { kind: "JS.Script", metadata: { name: "work", module: "App" } },
        {
          kind: "Run.Detach",
          metadata: { name: "fireAndForget", module: "App" },
          invoke: ref("work"),
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "importer", module: "App" },
          steps: [{ name: "spawn", invoke: ref("fireAndForget") }],
        },
      ]),
    ).toEqual(["DURABLE_DETACH_FORBIDDEN"]);
  });

  it("leaves the same detach alone outside a durable body", () => {
    // The rule is about the REGION, not the kind: detaching is ordinary Telo,
    // and only journal-on-completion makes it wrong.
    expect(
      check([
        { kind: "JS.Script", metadata: { name: "work", module: "App" } },
        {
          kind: "Run.Detach",
          metadata: { name: "fireAndForget", module: "App" },
          invoke: ref("work"),
        },
      ]),
    ).toEqual([]);
  });
});

describe("DURABLE_NONDETERMINISM", () => {
  it("rejects impure CEL inside an idempotent region", () => {
    expect(
      check([
        { kind: "JS.Script", metadata: { name: "upsert", module: "App" } },
        {
          kind: "Durable.Idempotent",
          metadata: { name: "importAll", module: "App" },
          reason: "every write is an upsert",
          steps: [
            { name: "write", invoke: ref("upsert"), inputs: { key: "${{ uuidv4() }}" } },
          ],
        },
      ]),
    ).toEqual(["DURABLE_NONDETERMINISM"]);
  });

  it("allows impure CEL inside a merely REPLAYED region", () => {
    // This is the case the rule must not fire on, and the reason it keys on
    // `idempotent` rather than on durability in general: a journaled `uuidv4()`
    // is recorded once and replayed identically, which is exactly what a durable
    // identifier should do. Firing here would have authors rewriting correct
    // manifests.
    expect(
      check([
        { kind: "JS.Script", metadata: { name: "charge", module: "App" } },
        {
          kind: "Local.Workflow",
          metadata: { name: "onboard", module: "App" },
          steps: [
            { name: "pay", invoke: ref("charge"), inputs: { key: "${{ uuidv4() }}" } },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("allows a deterministic function of the same shape", () => {
    expect(
      check([
        { kind: "JS.Script", metadata: { name: "upsert", module: "App" } },
        {
          kind: "Durable.Idempotent",
          metadata: { name: "importAll", module: "App" },
          reason: "every write is an upsert",
          steps: [
            { name: "write", invoke: ref("upsert"), inputs: { key: "${{ string(1) }}" } },
          ],
        },
      ]),
    ).toEqual([]);
  });
});

describe("DURABLE_UNJOURNALABLE_RESULT", () => {
  it("warns when a durable step invokes something whose output is live", () => {
    expect(
      check([
        { kind: "JS.Streamer", metadata: { name: "tail", module: "App" } },
        {
          kind: "Local.Workflow",
          metadata: { name: "onboard", module: "App" },
          steps: [{ name: "read", invoke: ref("tail") }],
        },
      ]),
    ).toEqual(["DURABLE_UNJOURNALABLE_RESULT"]);
  });
});

describe("scoping", () => {
  it("says nothing about a module the entry does not own", () => {
    // A published dependency's body is not the consumer's to fix — the
    // `X_TELO_REF_UNRESOLVED` precedent, and the reason scoping is by declaring
    // MODULE rather than by file path.
    expect(
      check(
        [
          { kind: "JS.Script", metadata: { name: "work", module: "Vendor" } },
          {
            kind: "Run.Detach",
            metadata: { name: "fireAndForget", module: "Vendor" },
            invoke: ref("work"),
          },
          {
            kind: "Local.Workflow",
            metadata: { name: "importer", module: "Vendor" },
            steps: [{ name: "spawn", invoke: ref("fireAndForget") }],
          },
        ],
        ["App"],
      ),
    ).toEqual([]);
  });
});
