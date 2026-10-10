import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { PeerBinder, type ReferenceValue } from "../src/peer-binding.js";
import { declaredReach, reachSites } from "../src/reference-reach.js";
import { RuleDeclarationViews, type ForwardedReference } from "../src/rule-declaration-view.js";
import { evaluateResourceRules } from "../src/validate-resource-rules.js";

/** A rule reading a declaration another module exported reads its references in
 *  the form a local declaration's have: `{ kind, name, alias? }`, resolved in
 *  the scope of the module that declared it. */

const cel = (source: string) => makeTaggedSentinel("cel", source);
const ref = (name: string) => makeTaggedSentinel("ref", name);
const doc = (value: unknown) => value as ResourceManifest;

const holderSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: { "x-telo-ref": { kind: "lib.Item", use: "dependency" } } },
  },
  "x-telo-resource-rules": [
    {
      resolve: ["/items"],
      condition: cel("self.items.all(i, i.table.name == 'rows')"),
      code: "ITEM_TABLE_NAMED_ROWS",
      message: "every item must sit in the table named rows.",
    },
  ],
};
const itemSchema = {
  type: "object",
  properties: { table: { "x-telo-ref": { kind: "lib.Table", use: "dependency" } } },
};

const holder = doc({
  kind: "app.Holder",
  metadata: { name: "holder" },
  items: [{ kind: "lib.Item", name: "item", alias: "Lib" }],
});

/** The exported declaration as a consumer's analysis holds it: stamped
 *  forwarded, its own reference still the tag its author wrote. */
const forwarded = (table: unknown) =>
  doc({
    kind: "Self.Item",
    metadata: { name: "item", module: "lib", forwardedExport: true },
    table,
  });

function findingsOver(declaration: ResourceManifest, forwardedReference?: ForwardedReference) {
  const views = new RuleDeclarationViews(() => undefined, forwardedReference);
  const schemaOf = (kind: string) => (kind === "app.Holder" ? holderSchema : itemSchema);
  const binder = new PeerBinder({
    declarationOf: (r: ReferenceValue) => (r.name === "item" ? declaration : undefined),
    refSlotsOf: (kind) => declaredReach(schemaOf(kind)).references.map((r) => r.path),
    refSitesOf: (manifest, kind) =>
      new Map(
        reachSites(schemaOf(kind), manifest)
          .filter((site) => site.refs.length > 0)
          .map((site) => [
            site.path,
            { shape: site.refs[0]!.fieldPath, kinds: site.refs.flatMap((r) => r.slot.kinds) },
          ]),
      ),
    viewOf: (bound) => views.of(bound),
  });
  return evaluateResourceRules(holder, holderSchema, undefined, undefined, binder);
}

const inLibraryScope: ForwardedReference = (target, module) =>
  module === "lib" && target.alias === undefined
    ? { kind: "lib.Table", name: target.name }
    : undefined;

describe("a rule over a declaration another module exported", () => {
  it("evaluates, reading the declaration's reference as a local one is read", () => {
    expect(findingsOver(forwarded(ref("rows")), inLibraryScope)).toEqual([]);
    expect(findingsOver(forwarded(ref("other")), inLibraryScope).map((f) => f.kind)).toEqual([
      "violation",
    ]);
  });

  it("leaves a reference that resolves to nothing as written", () => {
    const findings = findingsOver(forwarded(ref("Missing.rows")), inLibraryScope);
    expect(findings.map((f) => f.kind)).toEqual(["failed"]);
  });

  it("does not rewrite a declaration of the entry's own modules", () => {
    const own = doc({ kind: "lib.Item", metadata: { name: "item", module: "lib" }, table: ref("rows") });
    expect(findingsOver(own, inLibraryScope).map((f) => f.kind)).toEqual(["failed"]);
  });
});
