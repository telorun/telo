import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeKeyCosts, observeRelationParity, type RelationParityReport } from "../src/cel-site-judgements.js";
import {
  careIdentityNested,
  flagSequenceInTry,
  forwardedSequence,
  forwardedSequenceNested,
  generatedCorpus,
  loadGenerated,
  mergedPlaceViews,
  nameReadPadding,
  rulePadding,
  catalogSetPadding,
  zonePadding,
  valueSchemaCrossing,
  referentPadding,
  referentPaddingFlaggedOutput,
  relationPadding,
  derivedEntryChoice,
  derivedEntrySibling,
  dispatchDerivedInput,
  valueSchemaCrossingFit,
  matchShapeChoice,
  kindDocumentReferentChoice,
  nestedConsumers,
  RUN,
  scopeMemberCrossing,
  scopeMemberOnwardCrossing,
  scopeMemberMisspelled,
  scopePadding,
  topLevelCrossing,
  viewOnlyStatus,
  shiftedConsumerName,
  drawnOutOrder,
  nestedInlinePlaces,
  SWEPT_CHOICES,
} from "./configuration-cost-fixtures.js";
import { fileCorpus, loadFile, ROOT } from "./configuration-corpus.js";

/**
 * The relation census and the region parts, held at every configuration of
 * every corpus fixture and at every forced branch no configuration takes to
 * what normalizing each declaration whole gives there: the census holds
 * exactly the anchors a group's enumeration of the whole finds, each anchor's
 * and read place's region normalized on its own is the whole normalization
 * restricted to it, and each relation instance finds the same judged on the
 * regions its key reads with its own group's nested anchors carved out as on
 * the same regions whole — and each CEL site and own-check site finds the same
 * judged in its key's environment (its module's globals base, the entries its
 * classes narrow laid over it) as on its declarations normalized whole with the
 * module documents whole, and every key reaching a declaration by name finds
 * the same with that declaration whole as with the parts it holds of it.
 */
const SRC = join(ROOT, "analyzer/nodejs/src");

/** Kind-document anchors inside a declaration's options, an inline
 *  declaration left in place in a step under an option, a step and a boot
 *  target under options passing an argument their target's contract refuses,
 *  and a template definition whose `result:` misses its own output contract;
 *  without `choices`, the same declarations with every option taken. */
function relationFixture(choices: boolean): string {
  return [
    "kind: Telo.Application",
    "metadata: { name: RelationCensus }",
    "imports:",
    `  Run: ${RUN}`,
    "variables:",
    "  flag1: { env: FLAG_1, type: boolean, default: false }",
    "  flag2: { env: FLAG_2, type: boolean, default: false }",
    "targets:",
    "  - !ref main",
    ...(choices
      ? ["  - !if", '    if: !cel "variables.flag1"', "    then: { invoke: !ref taker, inputs: { b: 2 } }"]
      : ["  - { invoke: !ref taker, inputs: { b: 2 } }"]),
    "---",
    "kind: Run.Value",
    "metadata: { name: taker }",
    "inputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, additionalProperties: false, properties: { a: { type: integer } } }",
    "value: 1",
    "---",
    "kind: Run.Value",
    "metadata: { name: shaped }",
    ...(choices
      ? ["outputType: !if", '  if: !cel "variables.flag1"', "  then:"]
      : ["outputType:"]),
    `${choices ? "    " : "  "}kind: Telo.JsonSchema`,
    `${choices ? "    " : "  "}schema: { type: object, properties: { a: { type: integer } } }`,
    "value: { a: 1 }",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: main }",
    "with:",
    "  - kind: Run.Value",
    "    metadata: { name: first }",
    "    value: 0",
    ...(choices
      ? [
          "  - !if",
          '    if: !cel "variables.flag2"',
          "    then:",
          "      kind: Run.Value",
          "      metadata: { name: inner }",
          "      outputType:",
          "        kind: Telo.JsonSchema",
          "        schema: { type: object }",
          "      value: {}",
        ]
      : [
          "  - kind: Run.Value",
          "    metadata: { name: inner }",
          "    outputType:",
          "      kind: Telo.JsonSchema",
          "      schema: { type: object }",
          "    value: {}",
        ]),
    "steps:",
    "  - name: s",
    "    value: 1",
    ...(choices
      ? ["  - !if", '    if: !cel "variables.flag1"', "    then:", "      invoke: { kind: Run.Value, valu: 1 }"]
      : ["  - invoke: { kind: Run.Value, valu: 1 }"]),
    ...(choices
      ? ["  - !if", '    if: !cel "variables.flag2"', "    then: { name: call, invoke: !ref taker, inputs: { b: 1 } }"]
      : ["  - { name: call, invoke: !ref taker, inputs: { b: 1 } }"]),
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapped }",
    "capability: Telo.Invocable",
    "outputType:",
    "  kind: Telo.JsonSchema",
    "  schema: { type: object, properties: { a: { type: integer } } }",
    "resources:",
    "  - kind: Run.Value",
    "    metadata: { name: inner }",
    "    value: 1",
    "invoke: !ref inner",
    'result: { a: "text" }',
    "",
  ].join("\n");
}

