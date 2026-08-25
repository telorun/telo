import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { readResourceRules, resolveRuleSubjects, findDynamicLeaf } from "../src/resource-rule.js";
import {
  evaluateResourceRules,
  validateResourceRuleDeclarations,
} from "../src/validate-resource-rules.js";

/** Conditions are written with the `!cel` tag — the strict half reports one that
 *  is not, since untagged it stops being CEL to every surface but evaluation. */
const cel = (source: string) => makeTaggedSentinel("cel", source);

/** A table-shaped kind: a map of columns, a list of indexes, a list of foreign keys. */
const TABLE_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "object", additionalProperties: { type: "object" } },
    indexes: { type: "array", items: { type: "object" } },
    foreignKeys: { type: "array", items: { type: "object" } },
    ledger: { type: "string" },
  },
  "x-telo-resource-rules": [
    {
      in: "/indexes",
      condition: cel("this.columns.all(c, c in self.columns)"),
      code: "INDEX_UNKNOWN_COLUMN",
      message: "names a column this table does not declare",
    },
    {
      in: "/foreignKeys",
      condition: cel("size(this.columns) == size(this.references.columns)"),
      code: "FK_ARITY_MISMATCH",
      message: "lists a different number of columns on each side",
    },
    {
      in: "/columns",
      condition: cel('!(this.?renamedFrom.orValue("") in self.columns)'),
      code: "RENAME_SOURCE_STILL_DECLARED",
      message: "renames from a column this table still declares",
    },
  ],
};

const definition = (schema: unknown): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Table", module: "SQL" },
    capability: "Telo.Service",
    schema,
  }) as unknown as ResourceManifest;

const resource = (config: Record<string, unknown>): ResourceManifest =>
  ({ kind: "SQL.Table", metadata: { name: "orders" }, ...config }) as unknown as ResourceManifest;

const declarationMessages = (schema: unknown): string[] =>
  validateResourceRuleDeclarations(definition(schema)).map((i) => i.message);

describe("resource rules — evaluation", () => {
  it("reports the offending element, not the resource", () => {
    const findings = evaluateResourceRules(
      resource({
        columns: { id: {}, customer_id: {} },
        indexes: [{ columns: ["customer_id"] }, { columns: ["custmer_id"] }],
      }),
      TABLE_SCHEMA,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "violation",
      path: "indexes[1]",
      message: "names a column this table does not declare",
    });
  });

  it("correlates an element against itself, not against every other element", () => {
    const findings = evaluateResourceRules(
      resource({
        columns: { a: {}, b: {} },
        foreignKeys: [
          { columns: ["a"], references: { columns: ["x"] } },
          { columns: ["a", "b"], references: { columns: ["x"] } },
        ],
      }),
      TABLE_SCHEMA,
    );
    expect(findings.map((f) => f.path)).toEqual(["foreignKeys[1]"]);
  });

  it("anchors a map entry by its key", () => {
    const findings = evaluateResourceRules(
      resource({ columns: { mail: {}, email: { renamedFrom: "mail" } } }),
      TABLE_SCHEMA,
    );
    expect(findings.map((f) => f.path)).toEqual(["columns.email"]);
  });

  it("passes a declaration with nothing wrong", () => {
    expect(
      evaluateResourceRules(
        resource({ columns: { id: {} }, indexes: [{ columns: ["id"] }] }),
        TABLE_SCHEMA,
      ),
    ).toEqual([]);
  });

  it("reports the skip when an element holds CEL, per element rather than per rule", () => {
    const findings = evaluateResourceRules(
      resource({
        columns: { id: {} },
        indexes: [
          { columns: [{ __compiled: true, source: "variables.col" }] },
          { columns: ["nope"] },
        ],
      }),
      TABLE_SCHEMA,
    );
    // The dynamic element is skipped AND reported; the literal one is still checked.
    expect(findings.map((f) => [f.kind, f.path])).toEqual([
      ["skipped", "indexes[0]"],
      ["violation", "indexes[1]"],
    ]);
  });

  it("skips only when a node the CONDITION READS is dynamic", () => {
    // A resource-wide rule takes the whole resource as its subject, so scanning
    // the subject would disable it on any manifest holding one unrelated
    // expression — `version: !cel "module.version"` is the conventional
    // spelling, so that would be most of them.
    const schema = {
      ...TABLE_SCHEMA,
      properties: { ...TABLE_SCHEMA.properties, version: { type: "string" } },
      "x-telo-resource-rules": [
        {
          condition: cel('self.ledger != ""'),
          code: "LEDGER_EMPTY",
          message: "ledger name is empty",
        },
      ],
    };
    const withUnrelatedCel = resource({
      ledger: "",
      version: { __compiled: true, source: "module.version" },
    });
    expect(evaluateResourceRules(withUnrelatedCel, schema)).toMatchObject([
      { kind: "violation" },
    ]);

    const withReadCel = resource({
      ledger: { __compiled: true, source: "variables.ledger" },
    });
    expect(evaluateResourceRules(withReadCel, schema)).toMatchObject([{ kind: "skipped" }]);
  });

  it("reports a throwing rule as a defect in the rule, at no element's expense", () => {
    const findings = evaluateResourceRules(resource({ columns: { id: {} } }), {
      ...TABLE_SCHEMA,
      "x-telo-resource-rules": [
        {
          in: "/columns",
          condition: cel("self.nope.missing"),
          code: "BROKEN",
          message: "unreachable",
        },
      ],
    });
    expect(findings[0]).toMatchObject({ kind: "failed" });
    expect((findings[0] as { reason: string }).reason).toMatch(/No such key/);
  });

  it("evaluates the whole-resource form when `in:` is omitted", () => {
    const schema = {
      ...TABLE_SCHEMA,
      "x-telo-resource-rules": [
        {
          condition: cel('self.ledger != ""'),
          code: "LEDGER_EMPTY",
          message: "ledger name is empty",
          severity: "warning",
        },
      ],
    };
    expect(evaluateResourceRules(resource({ ledger: "" }), schema)).toMatchObject([
      { kind: "violation", path: "" },
    ]);
    expect(evaluateResourceRules(resource({ ledger: "telo_schema" }), schema)).toEqual([]);
  });

  it("says nothing about a collection the resource omits", () => {
    expect(evaluateResourceRules(resource({ columns: { id: {} } }), TABLE_SCHEMA)).toEqual([]);
  });
});

