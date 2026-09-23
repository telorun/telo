import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { PeerBinder, type ReferenceValue } from "../src/peer-binding.js";
import {
  evaluateResourceRules,
  validateResourceRuleDeclarations,
} from "../src/validate-resource-rules.js";

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

const ref = (name: string) => ({ kind: "std.Language", name });

function binderOver(declarations: ResourceManifest[]): PeerBinder {
  const byName = new Map(declarations.map((d) => [d.metadata!.name as string, d]));
  return new PeerBinder({
    declarationOf: (r: ReferenceValue) => byName.get(r.name),
    refSlotsOf: () => ["languages[]"],
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