async function parity(loaded: Awaited<ReturnType<typeof loadFile>>): Promise<RelationParityReport[]> {
  const reports: RelationParityReport[] = [];
  const stop = observeRelationParity((report) => reports.push(report));
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return reports;
}

/** What the relational groups judged per instance report in the fixture. */
const RELATIONAL_CODES = new Set(["TEMPLATE_TARGET_MISMATCH", "SCHEMA_VIOLATION", "CONTRACT_INPUTS_MISMATCH"]);

function mismatches(reports: readonly RelationParityReport[]): string[] {
  return reports.flatMap((r) => [...r.census, ...r.regions, ...r.carves, ...r.observed, ...r.byName].map((m) => `${r.witness}: ${m}`));
}

describe("relation census and region parity", () => {
  let anchors = 0;
  const keySites = { cel: 0, own: 0, views: 0 };
  for (const file of fileCorpus()) {
    it(file, async () => {
      const reports = await parity(await loadFile(join(ROOT, file)));
      anchors += reports.reduce((n, r) => n + r.anchors, 0);
      for (const r of reports) {
        keySites.cel += r.keySites.cel;
        keySites.own += r.keySites.own;
        keySites.views += r.keySites.views;
      }
      expect(mismatches(reports)).toEqual([]);
    }, 120_000);
  }
  for (const [name, text] of generatedCorpus(SWEPT_CHOICES)) {
    it(`generated ${name}`, async () => {
      const reports = await parity(await loadGenerated(name, text));
      expect(mismatches(reports)).toEqual([]);
    }, 120_000);
  }
  // Steps nested in one `try:` step: each a step-inputs anchor beneath the
  // compound step's own, which its key reads carved.
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    it(`generated flag-sequence-in-try-${n}.yaml (parity only)`, async () => {
      const reports = await parity(await loadGenerated(`flag-sequence-in-try-${n}.yaml`, flagSequenceInTry(n)));
      expect(mismatches(reports)).toEqual([]);
    }, 120_000);
  }
  // A consumer's steps forwarded into a template body's sequence: each CEL
  // site a view holds is keyed on the view's regions.
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    it(`generated forwarded-sequence-${n}.yaml (parity only)`, async () => {
      const reports = await parity(await loadGenerated(`forwarded-sequence-${n}.yaml`, forwardedSequence(n)));
      keySites.views += reports.reduce((sum, r) => sum + r.keySites.views, 0);
      expect(mismatches(reports)).toEqual([]);
    }, 120_000);
  }
  // Sites sharing one written place, an exact forward among them crossing into
  // referents that hold a choice: each view's CEL site keyed on its regions.
  it("generated merged-place-views.yaml (parity only)", async () => {
    const reports = await parity(await loadGenerated("merged-place-views.yaml", mergedPlaceViews()));
    keySites.views += reports.reduce((sum, r) => sum + r.keySites.views, 0);
    expect(mismatches(reports)).toEqual([]);
  }, 120_000);
  // Consumers written beneath a declaration — inline at a step's target, as a
  // `with:` member — whose views are new routes into every key their sites read.
  const nested: Array<[string, string]> = [
    ["nested-consumers.yaml", nestedConsumers()],
    ["care-identity-nested.yaml", careIdentityNested()],
    ["scope-member-crossing.yaml", scopeMemberCrossing(false)],
    ["scope-member-crossing-shadowed.yaml", scopeMemberCrossing(true)],
    ["top-level-crossing.yaml", topLevelCrossing()],
    ["scope-member-onward-crossing.yaml", scopeMemberOnwardCrossing(false)],
    ["scope-member-onward-crossing-top-level.yaml", scopeMemberOnwardCrossing(true)],
    ["scope-padding.yaml", scopePadding(2)],
    ["scope-member-misspelled.yaml", scopeMemberMisspelled()],
    ["view-only-status.yaml", viewOnlyStatus()],
    ["shifted-consumer-name.yaml", shiftedConsumerName()],
    ["drawn-out-order.yaml", drawnOutOrder()],
    ["nested-inline-places.yaml", nestedInlinePlaces(false)],
    ["nested-inline-places-lead.yaml", nestedInlinePlaces(true)],
    ["nested-inline-places-named.yaml", nestedInlinePlaces(false, true)],
    ["name-read-padding.yaml", nameReadPadding(0)],
    ["rule-padding.yaml", rulePadding(0)],
    ["catalog-set-padding.yaml", catalogSetPadding(0)],
    ["zone-padding.yaml", zonePadding(0)],
    ["value-schema-crossing.yaml", valueSchemaCrossing()],
    ["referent-padding.yaml", referentPadding(0)],
    ["referent-padding-flagged-output.yaml", referentPaddingFlaggedOutput(0)],
    ["relation-padding.yaml", relationPadding(0)],
    ["derived-entry-choice.yaml", derivedEntryChoice()],
    ["derived-entry-sibling.yaml", derivedEntrySibling()],
    ["dispatch-derived-input.yaml", dispatchDerivedInput()],
    ["value-schema-crossing-fit.yaml", valueSchemaCrossingFit()],
    ["match-shape-choice.yaml", matchShapeChoice()],
    ["kind-document-referent-choice.yaml", kindDocumentReferentChoice()],
    ...(["inline", "with"] as const).flatMap((form) =>
      [1, 2, 3].map((n): [string, string] => [`forwarded-sequence-${form}-${n}.yaml`, forwardedSequenceNested(n, form)]),
    ),
  ];
  for (const [name, text] of nested) {
    it(`generated ${name} (parity only)`, async () => {
      const reports = await parity(await loadGenerated(name, text));
      keySites.views += reports.reduce((sum, r) => sum + r.keySites.views, 0);
      expect(mismatches(reports)).toEqual([]);
    }, 120_000);
  }
  it("compares anchors, CEL sites, own-check sites and a view's CEL sites somewhere in the corpus", () => {
    expect(anchors).toBeGreaterThan(0);
    expect(keySites.cel).toBeGreaterThan(0);
    expect(keySites.own).toBeGreaterThan(0);
    expect(keySites.views).toBeGreaterThan(0);
  });
  // Anchors only an option inside a declaration holds — one in a field, one in
  // a scope list item — which the census finds by a region run of their own,
  // and a template definition's entry point, whose key reads its dispatch
  // target by place.
  it("holds anchors inside a declaration's options, and judges them as a plain analysis does", async () => {
    const reports = await parity(await loadGenerated("relation-census-options.yaml", relationFixture(true)));
    expect(mismatches(reports)).toEqual([]);
    const by: Record<string, number> = {};
    for (const r of reports) for (const [g, n] of Object.entries(r.anchorsByGroup)) by[g] = (by[g] ?? 0) + n;
    for (const group of ["annotations", "templateTargets", "nested", "stepInputs", "slotInputs"]) expect(by[group]).toBeGreaterThan(0);
    const found = async (name: string, text: string) => {
      const loaded = await loadGenerated(name, text);
      return new StaticAnalyzer()
        .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
        .filter((d) => RELATIONAL_CODES.has(d.code as string))
        .map((d) => [d.code, d.message.replace(/ \(when [^)]*\)$/, ""), (d.data as { path?: string }).path]);
    };
    const keyed = await found("relation-census-options.yaml", relationFixture(true));
    const plain = await found("relation-census-plain.yaml", relationFixture(false));
    // Where each finding is written, once, its branch's `then` aside: a
    // message quotes the place its configuration projects, and the merge
    // reports a finding two groups make at one place once.
    const placed = (found: unknown[][]) =>
      [...new Set(found.map(([code, , path]) => `${code} ${String(path).replace(/\.then(?=\.|$)/g, "")}`))].sort();
    expect(placed(keyed)).toEqual(placed(plain));
    expect(placed(keyed)).toEqual([
      "CONTRACT_INPUTS_MISMATCH steps[2].inputs",
      "CONTRACT_INPUTS_MISMATCH targets[1].inputs",
      "SCHEMA_VIOLATION steps[1]",
      "SCHEMA_VIOLATION steps[1].invoke.value",
      "SCHEMA_VIOLATION steps[1].name",
      "TEMPLATE_TARGET_MISMATCH result.a",
    ]);
  }, 120_000);
});

