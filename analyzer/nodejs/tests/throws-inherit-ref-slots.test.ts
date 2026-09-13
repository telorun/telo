import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AliasResolver } from "../src/alias-resolver.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import {
  createResolveCtx,
  resolveScopeUnion,
  resolveThrowsUnion,
} from "../src/resolve-throws-union.js";
import { forEachDrivenSlot } from "../src/schema-walk.js";
import { buildDrivenSlotMap } from "../src/reference-field-map.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** `throws: { inherit: true }` counts dispatch through a reference slot whose
 *  use, resolved for the instance, hands a failure back (`call`,
 *  `trigger.consumer`) — beside the step bodies it always counted. */

const cel = (source: string) => ({ __tagged: true, engine: "cel", source });
const refSentinel = (source: string) => ({ __tagged: true, engine: "ref", source });

const raiseDef = {
  kind: "Telo.Definition",
  metadata: { name: "Raise", module: "std" },
  capability: "Telo.Invocable",
  throws: { codes: { RAISED: {} } },
  schema: { type: "object", properties: {} },
};

const otherDef = {
  kind: "Telo.Definition",
  metadata: { name: "Other", module: "std" },
  capability: "Telo.Invocable",
  throws: { codes: { OTHER: {} } },
  schema: { type: "object", properties: {} },
};

const slot = (use: unknown) => ({ "x-telo-ref": { kind: "std.Raise", use } });

function relayDef(
  properties: Record<string, unknown>,
  throws: Record<string, unknown> = { inherit: true },
  name = "Relay",
) {
  return {
    kind: "Telo.Definition",
    metadata: { name, module: "std" },
    capability: "Telo.Invocable",
    throws,
    schema: { type: "object", properties },
  };
}

/** A kind over a whole schema, for shapes `relayDef`'s property map cannot state. */
const kindDef = (schema: Record<string, unknown>, throws: Record<string, unknown> = { inherit: true }) => ({
  kind: "Telo.Definition",
  metadata: { name: "Relay", module: "std" },
  capability: "Telo.Invocable",
  throws,
  schema: { type: "object", ...schema },
});

/** A reference slot whose union admits an inline node of its own recursive
 *  shape — a back-edge and a reference at the same path. */
const linkedList = {
  $defs: {
    Link: {
      type: "object",
      properties: {
        next: {
          "x-telo-ref": { kind: ["std.Raise", "std.Other"], use: "call" },
          anyOf: [
            { type: "string" },
            { type: "object", required: ["kind", "name"] },
            { $ref: "#/$defs/Link" },
          ],
        },
      },
    },
  },
  properties: { first: { $ref: "#/$defs/Link" } },
};

const raise: ResourceManifest = { kind: "std.Raise", metadata: { name: "raise" } } as never;
const other: ResourceManifest = { kind: "std.Other", metadata: { name: "other" } } as never;
const toRaise = { kind: "std.Raise", name: "raise" };
const toOther = { kind: "std.Other", name: "other" };

function unionOf(defs: unknown[], manifests: ResourceManifest[], name: string) {
  const registry = new DefinitionRegistry();
  for (const def of defs) registry.register(def as never);
  const all = [raise, other, ...manifests];
  const ctx = createResolveCtx(all, registry, new AliasResolver());
  const target = all.find((m) => m.metadata?.name === name)!;
  const union = resolveThrowsUnion(target, ctx);
  return { codes: [...union.codes.keys()].sort(), unbounded: union.unbounded };
}

const relay = (fields: Record<string, unknown>, kind = "std.Relay", name = "relay") =>
  ({ kind, metadata: { name }, ...fields }) as unknown as ResourceManifest;

