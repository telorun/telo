import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeKeyCosts } from "../src/cel-site-judgements.js";
import { flagTargets, loadGenerated } from "./configuration-cost-fixtures.js";

/**
 * A sequence holding a contract that reaches a mark, a scope member, a
 * reference and `k` independent choices beside them — in its steps and inside
 * the member — each reading its own flag.
 */
function choicesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: PassReadingCost }",
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    "targets:",
    "  - !ref main",
    "---",
    "kind: Telo.JsonSchema",
    "metadata: { name: Credentials }",
    "schema:",
    "  type: object",
    "  properties:",
    "    token: { type: string, x-telo-sensitive: true }",
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: main }",
    "inputType: !ref Credentials",
    "targets:",
    "  - !ref other",
    "with:",
    "  - kind: Telo.JsonSchema",
    "    metadata: { name: Shape }",
    "    schema:",
    "      type: object",
    "      properties:",
    ...flags.flatMap((i) => [
      `        p${i}: !if`,
      `          if: !cel "variables.flag${i}"`,
      "          then: { type: string }",
      "          else: { type: integer }",
    ]),
    "steps:",
    ...flags.flatMap((i) => [
      `  - name: s${i}`,
      "    value: !if",
      `      if: !cel "variables.flag${i}"`,
      "      then: 1",
      "      else: 2",
    ]),
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: other }",
    "steps:",
    "  - { name: done, value: 1 }",
    "",
  ].join("\n");
}

/** How many readings each pass makes of the sequence, and how many keys its
 *  reference sites are judged under, at `k` choices. */
async function readingsOfMain(k: number): Promise<Record<string, number>> {
  const loaded = await loadGenerated(`pass-reading-cost-${k}.yaml`, choicesBeside(k));
  const counts: Record<string, number> = {};
  const stop = observeKeyCosts((cost) => {
    if (cost.kind === "relation") {
      const [, group, , name] = JSON.parse(cost.site) as unknown[];
      if (group === "references" && name === "main") counts.references = (counts.references ?? 0) + 1;
      return;
    }
    // The passes reading a region; throws reads per chain of options (below).
    if (cost.kind !== "pass-reading" || (cost.pass !== "markReach" && cost.pass !== "scopeMembers")) return;
    const declaration = cost.declaration as { manifest: { metadata?: { name?: unknown } } };
    if (declaration.manifest.metadata?.name !== "main") return;
    counts[cost.pass] = (counts[cost.pass] ?? 0) + 1;
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return counts;
}

describe("the passes over every configuration read a declaration per region", () => {
  it("a declaration holding k independent choices beside its contract, scope members and reference is read alike at k = 1, 2, 4, 8", async () => {
    const rows: Record<number, Record<string, number>> = {};
    for (const k of [1, 2, 4, 8]) rows[k] = await readingsOfMain(k);
    console.log(
      [
        "k  markReach  scopeMembers  references",
        ...Object.entries(rows).map(
          ([k, r]) => `${k.padEnd(2)} ${String(r.markReach).padStart(9)}  ${String(r.scopeMembers).padStart(12)}  ${String(r.references).padStart(10)}`,
        ),
      ].join("\n"),
    );
    for (const k of [2, 4, 8]) expect(rows[k]).toEqual(rows[1]);
  }, 600_000);
});

/** How many readings the call graph makes of each declaration of fixture S
 *  at `k` jobs. */
async function callGraphReadings(k: number): Promise<Record<string, number>> {
  const loaded = await loadGenerated(`pass-reading-call-graph-${k}.yaml`, flagTargets(k));
  const counts: Record<string, number> = {};
  const stop = observeKeyCosts((cost) => {
    if (cost.kind !== "graph-reading") return;
    const name = String((cost.declaration as { manifest: { metadata?: { name?: unknown } } }).manifest.metadata?.name);
    counts[name] = (counts[name] ?? 0) + 1;
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return counts;
}

describe("the call graph over every configuration reads a declaration once per chain of its options", () => {
  it("fixture S's application and guard, each holding one choice per job, are read k + 1 times at k = 1, 2, 4, 8", async () => {
    const rows: Record<number, Record<string, number>> = {};
    for (const k of [1, 2, 4, 8]) rows[k] = await callGraphReadings(k);
    console.log(
      [
        "k  application  guard  a  b  job1",
        ...Object.entries(rows).map(
          ([k, r]) => `${k.padEnd(2)} ${String(r.FlagTargets).padStart(11)}  ${String(r.guard).padStart(5)}  ${r.a}  ${r.b}  ${r.job1}`,
        ),
      ].join("\n"),
    );
    for (const k of [1, 2, 4, 8]) {
      expect(rows[k]!.FlagTargets).toBe(k + 1);
      expect(rows[k]!.guard).toBe(k + 1);
      // The two functions each hold one choice; every job is declared under one.
      expect([rows[k]!.a, rows[k]!.b, rows[k]!.job1]).toEqual(rows[1] ? [rows[1].a, rows[1].b, rows[1].job1] : []);
    }
  }, 600_000);
});

const ZONE_KINDS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations/zones/kinds");

/**
 * A transaction whose body invokes `k` operations, step k choosing its
 * operation by `flagK`, each operation's session — the place its zone
 * requirement correlates past — chosen by the same flag.
 */
function zonesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: ZoneReadingCost }",
    `imports: { Z: ${ZONE_KINDS} }`,
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    "targets:",
    "  - invoke: !ref main",
    "---",
    "kind: Z.Conn",
    "metadata: { name: primary }",
    "---",
    "kind: Z.Conn",
    "metadata: { name: replica }",
    "---",
    "kind: Z.Session",
    "metadata: { name: session }",
    "connection: !ref primary",
    "---",
    "kind: Z.Session",
    "metadata: { name: stray }",
    "connection: !ref replica",
    "---",
    "kind: Z.Tx",
    "metadata: { name: main }",
    "connection: !ref primary",
    "steps: !ref body",
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: other }",
    "steps:",
    "  - { name: done, value: 1 }",
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: body }",
    "steps:",
    ...flags.flatMap((i) => [
      `  - name: s${i}`,
      "    invoke: !if",
      `      if: !cel "variables.flag${i}"`,
      `      then: !ref op${i}`,
      "      else: !ref other",
    ]),
    ...flags.flatMap((i) => [
      "---",
      "kind: Z.Op",
      `metadata: { name: op${i} }`,
      "session: !if",
      `  if: !cel "variables.flag${i}"`,
      "  then: !ref stray",
      "  else: !ref session",
    ]),
    "",
  ].join("\n");
}