/** A step whose target is declared only where a flag holds: the step exists in
 *  every configuration, its target resolving in one of them. */
const TARGET_PRESENCE = [
  "kind: Telo.Application",
  "metadata: { name: StepTargetPresence }",
  "imports:",
  `  Run: ${RUN}`,
  "variables:",
  "  flag1: { env: FLAG_1, type: boolean, default: false }",
  "targets:",
  "  - !ref main",
  "--- !if",
  "metadata: { name: target }",
  'if: !cel "variables.flag1"',
  "then:",
  "  kind: Run.Value",
  "  inputType: { kind: Telo.JsonSchema, schema: { type: object, additionalProperties: false } }",
  "  value: 1",
  "---",
  "kind: Run.Sequence",
  "metadata: { name: main }",
  "steps:",
  "  - name: call",
  "    invoke: !ref target",
  "    inputs: { x: 1 }",
  "",
].join("\n");

describe("a relation site reading a reference", () => {
  // What a reference resolves to is a read wherever it resolves: a key read
  // where the target is absent must not stand for where it is declared.
  it("is keyed by what its target resolves to, where it resolves to nothing too", async () => {
    const loaded = await loadGenerated("relation-target-presence.yaml", TARGET_PRESENCE);
    const found = new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => d.code === "CONTRACT_INPUTS_MISMATCH")
      .map((d) => [(d.data as { path?: string }).path, d.message]);
    expect(found).toEqual([
      [
        "steps[0].inputs",
        "Run.Sequence/main: inputs at 'steps[0].inputs' do not satisfy target's declared inputType: / must NOT have additional properties ('x' is not allowed) (when variables.flag1 is true)",
      ],
    ]);
  }, 120_000);
});

