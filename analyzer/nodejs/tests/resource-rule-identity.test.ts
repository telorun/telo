import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { PeerBinder, type ReferenceValue } from "../src/peer-binding.js";
import { declaredReach, reachSites } from "../src/reference-reach.js";
import { resolvedReference } from "../src/resolved-reference.js";
import { evaluateResourceRules } from "../src/validate-resource-rules.js";

/** A bound declaration is a value equal only to itself: `==`, `!=` and `in`
 *  decide it from which declaration it is, never from what it holds. */

const cel = (source: string) => makeTaggedSentinel("cel", source);

const slot = { "x-telo-ref": { kind: "std.Language", use: "dependency" } };
const properties = {
  languages: { type: "array", items: slot },
  primary: slot,
  mounts: { type: "array", items: { type: "object", properties: { mount: slot, prefix: { type: "string" } } } },
};

const schemaWith = (rule: Record<string, unknown>) => ({
  type: "object",
  properties,
  "x-telo-resource-rules": [{ code: "RULE", message: "broken", ...rule }],
});

const language = (name: string, module: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "std.Language", metadata: { name, module }, code: "eng", ...extra }) as unknown as ResourceManifest;

/** Declarations by `<alias>.<name>`, a bare name reading module `A`. */
function binderOver(declarations: ResourceManifest[], schema: Record<string, any>): PeerBinder {
  const key = (module: string, name: string) => `${module}.${name}`;
  const byKey = new Map(declarations.map((d) => [key((d.metadata as { module: string }).module, d.metadata!.name as string), d]));
  return new PeerBinder({
    declarationOf: (r: ReferenceValue) => byKey.get(key(r.alias ?? "A", r.name)),
    refSlotsOf: () => declaredReach(schema).references.map((r) => r.path),
    refSitesOf: (manifest) =>
      new Map(
        reachSites(schema, manifest)
          .filter((site) => site.refs.length > 0)
          .map((site) => [site.path, { shape: site.refs[0]!.fieldPath, kinds: site.refs.flatMap((r) => r.slot.kinds) }]),
      ),
  });
}

const holder = (fields: Record<string, unknown>) =>
  ({ kind: "std.Holder", metadata: { name: "holder", module: "A" }, ...fields }) as unknown as ResourceManifest;

const ref = (name: string, alias?: string) => resolvedReference("std.Language", name, alias);

describe("a bound declaration compared", () => {
  const listed = schemaWith({ resolve: ["/languages", "/primary"], condition: cel("self.languages.exists(l, l == self.primary)") });

  it("is equal to itself, whatever it holds, and its content is not read", () => {
    const eng = language("eng", "A", { code: cel("variables.code") });
    const resource = holder({ languages: [ref("eng")], primary: ref("eng") });
    expect(evaluateResourceRules(resource, listed, undefined, undefined, binderOver([eng], listed))).toEqual([]);
  });

  it("is unequal to another declaration holding exactly the same", () => {
    const resource = holder({ languages: [ref("eng")], primary: ref("eng", "B") });
    const findings = evaluateResourceRules(resource, listed, undefined, undefined, binderOver([language("eng", "A"), language("eng", "B")], listed));
    expect(findings).toMatchObject([{ kind: "violation" }]);
  });

  it("is still read whole with everything it holds where it is not only compared", () => {
    const sized = schemaWith({ resolve: ["/languages"], condition: cel("self.languages.exists(l, size(l) > 0)") });
    const eng = language("eng", "A", { code: cel("variables.code") });
    const resource = holder({ languages: [ref("eng")] });
    expect(evaluateResourceRules(resource, sized, undefined, undefined, binderOver([eng], sized))).toMatchObject([
      { kind: "skipped", dynamic: { what: "a CEL expression" } },
    ]);
  });

  it("is read by identity inside a written entry, whose literal members are read by value", () => {
    const unique = schemaWith({
      resolve: ["/mounts"],
      in: "/mounts",
      condition: cel("self.mounts.filter(m, m == this).size() == 1"),
    });
    const eng = language("eng", "A", { code: cel("variables.code") });
    const entries = (...prefixes: unknown[]) => holder({ mounts: prefixes.map((prefix) => ({ mount: ref("eng"), prefix })) });
    const binder = binderOver([eng], unique);
    expect(evaluateResourceRules(entries("/a", "/b"), unique, undefined, undefined, binder)).toEqual([]);
    expect(evaluateResourceRules(entries("/a", "/a"), unique, undefined, undefined, binder).map((f) => f.kind)).toEqual([
      "violation",
      "violation",
    ]);
    // A literal member holding an expression is still read.
    expect(evaluateResourceRules(entries(cel("variables.p"), "/b"), unique, undefined, undefined, binder)).toMatchObject([
      { kind: "skipped", dynamic: { what: "a CEL expression" } },
      { kind: "skipped", dynamic: { what: "a CEL expression" } },
    ]);
  });

  it("is a member of a list holding it, by identity", () => {
    const member = schemaWith({ resolve: ["/languages", "/primary"], condition: cel("self.primary in self.languages") });
    const eng = language("eng", "A", { code: cel("variables.code") });
    const binder = binderOver([eng, language("fin", "A")], member);
    expect(evaluateResourceRules(holder({ languages: [ref("fin"), ref("eng")], primary: ref("eng") }), member, undefined, undefined, binder)).toEqual([]);
    expect(evaluateResourceRules(holder({ languages: [ref("fin")], primary: ref("eng") }), member, undefined, undefined, binder)).toMatchObject([
      { kind: "violation" },
    ]);
  });
});
