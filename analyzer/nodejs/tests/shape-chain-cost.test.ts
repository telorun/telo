import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeAnalysisRuns, observeKeyCosts, type KeyCost } from "../src/cel-site-judgements.js";
import { observeShapeVerdicts } from "../src/named-shape-reader.js";
import { loadGenerated, shapeChain, textChain, unionChain } from "./configuration-cost-fixtures.js";

/**
 * The chain gate: C(k), a resource writing values through k named shapes,
 * each varying under its own flag whether `x` is a reference slot. Reading a
 * shape one hop at a time makes every counter here grow with k, never with
 * the 2^k ways the chain can be decided:
 *
 * - the resource is normalized once, however its cut points are decided;
 * - schema-door and relation-door evaluations at most 2.5× per doubling of k;
 * - the sub-verdicts beneath references at most the shapes' classes (2k);
 * - k = 16 completes.
 *
 * U(k), the same chain written as `oneOf`s each naming the next shape — each
 * reference a schema carve — is held to the doubling bound on schema and
 * relation doors, to
 * at most 4k sub-verdicts (each shape's two classes times the at most two
 * decisions of the carve it reads) and to the doubling bound on them from 8 to
 * 16; T(k), a chain of carves each refusing the value in one way and wording it
 * per class, to the doubling bound on relation doors and to at most 2k
 * sub-verdicts. In both no two sub-verdicts share a memo key and no key holds a
 * carve's text, and each reaches its first configuration run within every
 * bound. Each row also reports the comparisons judged once per pair of shape
 * classes, held to the doubling bound wherever a chain makes any, and the
 * sides of a declaration's cut points the call graph reads it on, held to it
 * on every chain.
 * A misfit at each depth of C(4),
 * analysed whole, is one finding under its own shape's class.
 *
 * Each case ends when the analysis's first configuration or dead-branch run
 * starts; it completes when it reaches that point (or the end) with no doubling
 * bound exceeded. A case exceeding a bound is stopped there and
 * reported as not completed.
 */

const KS = [1, 4, 8, 16] as const;
const RATIO = 2.5;

interface Measured {
  /** Normalizations of the resource. */
  readonly normalizations: number;
  readonly schemaDoors: number;
  readonly relationDoors: number;
  /** Comparisons judged once per pair of shape classes. */
  readonly comparisons: number;
  /** Sides of a declaration's cut points the call graph reads it on. */
  readonly readings: number;
  /** Sub-verdicts the named-shape reader judges beneath a reference. */
  readonly subVerdicts: number;
  /** Sub-verdicts judged under a memo key another one was judged under. */
  readonly repeatedKeys: number;
  /** Carves a sub-verdict's key holds by their text. */
  readonly textParts: number;
  readonly completed: boolean;
  /** The bound a stopped case exceeded. */
  readonly stoppedBy?: Bounded;
  readonly milliseconds: number;
}

/** The counters a doubling of k is held to as it runs. */
type Bounded = "schema" | "relation" | "comparisons" | "readings";
type Bound = Readonly<Record<Bounded, number>>;

const countOf = (m: Measured, of: Bounded): number =>
  of === "schema" ? m.schemaDoors : of === "relation" ? m.relationDoors : of === "comparisons" ? m.comparisons : m.readings;

/** The bound k is held to: its half's counts times the ratio, or none. */
function boundAt(k: number, found: ReadonlyMap<number, Measured>): Bound {
  const half = found.get(k / 2);
  const at = (of: Bounded) => (half ? RATIO * countOf(half, of) : Number.POSITIVE_INFINITY);
  return { schema: at("schema"), relation: at("relation"), comparisons: at("comparisons"), readings: at("readings") };
}

/** Each doubling's ratio of the counter — with `whenAny`, only where either
 *  side counts any. */
function expectDoublings(found: ReadonlyMap<number, Measured>, of: Bounded, label: string, table: string, whenAny = false): void {
  for (const [from, to] of [[4, 8], [8, 16]] as const) {
    const a = countOf(found.get(from)!, of);
    const b = countOf(found.get(to)!, of);
    if (whenAny && a === 0 && b === 0) continue;
    expect.soft(b / a, `${label} t(${to})/t(${from})\n${table}`).toBeLessThanOrEqual(RATIO);
  }
}