describe("a template's top-level inputs", () => {
  /** The keys judged for `Wrapper`'s `inputs:` relation. */
  const inputsKeys = async (name: string, text: string): Promise<number> => {
    const loaded = await loadGenerated(name, text);
    let keys = 0;
    const stop = observeKeyCosts((cost) => {
      if (cost.kind !== "door-nodes" || cost.family !== "relation") return;
      const [, group, , declaration, , path] = JSON.parse(cost.site) as unknown[];
      if (group === "templateTargets" && declaration === "Wrapper" && path === "inputs") keys++;
    });
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    return keys;
  };
  // The read set depends on which entry is dispatched: only that entry's
  // referent splits its key.
  it("is keyed by the input contract of the entry it dispatches, and no other", async () => {
    expect(await inputsKeys("derived-entry-choice.yaml", derivedEntryChoice())).toBe(2);
    expect(await inputsKeys("derived-entry-sibling.yaml", derivedEntrySibling())).toBe(1);
  }, 120_000);
});

describe("a forward view's relation sites", () => {
  /** The most keys any relation site of a fixture holds, and the most nodes
   *  one key normalizes. */
  const keysPerSite = async (name: string, text: string): Promise<{ keys: number; nodes: number }> => {
    const loaded = await loadGenerated(name, text);
    const keys = new Map<string, number>();
    let nodes = 0;
    const stop = observeKeyCosts((cost) => {
      if (cost.kind !== "door-nodes" || cost.family !== "relation") return;
      keys.set(cost.site, (keys.get(cost.site) ?? 0) + 1);
      nodes = Math.max(nodes, cost.nodes);
    });
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    return { keys: Math.max(0, ...keys.values()), nodes };
  };
  // The views are census declarations: a view's relation instances are keyed
  // by what they read, so a consumer's choices split no more keys than the
  // consumer's own sites hold, written at the top level or as a scope member.
  it("hold at most the keys a consumer's own sites hold", async () => {
    const top = await keysPerSite("forwarded-sequence-8.yaml", forwardedSequence(8));
    expect(top.keys).toBeLessThanOrEqual(2);
    const member = await keysPerSite("forwarded-sequence-with-8.yaml", forwardedSequenceNested(8, "with"));
    expect(member.keys).toBeLessThanOrEqual(2);
    expect(member.nodes).toBeLessThanOrEqual(top.nodes);
    // Written inline as a step's target, the consumer is a declaration of its
    // own kind: its holder's relation checks read the reference left in its place.
    const inline = await keysPerSite("forwarded-sequence-inline-8.yaml", forwardedSequenceNested(8, "inline"));
    expect(inline.keys).toBeLessThanOrEqual(top.keys);
  }, 600_000);
});

