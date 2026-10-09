import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { kindCelEvalSites } from "../src/eval-paths.js";
import { PeerBinder } from "../src/peer-binding.js";
import { RuleDeclarationViews } from "../src/rule-declaration-view.js";
import { evaluateResourceRules, reportResourceRules } from "../src/validate-resource-rules.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A rule reads an `x-telo-eval: accessor` field as its binding — `{ root, path }`
 *  for a chain, `{ value }` for a literal — in every declaration it binds. */

const cel = (source: string) => makeTaggedSentinel("cel", source);
const ref = (name: string) => makeTaggedSentinel("ref", name);
const doc = (value: unknown) => value as ResourceManifest;

const rowContext = {
  type: "object",
  properties: { row: { type: "object", additionalProperties: true } },
};

const library = doc({ kind: "Telo.Library", metadata: { name: "Own", source: "own.yaml" } });

const definition = (name: string, schema: Record<string, unknown>) =>
  doc({
    kind: "Telo.Definition",
    metadata: { name, module: "Own", source: "own.yaml" },
    capability: "Telo.Runnable",
    controllers: [`pkg:telo/local/js?path=./x.mjs#${name}`],
    schema: { type: "object", additionalProperties: false, ...schema },
  });

const action = definition("Action", {
  properties: {
    lists: {
      type: "array",
      items: {
        type: "object",
        properties: { rows: { "x-telo-eval": "accessor" } },
        "x-telo-context": {
          type: "object",
          properties: { result: { type: "object", additionalProperties: true } },
        },
      },
    },
  },
  "x-telo-referrer-rules": [
    {
      referrer: "Self.Table",
      peers: "/rowActions",
      condition: cel("entry.inputs.id.path == ['id']"),
      code: "INPUT_NAMES_ID",
      message: "must bind the id input to the row's id.",
    },
  ],
});

const table = definition("Table", {
  properties: {
    sort: { "x-telo-eval": "accessor", "x-telo-context": rowContext },
    // No reference slot, so an inline declaration here is left in place.
    preview: { type: "object" },
    rowActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { "x-telo-ref": { kind: "Self.Action", use: "dependency" } },
          inputs: {
            type: "object",
            additionalProperties: { "x-telo-eval": "accessor" },
            "x-telo-context": rowContext,
          },
          note: { type: "string", "x-telo-eval": "compile" },
        },
      },
    },
  },
  "x-telo-resource-rules": [
    {
      condition: cel("!has(self.sort) || !has(self.sort.root) || self.sort.path == ['id']"),
      code: "SORT_NAMES_ID",
      message: "sorts by something other than the id.",
    },
    {
      condition: cel("!has(self.sort) || !has(self.sort.value)"),
      code: "SORT_IS_LITERAL",
      message: "sorts by a literal.",
    },
    {
      condition: cel("!has(self.preview) || self.preview.lists[0].rows.root == 'row'"),
      code: "PREVIEW_READS_ROW",
      message: "previews an action whose list is not read from the row.",
    },
    {
      resolve: ["/rowActions"],
      in: "/rowActions",
      condition: cel("!has(this.action.lists) || size(this.action.lists) == 0"),
      code: "ROW_ACTION_DRAWS_LISTS",
      message: "offers in a row an action that draws lists.",
    },
  ],
});

const drawing = doc({
  kind: "Own.Action",
  metadata: { name: "drawing" },
  lists: [{ rows: cel("result.files") }],
});

const plain = doc({ kind: "Own.Action", metadata: { name: "plain" } });

const tableOf = (config: Record<string, unknown>) =>
  doc({ kind: "Own.Table", metadata: { name: "rows" }, ...config });

const ruleReports = (...resources: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions([library, action, table, ...resources]))
    .filter((d) => /^(RESOURCE|REFERRER)_RULE_(VIOLATED|SKIPPED|INVALID)$/.test(String(d.code)))
    .map((d) => {
      const data = d.data as { rule?: string; path?: string };
      const dynamicAt = /a value at '([^']+)'|at '([^']+)', which is not known/.exec(d.message);
      return {
        code: d.code,
        rule: data.rule,
        path: data.path,
        ...(d.code?.toString().endsWith("_SKIPPED")
          ? { dynamicAt: dynamicAt?.[1] ?? dynamicAt?.[2] }
          : {}),
      };
    });