class Stopped extends Error {}
class Reached extends Error {}

async function measure(
  k: number,
  bound: Bound,
  fixture: { readonly name: string; readonly text: string } = { name: `shape-chain-${k}.yaml`, text: shapeChain(k) },
): Promise<Measured> {
  const loaded = await loadGenerated(fixture.name, fixture.text);
  const route = loaded.manifests.find((m) => m.metadata?.name === "route");
  let normalizations = 0;
  let schemaDoors = 0;
  let relationDoors = 0;
  let comparisons = 0;
  let readings = 0;
  let subVerdicts = 0;
  let repeatedKeys = 0;
  let textParts = 0;
  const keys = new Set<string>();
  let stopped = false;
  let stoppedBy: Bounded | undefined;
  let ended = false;
  const started = performance.now();
  const exceeded = (): void => {
    const over = (["schema", "relation", "comparisons", "readings"] as const).find(
      (of) => ({ schema: schemaDoors, relation: relationDoors, comparisons, readings })[of] > bound[of],
    );
    if (!over) return;
    stoppedBy = over;
    stopped = ended = true;
    throw new Stopped(`C(${k}) stopped`);
  };
  const stop = observeKeyCosts((cost: KeyCost) => {
    if (ended) return;
    if (cost.kind === "normalization" && (cost.declaration as { manifest?: unknown }).manifest === route) normalizations++;
    if (cost.kind === "door" && cost.family === "schema") schemaDoors++;
    if (cost.kind === "door" && cost.family === "relation") relationDoors++;
    if (cost.kind === "graph-side") readings++;
    if (cost.kind === "sub-verdict") {
      subVerdicts++;
      if (keys.has(cost.key)) repeatedKeys++;
      keys.add(cost.key);
      textParts += cost.textParts;
    }
    exceeded();
  });
  const stopPairs = observeShapeVerdicts((_kind, _key, index) => {
    if (ended || index !== -1) return;
    comparisons++;
    exceeded();
  });
  const stopRuns = observeAnalysisRuns((purpose) => {
    if (ended || (purpose !== "configuration" && purpose !== "unreachable")) return;
    ended = true;
    throw new Reached(`C(${k}) reached its first ${purpose} run`);
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions });
  } catch (error) {
    if (!(error instanceof Stopped) && !(error instanceof Reached)) throw error;
  } finally {
    stop();
    stopPairs();
    stopRuns();
  }
  return {
    normalizations,
    schemaDoors,
    relationDoors,
    comparisons,
    readings,
    subVerdicts,
    repeatedKeys,
    textParts,
    completed: !stopped,
    ...(stoppedBy ? { stoppedBy } : {}),
    milliseconds: Math.round(performance.now() - started),
  };
}

describe("a chain of k varying named shapes", () => {
  it("costs linearly in k", async () => {
    const found = new Map<number, Measured>();
    for (const k of KS) {
      // A doubling of k is held to its half's counts as it runs.
      found.set(k, await measure(k, boundAt(k, found)));
    }
    const table = KS.map((k) => {
      const m = found.get(k)!;
      return `k=${k}: ${m.normalizations} normalizations, ${m.schemaDoors} schema doors, ${m.relationDoors} relation doors, ${m.comparisons} comparisons, ${m.readings} graph sides, ${m.subVerdicts} sub-verdicts, ${m.completed ? "completed" : `stopped by ${m.stoppedBy}`} in ${m.milliseconds} ms`;
    }).join("\n");
    console.log(table);
    for (const k of KS) {
      const m = found.get(k)!;
      expect.soft(m.normalizations, `normalizations of the resource at k=${k}\n${table}`).toBe(1);
      expect.soft(m.subVerdicts, `sub-verdicts at k=${k}\n${table}`).toBeLessThanOrEqual(2 * k);
      expect.soft(m.completed, `C(${k}) completes\n${table}`).toBe(true);
    }
    expectDoublings(found, "schema", "schema doors", table);
    expectDoublings(found, "relation", "relation doors", table);
    expectDoublings(found, "readings", "graph sides", table);
    expectDoublings(found, "comparisons", "comparisons", table, true);
  }, 600_000);
});