describe("a kind document's own key", () => {
  // A body entry naming a module declaration reads what the reference resolves
  // to, never that declaration whole: a member nothing reads splits no key.
  it("holds a declaration its body names as what the reference resolves to", async () => {
    const loaded = await loadGenerated("kind-document-referent-choice.yaml", kindDocumentReferentChoice());
    const keys = new Map<string, number>();
    const stop = observeKeyCosts((cost) => {
      if (cost.kind !== "door-nodes" || cost.family !== "schema") return;
      const [, declaration] = JSON.parse(cost.site) as unknown[];
      if (declaration === "Holder") keys.set(cost.site, (keys.get(cost.site) ?? 0) + 1);
    });
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    expect(keys.size).toBeGreaterThan(0);
    expect([...keys.values()].every((n) => n === 1)).toBe(true);
  }, 120_000);
});

describe("the scopes on the way to a site", () => {
  /** Each family's keys and their door nodes at every site of `holder` a
   *  region of `padded` does not hold: neither in it nor its declaration's
   *  root. */
  const outside = async (p: number): Promise<Record<string, string>> => {
    const loaded = await loadGenerated(`scope-padding-${p}.yaml`, scopePadding(p));
    const sites: Record<string, string[]> = {};
    const stop = observeKeyCosts((cost) => {
      if (cost.kind !== "door-nodes") return;
      const id = JSON.parse(cost.site) as unknown[];
      const [name, path] = id[0] === "relation" ? [id[3], id[5]] : [id[1], id[3]];
      const text = Array.isArray(path) ? path.join(".") : String(path);
      if (name !== "holder" || text === "" || text.startsWith("with[1]") || text.startsWith("with.1")) return;
      (sites[`${cost.family} ${text}`] ??= []).push(String(cost.nodes));
    });
    try {
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
    } finally {
      stop();
    }
    return Object.fromEntries(Object.entries(sites).map(([site, nodes]) => [site, nodes.join(",")]));
  };
  // A member nothing outside it reads is held as its identity alone: its
  // choices split no other site's key and grow no other site's door.
  it("holds a sibling scope member as its identity alone", async () => {
    const none = await outside(0);
    expect(Object.keys(none).length).toBeGreaterThan(0);
    expect(await outside(4)).toEqual(none);
  }, 120_000);
});

/** Compile `source` as `file` beside the sources, returning its messages. */
function compile(file: string, source: string, rootFile = file): string[] {
  const host = ts.createCompilerHost({});
  const read = host.readFile;
  host.readFile = (name) => (resolve(name) === resolve(file) ? source : read(name));
  const exists = host.fileExists;
  host.fileExists = (name) => resolve(name) === resolve(file) || exists(name);
  const program = ts.createProgram({
    rootNames: [rootFile],
    options: {
      noEmit: true,
      strict: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      customConditions: ["source"],
    },
    host,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file !== undefined && resolve(d.file.fileName) === resolve(file))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("the relation reader table", () => {
  it("refuses to compile a table missing a group's reader", () => {
    const file = join(SRC, "__relation-table-probe.ts");
    const source = [
      'import type { RelationReaderTable } from "./relation-sites.js";',
      'declare const partial: Omit<RelationReaderTable, "annotations">;',
      "export const table: RelationReaderTable = partial;",
    ].join("\n");
    expect(compile(file, source).some((m) => m.includes("annotations"))).toBe(true);
  }, 120_000);

  it("refuses to compile a rule input holding a declaration or a manifest list", () => {
    const file = join(SRC, "relation-sites.ts");
    const written = readFileSync(file, "utf8");
    const marker = "export interface RelationRuleInput {\n";
    expect(written).toContain(marker);
    expect(compile(file, written)).toEqual([]);
    for (const field of ["readonly declaration: ResourceManifest;", "readonly manifests: readonly ResourceManifest[];"]) {
      const widened = written.replace(marker, `${marker}  ${field}\n`);
      expect(compile(file, widened).some((m) => m.includes("'true' is not assignable"))).toBe(true);
    }
  }, 120_000);
});
