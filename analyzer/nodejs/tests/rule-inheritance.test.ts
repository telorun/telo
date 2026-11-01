import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { effectiveAuthorSchema } from "../src/extends-resolution.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A merge-form `extends` child's resource and referrer rules are its ancestors'
 * plus its own, each judged as the rules of the kind declaring it; a code the
 * child inherits is one it may not declare again.
 */

const cel = (source: string) => makeTaggedSentinel("cel", source);
const ref = (name: string) => makeTaggedSentinel("ref", name);

const library = { kind: "Telo.Library", metadata: { name: "own", source: "own.yaml" } } as unknown as ResourceManifest;

const rule = (code: string, condition: string) => ({ condition: cel(condition), code, message: `fails ${code}.` });

const parent = (rules: Record<string, unknown>): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Parent", module: "own", source: "parent.yaml" },
    capability: "Telo.Provider",
    controllers: ["pkg:telo/local/js?path=./x.mjs#Parent"],
    schema: { type: "object", additionalProperties: true, ...rules },
  }) as unknown as ResourceManifest;

const child = (rules: Record<string, unknown>, extra: Record<string, unknown> = {}): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Child", module: "own", source: "child.yaml" },
    extends: "Self.Parent",
    ...extra,
    schema: { type: "object", additionalProperties: true, ...rules },
  }) as unknown as ResourceManifest;

const resource = (fields: Record<string, unknown> = {}): ResourceManifest =>
  ({ kind: "own.Child", metadata: { name: "c", module: "own", source: "own.yaml" }, ...fields }) as unknown as ResourceManifest;

const holder: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Holder", module: "own", source: "holder.yaml" },
  capability: "Telo.Provider",
  controllers: ["pkg:telo/local/js?path=./x.mjs#Holder"],
  schema: {
    type: "object",
    additionalProperties: true,
    properties: { target: { "x-telo-ref": { kind: "Self.Parent", use: "dependency" } } },
  },
} as unknown as ResourceManifest;

const report = (docs: ResourceManifest[], codes: string[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(docs))
    .filter((d) => codes.includes(d.code))
    .map((d) => {
      const data = d.data as { rule?: string; path?: string; filePath?: string; resource?: { name?: string } };
      return { code: d.code, rule: data.rule, resource: data.resource?.name, path: data.path, filePath: data.filePath };
    });

describe("an extends child's rules", () => {
  it("are its parent's resource rules and its own, ancestors first", () => {
    const docs = [
      library,
      parent({ "x-telo-resource-rules": [rule("NEEDS_A", "has(self.a)")] }),
      child({ "x-telo-resource-rules": [rule("NEEDS_B", "has(self.b)")] }),
    ];
    expect(report([...docs, resource()], ["RESOURCE_RULE_VIOLATED"]).map((d) => d.rule)).toEqual(["NEEDS_A", "NEEDS_B"]);
    expect(report([...docs, resource({ a: 1, b: 1 })], ["RESOURCE_RULE_VIOLATED"])).toEqual([]);
  });

  it("are its own alone with base:, whose author schema is its own", () => {
    const docs = [
      library,
      parent({ "x-telo-resource-rules": [rule("NEEDS_A", "has(self.a)")] }),
      child({ "x-telo-resource-rules": [rule("NEEDS_B", "has(self.b)")] }, { base: {} }),
    ];
    expect(report([...docs, resource()], ["RESOURCE_RULE_VIOLATED"]).map((d) => d.rule)).toEqual(["NEEDS_B"]);
  });

  it("refuse a resource rule code the child inherits, and still run the inherited rule", () => {
    const docs = [
      library,
      parent({ "x-telo-resource-rules": [rule("NEEDS_A", "has(self.a)")] }),
      child({ "x-telo-resource-rules": [rule("NEEDS_A", "has(self.b)")] }),
      resource({ b: 1 }),
    ];
    expect(report(docs, ["RESOURCE_RULE_INVALID", "RESOURCE_RULE_VIOLATED"])).toEqual([
      { code: "RESOURCE_RULE_INVALID", rule: undefined, resource: "Child", path: "schema.x-telo-resource-rules[0].code", filePath: "child.yaml" },
      { code: "RESOURCE_RULE_VIOLATED", rule: "NEEDS_A", resource: "c", path: undefined, filePath: "own.yaml" },
    ]);
  });

  it("report a defect in an inherited rule at the kind declaring it", () => {
    const docs = [
      library,
      parent({ "x-telo-resource-rules": [rule("WIDGETS", "self.widgets.all(w, w > 0)")] }),
      child({ "x-telo-resource-rules": [rule("NEEDS_B", "has(self.b)")] }),
      resource({ b: 1 }),
    ];
    expect(report(docs, ["RESOURCE_RULE_INVALID"])).toEqual([
      { code: "RESOURCE_RULE_INVALID", rule: "WIDGETS", resource: "Parent", path: "schema.x-telo-resource-rules[0]", filePath: "parent.yaml" },
    ]);
  });

  it("are its parent's referrer rules and its own, and refuse an inherited code under the same filter", () => {
    const referrerRules = (code: string, condition: string) => ({ "x-telo-referrer-rules": [rule(code, condition)] });
    const holding = {
      kind: "own.Holder",
      metadata: { name: "h", module: "own" },
      target: ref("c"),
    } as unknown as ResourceManifest;
    const base = [library, holder, parent(referrerRules("NEEDS_LABEL", "has(referrer.label)"))];
    expect(
      report([...base, child(referrerRules("NEEDS_TAG", "has(referrer.tag)")), resource(), holding], ["REFERRER_RULE_VIOLATED"]).map(
        (d) => d.rule,
      ),
    ).toEqual(["NEEDS_LABEL", "NEEDS_TAG"]);
    expect(
      report([...base, child(referrerRules("NEEDS_LABEL", "has(referrer.tag)"))], ["REFERRER_RULE_INVALID"]).map((d) => d.path),
    ).toEqual(["schema.x-telo-referrer-rules[0].code"]);
  });

  it("are joined once when the child's schema already holds them", () => {
    const resolve = (kind: string) => (kind === "Self.Parent" ? parentDef : undefined);
    const parentDef = parent({ "x-telo-resource-rules": [rule("NEEDS_A", "has(self.a)")] }) as any;
    const childDef = child({ "x-telo-resource-rules": [rule("NEEDS_B", "has(self.b)")] }) as any;
    const stamped = { ...childDef, schema: effectiveAuthorSchema(childDef, resolve) };
    expect(
      (effectiveAuthorSchema(stamped, resolve)["x-telo-resource-rules"] as { code: string }[]).map((r) => r.code),
    ).toEqual(["NEEDS_A", "NEEDS_B"]);
  });
});