describe("inherit through a reference slot — the use reduction", () => {
  for (const use of ["call", "trigger.consumer"] as const) {
    it(`counts a '${use}' slot`, () => {
      const defs = [raiseDef, otherDef, relayDef({ target: slot(use) })];
      expect(unionOf(defs, [relay({ target: toRaise })], "relay")).toEqual({
        codes: ["RAISED"],
        unbounded: false,
      });
    });
  }

  for (const use of ["detached", "trigger.inbound", "dependency", "schema"] as const) {
    it(`does not count a '${use}' slot`, () => {
      const defs = [raiseDef, otherDef, relayDef({ target: slot(use) })];
      expect(unionOf(defs, [relay({ target: toRaise })], "relay")).toEqual({
        codes: [],
        unbounded: false,
      });
    });
  }

  it("counts a use set that includes 'call'", () => {
    const defs = [raiseDef, otherDef, relayDef({ target: slot(["call", "detached"]) })];
    expect(unionOf(defs, [relay({ target: toRaise })], "relay").codes).toEqual(["RAISED"]);
  });

  it("counts the legacy bare-string slot as 'call' — no declared use keeps an error path", () => {
    const defs = [raiseDef, otherDef, relayDef({ target: { "x-telo-ref": "std.Raise" } })];
    expect(unionOf(defs, [relay({ target: toRaise })], "relay").codes).toEqual(["RAISED"]);
  });

  it("does not infer anything for a kind that does not declare inherit", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef({ target: slot("call") }, { codes: { OWN: {} } }),
    ];
    expect(unionOf(defs, [relay({ target: toRaise })], "relay").codes).toEqual(["OWN"]);
  });
});

describe("inherit through a reference slot — a case-map use, decided per instance", () => {
  const byDetach = (defaultValue: boolean, cases = { false: "call", true: "detached" }) =>
    relayDef({
      detach: { type: "boolean", default: defaultValue },
      target: slot({ by: "/detach", cases }),
    });

  it("a literal selector picks the case", () => {
    const defs = [raiseDef, otherDef, byDetach(false)];
    expect(unionOf(defs, [relay({ detach: false, target: toRaise })], "relay").codes).toEqual([
      "RAISED",
    ]);
    expect(unionOf(defs, [relay({ detach: true, target: toRaise })], "relay").codes).toEqual([]);
  });

  it("an omitted selector takes the schema default", () => {
    expect(
      unionOf([raiseDef, otherDef, byDetach(false)], [relay({ target: toRaise })], "relay").codes,
    ).toEqual(["RAISED"]);
    expect(
      unionOf([raiseDef, otherDef, byDetach(true)], [relay({ target: toRaise })], "relay").codes,
    ).toEqual([]);
  });

  it("a selector that cannot be decided counts when any case hands a failure back", () => {
    const dynamic = relay({ detach: cel("inputs.flag"), target: toRaise });
    expect(unionOf([raiseDef, otherDef, byDetach(false)], [dynamic], "relay").codes).toEqual([
      "RAISED",
    ]);
    const neverBack = byDetach(false, { false: "trigger.inbound", true: "detached" } as never);
    expect(unionOf([raiseDef, otherDef, neverBack], [dynamic], "relay").codes).toEqual([]);
  });

  it("an array item's selector is read from that item", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef({
        routes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              detach: { type: "boolean", default: false },
              handler: {
                "x-telo-ref": {
                  kind: ["std.Raise", "std.Other"],
                  use: { by: "/detach", cases: { false: "call", true: "detached" } },
                },
              },
            },
          },
        },
      }),
    ];
    const r = relay({
      routes: [
        { detach: true, handler: toRaise },
        { handler: toOther },
      ],
    });
    expect(unionOf(defs, [r], "relay").codes).toEqual(["OTHER"]);
  });
});

