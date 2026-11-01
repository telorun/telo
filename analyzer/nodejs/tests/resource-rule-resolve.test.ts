import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { reportResourceRules } from "../src/validate-resource-rules.js";
import { PeerBinder, type ReferenceValue } from "../src/peer-binding.js";
import { declaredReach, reachSites } from "../src/reference-reach.js";
import {
  evaluateResourceRules,
  validateResourceRuleDeclarations,
} from "../src/validate-resource-rules.js";
import { resolvedReference } from "../src/resolved-reference.js";

/** A resource rule's `resolve:` — the condition reads the declarations its own
 *  reference slots name, one level deep, in place of the references. */

const cel = (source: string) => makeTaggedSentinel("cel", source);

const schema = {
  type: "object",
  properties: { languages: { type: "array", items: { "x-telo-ref": { kind: "std.Language", use: "dependency" } } } },
  "x-telo-resource-rules": [
    {
      resolve: ["/languages"],
      in: "/languages",
      condition: cel("size(self.languages.filter(o, o.code == this.code)) == 1"),
      code: "LANGUAGE_CODE_DUPLICATE",
      message: "two models share a code",
    },
  ],
};

const language = (name: string, code: string, extra: Record<string, unknown> = {}) =>
  ({ kind: "std.Language", metadata: { name, ...extra }, code }) as unknown as ResourceManifest;

const ref = (name: string) => resolvedReference("std.Language", name);

function binderOver(
  declarations: ResourceManifest[],
  over: Record<string, any> = schema,
): PeerBinder {
  const byName = new Map(declarations.map((d) => [d.metadata!.name as string, d]));
  return new PeerBinder({
    declarationOf: (r: ReferenceValue) => byName.get(r.name),
    refSlotsOf: () => declaredReach(over).references.map((r) => r.path),
    refSitesOf: (manifest) =>
      new Map(
        reachSites(over, manifest)
          .filter((site) => site.refs.length > 0)
          .map((site) => [
            site.path,
            { shape: site.refs[0]!.fieldPath, kinds: site.refs.flatMap((r) => r.slot.kinds) },
          ]),
      ),
    // The analyzer's rule is Liskov over the registry; here identity is enough —
    // every declaration in these fixtures is of a leaf kind.
    slotAccepts: (kinds, kind) => kinds.includes(kind),
  });
}

const recognizer = (...names: string[]) =>
  ({ kind: "std.Recognizer", metadata: { name: "recognizer" }, languages: names.map(ref) }) as unknown as ResourceManifest;