describe("resource rules — declaration validation", () => {
  it("accepts the table rules", () => {
    expect(declarationMessages(TABLE_SCHEMA)).toEqual([]);
  });

  it("rejects an `in:` the kind does not declare — the anchor must exist", () => {
    const found = declarationMessages({
      ...TABLE_SCHEMA,
      "x-telo-resource-rules": [
        { in: "/indices", condition: cel("true"), code: "C", message: "m" },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/does not declare/);
  });

  it("rejects an `in:` naming a scalar", () => {
    expect(
      declarationMessages({
        ...TABLE_SCHEMA,
        "x-telo-resource-rules": [{ in: "/ledger", condition: cel("true"), code: "C", message: "m" }],
      })[0],
    ).toMatch(/not a collection/);
  });

  it("rejects a host-backed function — the analyzer registers a throwing stub", () => {
    expect(
      declarationMessages({
        ...TABLE_SCHEMA,
        "x-telo-resource-rules": [
          { condition: cel('sha256(self.ledger) != ""'), code: "C", message: "m" },
        ],
      })[0],
    ).toMatch(/sha256\(\).*kernel supplies at boot/s);
  });

  it("rejects a non-deterministic function — a verdict that depends on when it ran", () => {
    expect(
      declarationMessages({
        ...TABLE_SCHEMA,
        "x-telo-resource-rules": [
          { condition: cel('nowIso("UTC") != ""'), code: "C", message: "m" },
        ],
      })[0],
    ).toMatch(/re-evaluates per call/);
  });

  it("rejects a duplicate rule code — data.rule would not tell them apart", () => {
    expect(
      declarationMessages({
        ...TABLE_SCHEMA,
        "x-telo-resource-rules": [
          { condition: cel("true"), code: "C", message: "m" },
          { condition: cel("true"), code: "C", message: "m" },
        ],
      })[0],
    ).toMatch(/already used by rule 0/);
  });

  it("requires condition, code and message", () => {
    expect(declarationMessages({ "x-telo-resource-rules": [{}] })).toHaveLength(3);
  });

  it("rejects a non-array annotation", () => {
    expect(declarationMessages({ "x-telo-resource-rules": { in: "/x" } })[0]).toMatch(
      /must be an array/,
    );
  });

  it("reads a precompiled !cel condition through its source", () => {
    const rules = readResourceRules({
      "x-telo-resource-rules": [
        {
          condition: { __compiled: true, source: "self.a == 1" },
          code: "C",
          message: "m",
        },
      ],
    });
    expect(rules[0]?.condition).toBe("self.a == 1");
  });
});

describe("resource rules — subject resolution", () => {
  it("yields one subject per array item and per map entry", () => {
    expect(resolveRuleSubjects({ a: [1, 2] }, "/a")).toEqual([
      { path: "a[0]", value: 1 },
      { path: "a[1]", value: 2 },
    ]);
    expect(resolveRuleSubjects({ a: { k: 1 } }, "/a")).toEqual([
      { path: "a.k", value: 1, key: "k" },
    ]);
  });

  it("distinguishes an absent collection from a scalar at the pointer", () => {
    expect(resolveRuleSubjects({}, "/a")).toEqual([]);
    expect(resolveRuleSubjects({ a: "scalar" }, "/a")).toBeUndefined();
  });

  it("finds a CEL leaf at any depth but stops at a nested kind", () => {
    expect(findDynamicLeaf({ a: { b: [{ __compiled: true }] } })).toEqual({
      path: "a.b[0]",
      what: "a CEL expression",
    });
    expect(findDynamicLeaf({ a: { kind: "X", b: { __compiled: true } } })).toBeUndefined();
  });

  // A `!ref` is a tagged sentinel like a `!cel`, and reading it as one switched
  // off every rule that touched a slot holding a reference — reporting a CEL
  // expression in a manifest containing none.
  it("reads a !ref sentinel as a value, not as an expression", () => {
    const ref = { __tagged: true, engine: "ref", source: "messageRole" };
    expect(findDynamicLeaf({ columns: { role: { type: ref } } })).toBeUndefined();
  });

  // The other deferred tags DO block a rule — their value is read at creation —
  // but the diagnostic has to name the tag rather than claim CEL.
  it("names the tag for a deferred embed", () => {
    const embed = { __tagged: true, engine: "include-bytes", source: "./logo.png" };
    expect(findDynamicLeaf({ icon: embed })).toEqual({
      path: "icon",
      what: "an !include-bytes embed",
    });
  });
});