/** How many visits the zone requirement pass makes of each declaration, and
 *  the findings it reports, at `k` choices. */
async function zoneVisits(k: number): Promise<Record<string, number>> {
  const loaded = await loadGenerated(`pass-reading-zones-${k}.yaml`, zonesBeside(k));
  const counts: Record<string, number> = {};
  const stop = observeKeyCosts((cost) => {
    if (cost.kind !== "pass-reading" || cost.pass !== "zoneRequirements") return;
    const name = String((cost.declaration as { manifest: { metadata?: { name?: unknown } } }).manifest.metadata?.name);
    counts[name] = (counts[name] ?? 0) + 1;
  });
  let found: ReturnType<StaticAnalyzer["analyze"]>;
  try {
    found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  counts.findings = found.filter((d) => d.code === "ZONE_REQUIREMENT_UNSATISFIED").length;
  return counts;
}

describe("zone requirements over every configuration visit a declaration once per requirement and choice", () => {
  it("a body of k steps, each choosing an operation and its correlation by its own flag, is visited linearly at k = 1, 2, 4, 8", async () => {
    const rows: Record<number, Record<string, number>> = {};
    for (const k of [1, 2, 4, 8]) rows[k] = await zoneVisits(k);
    console.log(
      [
        "k  body  main  op1  findings",
        ...Object.entries(rows).map(([k, r]) => `${k.padEnd(2)} ${String(r.body).padStart(4)}  ${String(r.main).padStart(4)}  ${String(r.op1).padStart(3)}  ${r.findings}`),
      ].join("\n"),
    );
    for (const name of ["body", "main", "op1", "findings"]) {
      const at = (k: number) => rows[k]![name] ?? 0;
      expect(at(8) - at(4), name).toBe(2 * (at(4) - at(2)));
      expect(at(4) - at(2), name).toBe(2 * (at(2) - at(1)));
    }
    expect(rows[8]!.findings).toBe(8);
  }, 600_000);
});

const THROWS_KINDS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations/throws/kinds");

/**
 * A route whose handler is a sequence of `k` retried steps, step k choosing the
 * operation it invokes by `flagK`: the union the route renders, and each
 * policy's codes, vary with every flag.
 */
function throwsBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: ThrowsReadingCost }",
    `imports: { T: ${THROWS_KINDS} }`,
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    "---",
    "kind: T.FailA",
    "metadata: { name: failA }",
    "---",
    "kind: T.FailB",
    "metadata: { name: failB }",
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: main }",
    "steps:",
    ...flags.flatMap((i) => [
      `  - name: s${i}`,
      "    invoke: !if",
      `      if: !cel "variables.flag${i}"`,
      "      then: !ref failA",
      "      else: !ref failB",
      "    retry: { attempts: 1, nonRetryable: [ERR_A] }",
    ]),
    "---",
    "kind: T.Router",
    "metadata: { name: router }",
    "routes:",
    "  - handler: !ref main",
    "",
  ].join("\n");
}