describe("resource rules — resolve", () => {
  it("reads the referenced declarations, and reports each entry that breaks the rule", () => {
    const binder = binderOver([language("eng", "eng"), language("invoices", "eng")]);
    const findings = evaluateResourceRules(recognizer("eng", "invoices"), schema, undefined, undefined, binder);
    expect(findings.map((f) => [f.kind, "path" in f ? f.path : undefined])).toEqual([
      ["violation", "languages[0]"],
      ["violation", "languages[1]"],
    ]);
  });

  it("holds when the codes are distinct", () => {
    const binder = binderOver([language("eng", "eng"), language("invoices", "eng_invoice")]);
    expect(evaluateResourceRules(recognizer("eng", "invoices"), schema, undefined, undefined, binder)).toEqual([]);
  });

  it("skips, naming why, when a reference is a library's kind-only input", () => {
    const binder = binderOver([language("eng", "eng"), language("model", "", { xTeloInjected: true })]);
    const findings = evaluateResourceRules(recognizer("eng", "model"), schema, undefined, undefined, binder);
    expect(findings).toEqual([
      expect.objectContaining({ kind: "unbound", failure: { reason: "kind-only", at: "languages[1]" } }),
    ]);
  });

  it("compares a model located by !module-path as written, rather than skipping it", () => {
    const located = (name: string, code: string) =>
      ({ ...language(name, code), data: makeTaggedSentinel("module-path", `./${name}`) }) as unknown as ResourceManifest;
    const binder = binderOver([located("eng", "eng"), located("invoices", "eng")]);
    const findings = evaluateResourceRules(recognizer("eng", "invoices"), schema, undefined, undefined, binder);
    expect(findings.every((f) => f.kind === "violation")).toBe(true);
  });

  it("reports rather than reading references as declarations when there is no binder", () => {
    const findings = evaluateResourceRules(recognizer("eng"), schema);
    expect(findings.map((f) => f.kind)).toEqual(["unbound"]);
  });

  /**
   * `resolve:` used to write every named pointer into the rewritten subject,
   * resolved or not — so an OMITTED optional collection became a key that exists
   * and holds nothing. `self.?relationships` then answered present, `.orValue([])`
   * yielded nothing, and a comprehension over it got a non-collection range: the
   * rule read as defective on exactly the manifests whose guard was right.
   */
  describe("an absent pointer stays absent", () => {
    const optionalSchema = {
      type: "object",
      properties: {
        languages: {
          type: "array",
          items: { "x-telo-ref": { kind: "std.Language", use: "dependency" } },
        },
        extras: {
          type: "array",
          items: { "x-telo-ref": { kind: "std.Language", use: "dependency" } },
        },
      },
      "x-telo-resource-rules": [
        {
          resolve: ["/languages", "/extras"],
          condition: cel(
            "self.languages.all(l, l.code != '') && self.?extras.orValue([]).all(e, e.code != '')",
          ),
          code: "EVERY_MODEL_CODED",
          message: "lists a model with no code",
        },
      ],
    };

    const recognizerWith = (extras?: string[]) =>
      ({
        kind: "std.Recognizer",
        metadata: { name: "recognizer" },
        languages: [ref("eng")],
        ...(extras ? { extras: extras.map(ref) } : {}),
      }) as unknown as ResourceManifest;

    it("evaluates, and answers as an explicitly empty collection does", () => {
      const binder = binderOver([language("eng", "eng")], optionalSchema);
      expect(
        evaluateResourceRules(recognizerWith(), optionalSchema, undefined, undefined, binder),
      ).toEqual([]);
      expect(
        evaluateResourceRules(recognizerWith([]), optionalSchema, undefined, undefined, binder),
      ).toEqual([]);
    });

    it("still reads the entries an omitting resource DOES declare", () => {
      const binder = binderOver([language("eng", "")], optionalSchema);
      expect(
        evaluateResourceRules(recognizerWith(), optionalSchema, undefined, undefined, binder).map(
          (f) => f.kind,
        ),
      ).toEqual(["violation"]);
    });
  });

  /**
   * The slot itself already reports `REFERENCE_KIND_MISMATCH` here, so the rule
   * would read fields off a shape it was never shown. It is not evaluated, and —
   * unlike every other way a binding fails — nothing is reported: coverage did
   * not vary invisibly, and a second diagnostic would blame the kind's author for
   * the manifest author's mistake.
   */
  it("is not evaluated over a declaration the slot refuses, and reports nothing", () => {
    const orientation = {
      kind: "std.OrientationModel",
      metadata: { name: "osd" },
    } as unknown as ResourceManifest;
    const binder = binderOver([orientation]);
    const findings = evaluateResourceRules(
      recognizer("osd"),
      schema,
      undefined,
      undefined,
      binder,
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: "unbound", failure: { reason: "kind-refused", at: "languages[0]" } }),
    ]);
    expect(
      reportResourceRules(
        recognizer("osd"),
        { kind: "Telo.Definition", metadata: { name: "Recognizer" } } as unknown as ResourceManifest,
        findings,
        false,
      ),
    ).toEqual([]);
  });

  it("refuses a resolve pointer the kind does not declare", () => {
    const bad = {
      ...schema,
      "x-telo-resource-rules": [{ ...schema["x-telo-resource-rules"][0], resolve: ["/models"] }],
    };
    const issues = validateResourceRuleDeclarations(
      { kind: "Telo.Definition", metadata: { name: "Recognizer" }, schema: bad } as unknown as ResourceManifest,
    );
    expect(issues.map((i) => i.path)).toEqual(["schema.x-telo-resource-rules[0].resolve[0]"]);
  });
});

/** `resolve:` pointers that cross a reference into what it names, a hop at a
 *  time, ranging over a collection with `*`. */