describe("a rule reads an accessor field as its binding", () => {
  it("sees a chain as { root, path } and evaluates", () => {
    expect(ruleReports(tableOf({ sort: cel("row.name") }))).toEqual([
      { code: "RESOURCE_RULE_VIOLATED", rule: "SORT_NAMES_ID", path: undefined },
    ]);
  });

  it("sees a literal as { value }", () => {
    expect(ruleReports(tableOf({ sort: 5 }))).toEqual([
      { code: "RESOURCE_RULE_VIOLATED", rule: "SORT_IS_LITERAL", path: undefined },
    ]);
  });

  it("binds a resolved collection whose entries and declarations hold chains", () => {
    expect(
      ruleReports(
        drawing,
        tableOf({ rowActions: [{ action: ref("drawing"), inputs: { id: cel("row.id") } }] }),
      ),
    ).toEqual([
      { code: "RESOURCE_RULE_VIOLATED", rule: "ROW_ACTION_DRAWS_LISTS", path: "rowActions[0]" },
    ]);
  });

  it("still skips for an evaluated expression beside the accessor, naming its path", () => {
    expect(
      ruleReports(
        plain,
        tableOf({
          rowActions: [
            { action: ref("plain"), inputs: { id: cel("row.id") }, note: cel("variables.note") },
          ],
        }),
      ),
    ).toEqual([
      {
        code: "REFERRER_RULE_SKIPPED",
        rule: "INPUT_NAMES_ID",
        path: "rowActions[0].action",
        dynamicAt: "rowActions[0].note",
      },
      {
        code: "RESOURCE_RULE_SKIPPED",
        rule: "ROW_ACTION_DRAWS_LISTS",
        path: "rowActions[0].note",
        dynamicAt: "rowActions[0].note",
      },
    ]);
  });

  it("still skips a rule reading an accessor that is not a plain chain", () => {
    const skipped = { code: "RESOURCE_RULE_SKIPPED", path: undefined, dynamicAt: "self.sort.value" };
    expect(ruleReports(tableOf({ sort: cel("row.a + row.b") }))).toEqual([
      { ...skipped, rule: "SORT_NAMES_ID" },
      { ...skipped, rule: "SORT_IS_LITERAL" },
    ]);
  });

  it("reads an inline declaration beneath it through the inline's own kind", () => {
    const preview = { kind: "Own.Action", lists: [{ rows: cel("result.files") }] };
    expect(ruleReports(tableOf({ preview }))).toEqual([
      { code: "RESOURCE_RULE_VIOLATED", rule: "PREVIEW_READS_ROW", path: undefined },
    ]);
  });

  it("gives a referrer rule's entry the same reading", () => {
    expect(
      ruleReports(
        plain,
        tableOf({ rowActions: [{ action: ref("plain"), inputs: { id: cel("row.name") } }] }),
      ),
    ).toEqual([
      { code: "REFERRER_RULE_VIOLATED", rule: "INPUT_NAMES_ID", path: "rowActions[0].action" },
    ]);
  });
});

// No rule pass binds a template body's entry today, so the reading is pinned
// where it is made: the view, and a rule evaluated through it.
describe("an accessor field of a template body's entry", () => {
  const sorted = definition("Sorted", {
    properties: { sort: { "x-telo-eval": "accessor", "x-telo-context": rowContext } },
    "x-telo-resource-rules": [
      {
        condition: cel("!has(self.sort.root)"),
        code: "SORT_IS_A_CHAIN",
        message: "names a member of the row.",
      },
      {
        condition: cel("has(self.sort.root) || self.sort.value != 'id'"),
        code: "SORT_VALUE_IS_ID",
        message: "sorts by the literal id.",
      },
    ],
  }) as ResourceManifest & { schema: Record<string, unknown> };
  const sites = kindCelEvalSites(sorted as never, () => undefined);
  const views = new RuleDeclarationViews(() => ({ sites, bodyEntry: true }));
  const binder = new PeerBinder({
    declarationOf: () => undefined,
    refSlotsOf: () => undefined,
    refSitesOf: () => undefined,
    viewOf: (declaration) => views.of(declaration),
  });
  const read = (sort: unknown) => {
    const entry = doc({ kind: "Own.Sorted", metadata: { name: "inner" }, sort });
    const findings = evaluateResourceRules(entry, sorted.schema, undefined, undefined, binder);
    return {
      sort: (views.of(entry) as unknown as { sort: unknown }).sort,
      reports: reportResourceRules(entry, sorted, findings, true).map((r) => [r.code, r.rule]),
    };
  };

  it("reads an expression over `self` alone as a literal of unknown value", () => {
    const written = cel("self.x");
    expect(read(written)).toEqual({
      sort: { value: written },
      // The rule over the wrapper's shape ran and held; the one reading the
      // inner value did not run.
      reports: [["RESOURCE_RULE_SKIPPED", "SORT_VALUE_IS_ID"]],
    });
  });

  it("still reads a chain rooted at a binding as { root, path }", () => {
    expect(read(cel("row.x"))).toEqual({
      sort: { root: "row", path: ["x"] },
      reports: [["RESOURCE_RULE_VIOLATED", "SORT_IS_A_CHAIN"]],
    });
  });
});