describe("inherit through a reference slot — reach and resolution", () => {
  it("reaches slots nested in properties and array items", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef({
        options: { type: "object", properties: { fallback: slot("call") } },
        targets: {
          type: "array",
          items: { "x-telo-ref": { kind: "std.Other", use: "call" } },
        },
      }),
    ];
    const r = relay({ options: { fallback: toRaise }, targets: [toOther] });
    expect(unionOf(defs, [r], "relay").codes).toEqual(["OTHER", "RAISED"]);
  });

  it("is transitive through another inherit kind", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef({ target: { "x-telo-ref": { kind: "std.Relay", use: "call" } } }, undefined, "Outer"),
      relayDef({ target: slot("call") }),
    ];
    const outer = relay({ target: { kind: "std.Relay", name: "relay" } }, "std.Outer", "outer");
    expect(unionOf(defs, [outer, relay({ target: toRaise })], "outer").codes).toEqual(["RAISED"]);
  });

  it("terminates on a cycle", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef(
        { target: { "x-telo-ref": { kind: "std.Relay", use: "call" } } },
        { codes: { A_CODE: {} }, inherit: true },
      ),
    ];
    const a = relay({ target: { kind: "std.Relay", name: "b" } }, "std.Relay", "a");
    const b = relay({ target: { kind: "std.Relay", name: "a" } }, "std.Relay", "b");
    expect(unionOf(defs, [a, b], "a")).toEqual({ codes: ["A_CODE"], unbounded: false });
  });

  it("an unresolvable target makes the union unbounded", () => {
    const defs = [raiseDef, otherDef, relayDef({ target: slot("call") })];
    expect(unionOf(defs, [relay({ target: refSentinel("missing") })], "relay").unbounded).toBe(
      true,
    );
    expect(
      unionOf(defs, [relay({ target: { kind: "std.Nope", name: "x" } })], "relay").unbounded,
    ).toBe(true);
  });
});