describe("resource rules — resolve across references", () => {
  const schemas: Record<string, Record<string, any>> = {
    "std.Form": {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { "x-telo-ref": { kind: "std.Field", use: "dependency" } }] },
        },
      },
      "x-telo-resource-rules": [
        {
          resolve: ["/fields/*/options/model"],
          in: "/fields",
          condition: cel("type(this) == string || this.options.model.code != 'bad'"),
          code: "MODEL_BAD",
          message: "a field's options read a bad model",
        },
      ],
    },
    "std.Field": {
      type: "object",
      properties: { options: { "x-telo-ref": { kind: "std.Options", use: "dependency" } } },
    },
    "std.Options": {
      type: "object",
      properties: { model: { "x-telo-ref": { kind: "std.Model", use: "dependency" } } },
    },
    "std.Model": { type: "object", properties: { code: { type: "string" } } },
  };
  const declarations = [
    { kind: "std.Field", metadata: { name: "f1" }, options: { __ref: true, kind: "std.Options", name: "o1" } },
    { kind: "std.Field", metadata: { name: "f2" }, options: { __ref: true, kind: "std.Options", name: "o2" } },
    { kind: "std.Options", metadata: { name: "o1" }, model: { __ref: true, kind: "std.Model", name: "good" } },
    { kind: "std.Options", metadata: { name: "o2" }, model: { __ref: true, kind: "std.Model", name: "bad" } },
    { kind: "std.Model", metadata: { name: "good" }, code: "good" },
    { kind: "std.Model", metadata: { name: "bad" }, code: "bad" },
  ] as unknown as ResourceManifest[];
  const byName = new Map(declarations.map((d) => [d.metadata!.name as string, d]));
  const binder = new PeerBinder({
    declarationOf: (r: ReferenceValue) => byName.get(r.name),
    refSlotsOf: (kind) => declaredReach(schemas[kind] ?? {}).references.map((r) => r.path),
    refSitesOf: (manifest, kind) =>
      new Map(
        reachSites(schemas[kind] ?? {}, manifest)
          .filter((site) => site.refs.length > 0)
          .map((site) => [
            site.path,
            { shape: site.refs[0]!.fieldPath, kinds: site.refs.flatMap((r) => r.slot.kinds) },
          ]),
      ),
  });
  const form = {
    kind: "std.Form",
    metadata: { name: "form" },
    fields: ["title", { __ref: true, kind: "std.Field", name: "f1" }, { __ref: true, kind: "std.Field", name: "f2" }],
  } as unknown as ResourceManifest;

  it("reads a declaration two references away, through every entry of a list", () => {
    const findings = evaluateResourceRules(form, schemas["std.Form"], undefined, undefined, binder, "std.Form");
    expect(findings.map((f) => [f.kind, "path" in f ? f.path : undefined])).toEqual([["violation", "fields[2]"]]);
  });

  it("accepts a pointer continuing past a slot into what the slot may hold", () => {
    const issues = validateResourceRuleDeclarations(
      { kind: "Telo.Definition", metadata: { name: "Form" }, schema: schemas["std.Form"] } as unknown as ResourceManifest,
      undefined,
      undefined,
      (kind) => (schemas[kind] ? [schemas[kind]!] : []),
    );
    expect(issues).toEqual([]);
    const misspelled = {
      ...schemas["std.Form"],
      "x-telo-resource-rules": [{ ...schemas["std.Form"]!["x-telo-resource-rules"][0], resolve: ["/fields/*/options/modl"] }],
    };
    const refused = validateResourceRuleDeclarations(
      { kind: "Telo.Definition", metadata: { name: "Form" }, schema: misspelled } as unknown as ResourceManifest,
      undefined,
      undefined,
      (kind) => (schemas[kind] ? [schemas[kind]!] : []),
    );
    expect(refused.map((i) => i.path)).toEqual(["schema.x-telo-resource-rules[0].resolve[0]"]);
  });
});

/** A pointer continuing through a collection whose entries only HOLD a
 *  reference walks into each entry, to the reference it names. */
describe("resource rules — resolve through entries holding a reference", () => {
  const schemas: Record<string, Record<string, any>> = {
    "std.Holder": {
      type: "object",
      properties: { table: { "x-telo-ref": { kind: "std.Table", use: "dependency" } } },
      "x-telo-resource-rules": [
        {
          resolve: ["/table/keys/*/references/table"],
          condition: cel("self.table.keys.all(n, self.table.keys[n].references.table.physical == 'authors')"),
          code: "KEY_ELSEWHERE",
          message: "a key references another table",
        },
      ],
    },
    "std.Table": {
      type: "object",
      properties: {
        physical: { type: "string" },
        keys: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              references: {
                type: "object",
                properties: { table: { "x-telo-ref": { kind: "std.Table", use: "schema" } } },
              },
            },
          },
        },
      },
    },
  };
  const table = (name: string, physical: string, keys: Record<string, string> = {}) =>
    ({
      kind: "std.Table",
      metadata: { name },
      physical,
      keys: Object.fromEntries(
        Object.entries(keys).map(([key, target]) => [key, { references: { table: { __ref: true, kind: "std.Table", name: target } } }]),
      ),
    }) as unknown as ResourceManifest;
  const binderFor = (declarations: ResourceManifest[]) => {
    const byName = new Map(declarations.map((d) => [d.metadata!.name as string, d]));
    return new PeerBinder({
      declarationOf: (r: ReferenceValue) => byName.get(r.name),
      refSlotsOf: (kind) => declaredReach(schemas[kind] ?? {}).references.map((r) => r.path),
      refSitesOf: (manifest, kind) =>
        new Map(
          reachSites(schemas[kind] ?? {}, manifest)
            .filter((site) => site.refs.length > 0)
            .map((site) => [site.path, { shape: site.refs[0]!.fieldPath, kinds: site.refs.flatMap((r) => r.slot.kinds) }]),
        ),
    });
  };
  const holder = { kind: "std.Holder", metadata: { name: "holder" }, table: { __ref: true, kind: "std.Table", name: "posts" } } as unknown as ResourceManifest;
  const evaluate = (target: string) =>
    evaluateResourceRules(
      holder,
      schemas["std.Holder"],
      undefined,
      undefined,
      binderFor([table("posts", "posts", { author: target }), table("authors", "authors"), table("editors", "editors")]),
      "std.Holder",
    ).map((f) => f.kind);

  it("reads the declaration each entry's reference names", () => {
    expect(evaluate("authors")).toEqual([]);
    expect(evaluate("editors")).toEqual(["violation"]);
  });
});
