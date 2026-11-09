import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { buildCallGraph } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { moduleCallNamesByModule } from "../src/module-call-names.js";
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
  outputType: { type: "object" },
  schema: {
    type: "object",
    properties: { invoke: { "x-telo-ref": { kind: "telo.Executable", use: "detached" } } },
  },
};

const scriptDef = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "JS" },
  capability: "Telo.Invocable",
  outputType: { type: "object" },
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

/** Declares no contract at all — the DURABLE_CONTRACT_REQUIRED case. */
const untypedDef = {
  kind: "Telo.Definition",
  metadata: { name: "Untyped", module: "JS" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: {} },
};

/** Declares no contract but accepts one on an instance. */
const openDef = {
  kind: "Telo.Definition",
  metadata: { name: "Open", module: "JS" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: { outputType: { type: "object" } } },
};

/** Declares no contract; its result is typed from its own `outputs:` keys. */
const valueDerivedDef = {
  kind: "Telo.Definition",
  metadata: { name: "Derived", module: "JS" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      outputType: { type: "object" },
      outputs: { type: "object", "x-telo-value-schema-from": "outputType" },
    },
  },
};

const defs = registryOf(
  workflowDef,
  idempotentDef,
  detachDef,
  scriptDef,
  streamerDef,
  untypedDef,
  openDef,
  valueDerivedDef,
);
const ref = (name: string) => makeTaggedSentinel("ref", name);

function diagnose(resources: unknown[], reportModules = ["App"]) {
  const graph = buildCallGraph(resources as ResourceManifest[], defs);
  return validateDurableRegions({
    graph,
    resolveDef: (kind) => defs.resolve(kind),
    reportModules: new Set(reportModules),
    moduleCallNames: moduleCallNamesByModule(resources as ResourceManifest[]),
    // No function is declared here, so no module call reaches one.
    moduleCallFlags: () => undefined,
  });
}

function check(resources: unknown[], reportModules = ["App"]): string[] {
  return diagnose(resources, reportModules).map((d) => d.code);
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
            { name: "write", invoke: ref("upsert"), inputs: { key: { __tagged: true, engine: "cel", source: "uuidv4()" } } },
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
            { name: "pay", invoke: ref("charge"), inputs: { key: { __tagged: true, engine: "cel", source: "uuidv4()" } } },
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
            { name: "write", invoke: ref("upsert"), inputs: { key: { __tagged: true, engine: "cel", source: "string(1)" } } },
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

describe("DURABLE_CONTRACT_REQUIRED", () => {
  const withoutContract = { kind: "JS.Untyped", metadata: { name: "work", module: "App" } };

  it("warns at a replayed step whose target declares no outputType", () => {
    expect(
      check([
        withoutContract,
        {
          kind: "Local.Workflow",
          metadata: { name: "onboard", module: "App" },
          steps: [{ name: "run", invoke: ref("work") }],
        },
      ]),
    ).toEqual(["DURABLE_CONTRACT_REQUIRED"]);
  });

  it("is exempt inside an idempotent region, reported only at the outer step", () => {
    const found = diagnose([
      withoutContract,
      {
        kind: "Durable.Idempotent",
        metadata: { name: "importAll", module: "App" },
        reason: "every write is an upsert",
        steps: [{ name: "inner", invoke: ref("work") }],
      },
      {
        kind: "Local.Workflow",
        metadata: { name: "onboard", module: "App" },
        steps: [{ name: "outer", invoke: ref("importAll") }],
      },
    ]).filter((d) => d.code === "DURABLE_CONTRACT_REQUIRED");
    expect(found.map((d) => (d.data as { path: string }).path)).toEqual(["steps[0]"]);
    expect(found[0]!.message).toContain("Step 'outer'");
  });

  it("tells the author to declare an outputType where the kind accepts one", () => {
    const [found] = diagnose([
      { kind: "JS.Open", metadata: { name: "work", module: "App" } },
      {
        kind: "Local.Workflow",
        metadata: { name: "onboard", module: "App" },
        steps: [{ name: "run", invoke: ref("work") }],
      },
    ]);
    expect(found!.message).toContain("Declare an outputType");
  });

  it("says the value is checked at runtime where the kind takes no outputType", () => {
    const [found] = diagnose([
      withoutContract,
      {
        kind: "Local.Workflow",
        metadata: { name: "onboard", module: "App" },
        steps: [{ name: "run", invoke: ref("work") }],
      },
    ]);
    expect(found!.message).not.toContain("Declare an outputType");
    expect(found!.message).toContain("does not take an outputType");
    expect(found!.message).toContain("ERR_DURABLE_UNJOURNALABLE_VALUE");
  });

  it("is satisfied by a result the kind types from the resource's own value slot", () => {
    expect(
      check([
        {
          kind: "JS.Derived",
          metadata: { name: "work", module: "App" },
          outputs: { id: "x" },
        },
        {
          kind: "Local.Workflow",
          metadata: { name: "onboard", module: "App" },
          steps: [{ name: "run", invoke: ref("work") }],
        },
      ]),
    ).toEqual([]);
  });

  it("says nothing outside a replayed region", () => {
    expect(check([withoutContract])).toEqual([]);
  });

  it("is satisfied by an outputType on the target or the nearest ancestor", () => {
    const reg = registryOf(
      workflowDef,
      untypedDef,
      {
        kind: "Telo.Definition",
        metadata: { name: "Typed", module: "JS" },
        capability: "Telo.Invocable",
        outputType: { type: "object", additionalProperties: true },
        schema: { type: "object", properties: {} },
      },
      {
        kind: "Telo.Definition",
        metadata: { name: "Child", module: "JS" },
        extends: "JS.Typed",
        schema: { type: "object", properties: {} },
      },
    );
    const resources = [
      { kind: "JS.Typed", metadata: { name: "a", module: "App" } },
      { kind: "JS.Child", metadata: { name: "b", module: "App" } },
      { kind: "JS.Untyped", metadata: { name: "c", module: "App" }, outputType: { type: "object" } },
      {
        kind: "Local.Workflow",
        metadata: { name: "onboard", module: "App" },
        steps: [
          { name: "x", invoke: ref("a") },
          { name: "y", invoke: ref("b") },
          { name: "z", invoke: ref("c") },
        ],
      },
    ];
    expect(
      validateDurableRegions({
        graph: buildCallGraph(resources as ResourceManifest[], reg),
        resolveDef: (kind) => reg.resolve(kind),
        reportModules: new Set(["App"]),
        moduleCallNames: moduleCallNamesByModule(resources as ResourceManifest[]),
        moduleCallFlags: () => undefined,
      }).map((d) => d.code),
    ).toEqual([]);
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