describe("a chain of k varying named shapes written as unions", () => {
  it("costs linearly in k", async () => {
    const found = new Map<number, Measured>();
    for (const k of KS) {
      found.set(k, await measure(k, boundAt(k, found), { name: `union-chain-${k}.yaml`, text: unionChain(k) }));
    }
    const table = KS.map((k) => {
      const m = found.get(k)!;
      return `k=${k}: ${m.schemaDoors} schema doors, ${m.relationDoors} relation doors, ${m.comparisons} comparisons, ${m.readings} graph sides, ${m.subVerdicts} sub-verdicts (${m.repeatedKeys} repeated keys, ${m.textParts} text parts), ${m.completed ? "completed" : `stopped by ${m.stoppedBy}`} in ${m.milliseconds} ms`;
    }).join("\n");
    console.log(table);
    for (const k of KS) {
      const m = found.get(k)!;
      expect.soft(m.subVerdicts, `sub-verdicts at k=${k}\n${table}`).toBeLessThanOrEqual(4 * k);
      expect.soft(m.repeatedKeys, `sub-verdicts sharing a memo key at k=${k}\n${table}`).toBe(0);
      expect.soft(m.textParts, `carves keyed by their text at k=${k}\n${table}`).toBe(0);
      expect.soft(m.stoppedBy, `U(${k}) reaches its first configuration run within every bound\n${table}`).toBeUndefined();
    }
    expectDoublings(found, "schema", "schema doors", table);
    expectDoublings(found, "relation", "relation doors", table);
    expectDoublings(found, "readings", "graph sides", table);
    expectDoublings(found, "comparisons", "comparisons", table);
    expect.soft(found.get(16)!.subVerdicts / found.get(8)!.subVerdicts, `sub-verdicts t(16)/t(8)\n${table}`).toBeLessThanOrEqual(RATIO);
  }, 600_000);
});

describe("a chain of k carves each worded per class", () => {
  it("judges each carve's class once", async () => {
    const found = new Map<number, Measured>();
    for (const k of KS) {
      found.set(k, await measure(k, boundAt(k, found), { name: `text-chain-${k}.yaml`, text: textChain(k) }));
    }
    const table = KS.map((k) => {
      const m = found.get(k)!;
      return `k=${k}: ${m.schemaDoors} schema doors, ${m.relationDoors} relation doors, ${m.comparisons} comparisons, ${m.readings} graph sides, ${m.subVerdicts} sub-verdicts (${m.repeatedKeys} repeated keys, ${m.textParts} text parts), ${m.completed ? "completed" : `stopped by ${m.stoppedBy}`} in ${m.milliseconds} ms`;
    }).join("\n");
    console.log(table);
    for (const k of KS) {
      const m = found.get(k)!;
      expect.soft(m.subVerdicts, `sub-verdicts at k=${k}\n${table}`).toBeLessThanOrEqual(2 * k);
      expect.soft(m.repeatedKeys, `sub-verdicts sharing a memo key at k=${k}\n${table}`).toBe(0);
      expect.soft(m.textParts, `carves keyed by their text at k=${k}\n${table}`).toBe(0);
      expect.soft(m.stoppedBy, `T(${k}) reaches its first configuration run within every bound\n${table}`).toBeUndefined();
    }
    expectDoublings(found, "relation", "relation doors", table);
    expectDoublings(found, "readings", "graph sides", table);
    expectDoublings(found, "comparisons", "comparisons", table);
  }, 600_000);
});

describe("a misfit at one depth of the chain", () => {
  it("is one finding, under that depth's class", async () => {
    const k = 4;
    for (let j = 1; j <= k; j++) {
      const loaded = await loadGenerated(`shape-chain-${k}-misfit-${j}.yaml`, shapeChain(k, j));
      const found = new StaticAnalyzer()
        .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions })
        .filter((d) => d.code === "SCHEMA_VIOLATION");
      const path = ["s", ...Array.from({ length: j - 1 }, () => "next"), "y"];
      expect(found.map((d) => [(d.data as { path?: string }).path, d.message])).toEqual([
        [path.join("."), `ShapeChain${k}.Route/route: /${path.join("/")} must be integer (when variables.flag${j} is true)`],
      ]);
    }
  }, 120_000);
});