describe("the driven-slot walk's reach", () => {
  it("follows a local $ref", () => {
    const def = kindDef({
      $defs: { T: slot("call") },
      properties: { target: { $ref: "#/$defs/T" } },
    });
    expect(unionOf([raiseDef, otherDef, def], [relay({ target: toRaise })], "relay")).toEqual({
      codes: ["RAISED"],
      unbounded: false,
    });
  });

  it("descends a root-level union branch", () => {
    const def = kindDef({ oneOf: [{ properties: { target: slot("call") } }] });
    expect(unionOf([raiseDef, otherDef, def], [relay({ target: toRaise })], "relay").codes).toEqual([
      "RAISED",
    ]);
  });

  it("descends additionalProperties", () => {
    const def = kindDef({
      properties: { targets: { type: "object", additionalProperties: slot("call") } },
    });
    const r = relay({ targets: { first: toRaise } });
    expect(unionOf([raiseDef, otherDef, def], [r], "relay").codes).toEqual(["RAISED"]);
  });

  it("follows a recursive shape as deep as the data goes", () => {
    const def = kindDef({
      $defs: {
        Node: {
          type: "object",
          properties: {
            target: { "x-telo-ref": { kind: ["std.Raise", "std.Other"], use: "call" } },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
      properties: { tree: { $ref: "#/$defs/Node" } },
    });
    const r = relay({
      tree: { children: [{ children: [{ target: toOther }] }, { target: toRaise }] },
    });
    expect(unionOf([raiseDef, otherDef, def], [r], "relay").codes).toEqual(["OTHER", "RAISED"]);
  });

  it("visits each concrete site once, holding every slot declared there", () => {
    const schema = {
      type: "object",
      properties: { a: slot("call") },
      oneOf: [{ properties: { a: slot("detached") } }],
      additionalProperties: { "x-telo-ref": { kind: "std.Other", use: "detached" } },
    };
    const visits: Array<{ path: string; uses: string[][] }> = [];
    forEachDrivenSlot(schema, { a: toRaise, b: toOther }, (d) => {
      if (d.kind === "ref") visits.push({ path: d.path, uses: d.slots.map(({ slot }) => slot.uses) });
    });
    expect(visits).toEqual([
      { path: "a", uses: [["call"], ["detached"]] },
      { path: "b", uses: [["detached"]] },
    ]);
  });

  it("keeps a reference slot beside a back-edge at one path", () => {
    const def = kindDef(linkedList);
    expect(
      unionOf([raiseDef, otherDef, def], [relay({ first: { next: toRaise } })], "relay").codes,
    ).toEqual(["RAISED"]);
    // An inline Link recurses: the target two links down is reached.
    expect(
      unionOf([raiseDef, otherDef, def], [relay({ first: { next: { next: toOther } } })], "relay")
        .codes,
    ).toEqual(["OTHER"]);
  });

  it("applies a map-value slot only to keys its schema does not declare", () => {
    const def = kindDef({
      properties: { label: { type: "object" } },
      additionalProperties: slot("call"),
    });
    const r = relay({ label: { kind: "std.Nope" }, extra: toRaise });
    expect(unionOf([raiseDef, otherDef, def], [r], "relay")).toEqual({
      codes: ["RAISED"],
      unbounded: false,
    });
  });

  it("never reads the resource envelope as a root map value", () => {
    const paths: string[] = [];
    forEachDrivenSlot(
      { type: "object", additionalProperties: slot("call") },
      { kind: "std.Relay", metadata: { name: "relay" }, extra: toRaise },
      (d) => paths.push(d.path),
    );
    expect(paths).toEqual(["extra"]);
  });

  it("marks a schema of back-edges alone as driving nothing", () => {
    const schema = {
      type: "object",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
      properties: { tree: { $ref: "#/$defs/Node" } },
    };
    expect(buildDrivenSlotMap(schema).drives).toBe(false);
    expect(buildDrivenSlotMap(kindDef(linkedList).schema).drives).toBe(true);
  });
});

describe("the scope union reads the same legacy fallback", () => {
  it("counts a slot that declares no use", () => {
    const routerDef = kindDef(
      {
        properties: {
          routes: {
            type: "array",
            items: { type: "object", properties: { handler: { "x-telo-ref": "std.Raise" } } },
          },
        },
      },
      {},
    );
    const registry = new DefinitionRegistry();
    for (const def of [raiseDef, otherDef, routerDef]) registry.register(def as never);
    const router = relay({ routes: [{ handler: toRaise }] });
    const ctx = createResolveCtx([raise, other, router], registry, new AliasResolver());
    const union = resolveScopeUnion(router, registry.resolve("std.Relay")!, ctx);
    expect([...union.codes.keys()]).toEqual(["RAISED"]);
  });
});

describe("inherit — step bodies are unchanged", () => {
  it("keeps try/catch subtraction and unions a ref slot beside it", () => {
    const defs = [
      raiseDef,
      otherDef,
      relayDef({
        steps: { type: "array", "x-telo-step-context": { invoke: "invoke" } },
        target: { "x-telo-ref": { kind: "std.Other", use: "call" } },
      }),
    ];
    const r = relay({
      steps: [{ name: "guarded", try: [{ name: "r", invoke: toRaise }], catch: [] }],
      target: toOther,
    });
    expect(unionOf(defs, [r], "relay")).toEqual({ codes: ["OTHER"], unbounded: false });
  });
});

const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "app", version: "1.0.0" },
} as unknown as ResourceManifest;

function checkDiagnostics(schema: Record<string, unknown>) {
  const diagnostics = new StaticAnalyzer().analyze(
    withSyntheticPositions([app, raiseDef as never, kindDef(schema) as never]),
  );
  return diagnostics.filter((d) => d.code === "INHERIT_WITHOUT_STEP_CONTEXT");
}

const inheritDiagnostics = (properties: Record<string, unknown>) => checkDiagnostics({ properties });

describe("INHERIT_WITHOUT_STEP_CONTEXT", () => {
  it("is raised when the kind dispatches nothing", () => {
    const found = inheritDiagnostics({ label: { type: "string" } });
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("'call' or 'trigger.consumer'");
  });

  for (const use of ["detached", "trigger.inbound", "dependency", "schema"] as const) {
    it(`is raised when the only slot is '${use}'`, () => {
      expect(inheritDiagnostics({ target: slot(use) })).toHaveLength(1);
    });
  }

  it("is not raised for a slot that declares no use, which counts as 'call'", () => {
    expect(inheritDiagnostics({ target: { "x-telo-ref": "std.Raise" } })).toHaveLength(0);
  });

  for (const use of ["call", "trigger.consumer"] as const) {
    it(`is not raised for a '${use}' slot`, () => {
      expect(inheritDiagnostics({ target: slot(use) })).toHaveLength(0);
    });
  }

  it("is not raised for a case map with a case that hands a failure back", () => {
    expect(
      inheritDiagnostics({
        detach: { type: "boolean", default: true },
        target: slot({ by: "/detach", cases: { false: "call", true: "detached" } }),
      }),
    ).toHaveLength(0);
  });

  it("is not raised for a step body", () => {
    expect(
      inheritDiagnostics({ steps: { type: "array", "x-telo-step-context": { invoke: "invoke" } } }),
    ).toHaveLength(0);
  });
});