/** How many readings the throws pass makes of each declaration, and the
 *  findings it reports, at `k` choices. */
async function throwsReadings(k: number): Promise<Record<string, number>> {
  const loaded = await loadGenerated(`pass-reading-throws-${k}.yaml`, throwsBeside(k));
  const counts: Record<string, number> = {};
  const stop = observeKeyCosts((cost) => {
    if (cost.kind !== "pass-reading" || cost.pass !== "throwsCoverage") return;
    const name = String((cost.declaration as { manifest: { metadata?: { name?: unknown } } }).manifest.metadata?.name);
    counts[name] = (counts[name] ?? 0) + 1;
  });
  let found: ReturnType<StaticAnalyzer["analyze"]>;
  try {
    found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  counts.findings = found.filter((d) => d.code === "NON_RETRYABLE_CODE_NOT_THROWN").length;
  return counts;
}

describe("throws over every configuration read a declaration once per chain of its options", () => {
  it("a handler of k retried steps, each choosing its operation by its own flag, is read linearly at k = 1, 2, 4, 8", async () => {
    const rows: Record<number, Record<string, number>> = {};
    for (const k of [1, 2, 4, 8]) rows[k] = await throwsReadings(k);
    console.log(
      [
        "k  main  router  failA  findings",
        ...Object.entries(rows).map(
          ([k, r]) => `${k.padEnd(2)} ${String(r.main).padStart(4)}  ${String(r.router).padStart(6)}  ${String(r.failA).padStart(5)}  ${r.findings}`,
        ),
      ].join("\n"),
    );
    for (const name of ["main", "router", "failA", "findings"]) {
      const at = (k: number) => rows[k]![name] ?? 0;
      expect(at(8) - at(4), name).toBe(2 * (at(4) - at(2)));
      expect(at(4) - at(2), name).toBe(2 * (at(2) - at(1)));
    }
    // One reading per chain of main's options — the empty one and two per
    // choice — and its union computed once.
    expect(rows[8]!.main).toBe(2 * 8 + 2);
    expect(rows[8]!.findings).toBe(8);
  }, 600_000);
});

const INPUT_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/resource-inputs");

/** An import handing eight stores to a library, the first `k` declared only
 *  where their own flag holds. */
function suppliesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  const stores = Array.from({ length: 8 }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: SupplyReadingCost }",
    ...(k > 0 ? ["variables:", ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`)] : []),
    "imports:",
    `  Kinds: ${INPUT_FIXTURES}/optional/kinds`,
    "  Wide:",
    `    source: ${INPUT_FIXTURES}/wide`,
    "    resources:",
    ...stores.map((i) => `      s${i}: !ref r${i}`),
    ...stores.flatMap((i) =>
      i <= k
        ? ["--- !if", `metadata: { name: r${i} }`, `if: !cel "variables.flag${i}"`, "then:", "  kind: Kinds.Store", `  label: r${i}`]
        : ["---", "kind: Kinds.Store", `metadata: { name: r${i} }`, `label: r${i}`],
    ),
    "",
  ].join("\n");
}

/** A library whose `k` holders each reference its optional store where their
 *  own flag holds. */
function optionalReferencesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Library",
    "metadata: { name: OptionalReadingCost, version: 0.0.0, description: Optional references under flags. }",
    `imports: { Kinds: ${INPUT_FIXTURES}/optional/kinds }`,
    "variables:",
    ...flags.map((i) => `  flag${i}: { type: boolean, default: false }`),
    "resources:",
    "  store: { kind: Kinds.Store, optional: true }",
    "---",
    "kind: Kinds.Store",
    "metadata: { name: fallback }",
    "label: fallback",
    ...flags.flatMap((i) => [
      "---",
      "kind: Kinds.Holder",
      `metadata: { name: h${i} }`,
      "store: !if",
      `  if: !cel "variables.flag${i}"`,
      "  then: !ref store",
      "  else: !ref fallback",
    ]),
    "",
  ].join("\n");
}

/** Names no two of which are near enough for one to be suggested for the other. */
const FAR_NAMES = ["apple", "bridge", "candle", "dragon", "engine", "forest", "garden", "harbor"];

/** A template body of `k` entries, entry k referencing a module resource
 *  declared only where its own flag holds. */
function bodyReferencesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  const helper = (i: number) => FAR_NAMES[i - 1]!;
  return [
    "kind: Telo.Application",
    "metadata: { name: BodyReadingCost }",
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    `imports: { Kinds: ${INPUT_FIXTURES}/optional/kinds }`,
    "---",
    "kind: Telo.Definition",
    "metadata: { name: Wrapper }",
    "capability: Telo.Provider",
    "schema: { type: object, properties: {} }",
    "resources:",
    ...flags.flatMap((i) => [`  - kind: Kinds.Holder`, `    metadata: { name: inner${i} }`, `    store: !ref ${helper(i)}`]),
    "provide: !ref inner1",
    ...flags.flatMap((i) => [
      "--- !if",
      `metadata: { name: ${helper(i)} }`,
      `if: !cel "variables.flag${i}"`,
      "then:",
      "  kind: Kinds.Store",
      `  label: ${helper(i)}`,
    ]),
    "",
  ].join("\n");
}

const NEED_KINDS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tests/__fixtures__/configurations/needs/kinds");

/** `k` consumers, consumer k referencing an optional need where its own flag
 *  holds and a fulfilment otherwise. */
function needReferencesBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: NeedReadingCost }",
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    `imports: { Kinds: ${NEED_KINDS} }`,
    "needs:",
    "  a: { kind: Kinds.Access, optional: true, env: { url: NEED_READING_COST_A_URL } }",
    "---",
    "kind: Kinds.Access",
    "metadata: { name: fixed }",
    'fields: { url: "mem://x" }',
    ...flags.flatMap((i) => [
      "---",
      "kind: Kinds.Consumer",
      `metadata: { name: c${i} }`,
      "access: !if",
      `  if: !cel "variables.flag${i}"`,
      "  then: !ref a",
      "  else: !ref fixed",
      `label: c${i}`,
    ]),
    "",
  ].join("\n");
}

/** A sequence of `k` steps, step k throwing with a display message its own
 *  flag chooses: a malformed one, or one of its own. */
function textsBeside(k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: TextReadingCost }",
    "variables:",
    ...flags.map((i) => `  flag${i}: { env: FLAG_${i}, type: boolean, default: false }`),
    "---",
    "kind: Telo.Sequence",
    "metadata: { name: main }",
    "steps:",
    ...flags.flatMap((i) => [
      `  - name: s${i}`,
      "    throw:",
      `      code: ERR_S${i}`,
      "      displayMessage: !if",
      `        if: !cel "variables.flag${i}"`,
      '        then: "Broken {$"',
      `        else: Fine ${i}`,
    ]),
    "",
  ].join("\n");
}

/** How many readings `pass` makes, and the findings with `code`, at `k`. */
async function passReadings(name: string, text: string, pass: string, code: string): Promise<{ readings: number; findings: number }> {
  const loaded = await loadGenerated(name, text);
  let readings = 0;
  const stop = observeKeyCosts((cost) => {
    if (cost.kind === "pass-reading" && cost.pass === pass) readings++;
  });
  let found: ReturnType<StaticAnalyzer["analyze"]>;
  try {
    found = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stop();
  }
  return { readings, findings: found.filter((d) => d.code === code).length };
}

describe("the resource-input, template-body, need-table and text passes over every configuration read linearly", () => {
  const rows = [
    ["resourceInputs", "RESOURCE_INPUT_UNRESOLVED", (k: number) => suppliesBeside(k)],
    ["optionalInputReferences", "RESOURCE_INPUT_OPTIONAL_REFERENCED", (k: number) => optionalReferencesBeside(k)],
    ["templateBody", "TEMPLATE_REF_UNKNOWN", (k: number) => bodyReferencesBeside(k)],
    ["needTable", "NEED_OPTIONAL_REFERENCED", (k: number) => needReferencesBeside(k)],
    ["texts", "MESSAGE_SYNTAX_INVALID", (k: number) => textsBeside(k)],
  ] as const;
  for (const [pass, code, text] of rows) {
    it(`${pass}: k choices beside one another are read and reported linearly at k = 1, 2, 4, 8`, async () => {
      const at: Record<number, { readings: number; findings: number }> = {};
      for (const k of [1, 2, 4, 8]) at[k] = await passReadings(`pass-reading-${pass}-${k}.yaml`, text(k), pass, code);
      console.log([`k  ${pass}  findings`, ...Object.entries(at).map(([k, r]) => `${k.padEnd(2)} ${r.readings}  ${r.findings}`)].join("\n"));
      for (const measure of ["readings", "findings"] as const) {
        const of = (k: number) => at[k]![measure];
        expect(of(8) - of(4), measure).toBe(2 * (of(4) - of(2)));
        expect(of(4) - of(2), measure).toBe(2 * (of(2) - of(1)));
      }
      expect(at[8]!.findings).toBe(8);
    }, 600_000);
  }
});
