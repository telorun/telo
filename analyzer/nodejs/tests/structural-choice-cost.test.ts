import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeAnalysisRuns, observeKeyCosts, type KeyCost } from "../src/cel-site-judgements.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import { loadGenerated, paddingRow, RUN } from "./configuration-cost-fixtures.js";

/**
 * A template definition with k structural choices: entry K stands under
 * `!if self.fK`. The findings inside the body, the keys judging them and the
 * union passes' tables grow linearly in k — never with the 2^k ways the body
 * can be decided.
 *
 * The structural row's entry K holds `1 + 'a'` and, past the first, invokes
 * `!ref e(K−1)`; the CEL-read row's reads `resources.e(K−1)`, which is absent
 * wherever `self.f(K−1)` is false. The inputs row's `inputs:` reaches the one
 * entry it dispatches, beside k conditioned ones.
 */

const header = ["kind: Telo.Library", "metadata: { name: Rows }", "imports:", `  Run: ${RUN}`];

function row(k: number, value: (i: number) => string | undefined, invokes = false, inputs = false): string {
  const lines = [...header, "---", "kind: Telo.Definition", "metadata: { name: Row }", "capability: Telo.Invocable",
    "schema:", "  type: object", "  properties:"];
  for (let i = 1; i <= k; i++) lines.push(`    f${i}: { type: boolean }`);
  lines.push("resources:");
  for (let i = 1; i <= k; i++) {
    lines.push("  - !if", `    metadata: { name: e${i} }`, `    if: !cel "self.f${i}"`, "    then:", "      kind: Telo.Sequence",
      "      steps:", `        - { name: a, value: 1 }`);
    const read = value(i);
    if (read !== undefined) lines.push(`        - { name: b, value: !cel "${read}" }`);
    if (invokes && i > 1) lines.push(`        - { name: c, invoke: !ref e${i - 1} }`);
  }
  if (inputs) {
    lines.push(
      "  - kind: Telo.Value",
      "    metadata: { name: main }",
      "    inputType: { type: object, properties: { x: { type: integer } } }",
      "    value: 1",
      "invoke: !ref main",
      "inputs: { x: 1 }",
    );
  } else lines.push("  - { kind: Telo.Value, metadata: { name: main }, value: 1 }", "invoke: !ref main");
  return `${lines.join("\n")}\n`;
}

const structural = (k: number) => row(k, () => "1 + 'a'", true);
const celRead = (k: number) => row(k, (i) => (i > 1 ? `resources.e${i - 1}` : undefined));
const inputsRow = (k: number) => row(k, () => undefined, false, true);

const TIMING_RUNS = 5;

interface Measured {
  readonly findings: readonly { code: string; message: string; path: unknown }[];
  /** Keys judged, per family, and the entries of every union pass's table. */
  readonly keys: { readonly cel: number; readonly schema: number; readonly relation: number; readonly tables: number };
  /** The configuration runs the analysis made: one per configuration, none
   *  per way of deciding a body. */
  readonly runs: number;
  readonly seconds: number;
}

async function measure(name: string, text: string): Promise<Measured> {
  const loaded = await loadGenerated(name, text);
  const keys = { cel: 0, schema: 0, relation: 0, tables: 0 };
  const stop = observeKeyCosts((cost: KeyCost) => {
    if (cost.kind === "key-presence") keys[cost.family]++;
    if (cost.kind === "pass-table") keys.tables += cost.entries;
  });
  let runs = 0;
  const stopRuns = observeAnalysisRuns((purpose) => {
    if (purpose === "configuration" || purpose === "unreachable") runs++;
  });
  const analyze = () =>
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, positions: loaded.positions });
  let started = performance.now();
  let diagnostics: AnalysisDiagnostic[];
  try {
    diagnostics = analyze();
  } finally {
    stop();
    stopRuns();
  }
  // The fastest of several runs: one wall-clock sample on a shared runner is noise.
  let seconds = (performance.now() - started) / 1000;
  for (let i = 1; i < TIMING_RUNS; i++) {
    started = performance.now();
    analyze();
    seconds = Math.min(seconds, (performance.now() - started) / 1000);
  }
  const findings = diagnostics
    .filter((d) => d.code === "CEL_TYPE_ERROR" || d.code === "CEL_UNKNOWN_FIELD" || d.code === "TEMPLATE_REF_UNKNOWN")
    .map((d) => ({ code: String(d.code), message: d.message, path: (d.data as { path?: unknown } | undefined)?.path }));
  return { findings, keys, runs, seconds };
}

const KS = (process.env.ROW_KS ?? "1,2,4,8,16").split(",").map(Number);
const record = process.env.ROW_RECORD;

/** No way of deciding a body is enumerated: one run, the one configuration. */
function expectOneRun(found: Measured, k: number): void {
  expect(found.runs, `configuration runs at k=${k}`).toBe(1);
}

/** Time grows at most linearly: each doubling of k at most 2.5× the time. */
function expectTimeLinear(found: ReadonlyMap<number, Measured>): void {
  for (const [from, to] of [[4, 8], [8, 16]] as const) {
    const a = found.get(from)?.seconds;
    const b = found.get(to)?.seconds;
    if (a !== undefined && b !== undefined) expect(b / a, `t(${to})/t(${from})`).toBeLessThanOrEqual(2.5);
  }
}

/** Keys of every family, and table entries, at most a·k + b, the line fitted
 *  at k = 2 and 4. */
function expectLinear(keys: ReadonlyMap<number, Measured["keys"]>): void {
  for (const family of ["cel", "schema", "relation", "tables"] as const) {
    const at = (k: number) => keys.get(k)![family];
    const slope = (at(4) - at(2)) / 2;
    const intercept = at(2) - 2 * slope;
    for (const k of keys.keys()) expect(at(k), `${family} keys at k=${k}`).toBeLessThanOrEqual(slope * k + intercept);
  }
}

describe("definitions beside one another", () => {
  it("cost the same each, however many there are", async () => {
    const seconds = new Map<number, number>();
    for (const p of [0, 50, 200]) seconds.set(p, (await measure(`structural-choice-padding-${p}.yaml`, paddingRow(p))).seconds);
    if (record) writeFileSync(`${record}-padding.json`, JSON.stringify(Object.fromEntries(seconds), null, 2));
    const each = (p: number) => (seconds.get(p)! - seconds.get(0)!) / p;
    expect(each(200), `per definition: ${each(50)} s at 50, ${each(200)} s at 200`).toBeLessThanOrEqual(1.5 * each(50));
  }, 300_000);
});

describe("a body's structural choices", () => {
  it("find each type error once, under its own entry's choice, with keys linear in k", async () => {
    const keys = new Map<number, Measured["keys"]>();
    const recorded: Record<number, Measured> = {};
    for (const k of KS) {
      const found = await measure(`structural-choice-cost-${k}.yaml`, structural(k));
      recorded[k] = found;
      keys.set(k, found.keys);
      if (record) continue;
      expectOneRun(found, k);
      expect(found.findings.filter((f) => f.code === "CEL_TYPE_ERROR").map((f) => [f.code, f.message])).toEqual(
        Array.from({ length: k }, (_, i) => [
          "CEL_TYPE_ERROR",
          `Telo.Definition/Row: !cel: no "+" is declared over int, string (when self.f${i + 1} is true)`,
        ]),
      );
      // Each reference to the entry before it, once: where that entry is absent,
      // named as the body declares it, the siblings listed as written.
      const written = [...Array.from({ length: k }, (_, i) => `e${i + 1}`), "main"];
      expect(found.findings.filter((f) => f.code === "TEMPLATE_REF_UNKNOWN").map((f) => [f.code, f.message])).toEqual(
        Array.from({ length: k - 1 }, (_, i) => {
          const reader = i + 2;
          const target = `e${reader - 1}`;
          const siblings = written.filter((name) => name !== `e${reader}` && name !== target);
          return [
            "TEMPLATE_REF_UNKNOWN",
            `Telo.Definition/Row: 'steps[2].invoke: !ref ${target}' on the Telo.Sequence entry 'e${reader}' names the ` +
              `'resources:' entry '${target}', which this body declares but not in these configurations, and no resource ` +
              `of this module. Siblings: ${siblings.join(", ")}. (when self.f${reader - 1} is false and self.f${reader} is true)`,
          ];
        }),
      );
      // One text per finding at a site.
      const texts = new Map<string, Set<string>>();
      for (const f of found.findings) {
        const site = JSON.stringify([f.code, f.path]);
        texts.set(site, (texts.get(site) ?? new Set()).add(f.message));
      }
      for (const [site, messages] of texts) expect(messages.size, site).toBe(1);
    }
    if (record) writeFileSync(`${record}-structural.json`, JSON.stringify(recorded, null, 2));
    else {
      expectLinear(keys);
      expectTimeLinear(new Map(Object.entries(recorded).map(([k, m]) => [Number(k), m])));
    }
  }, 600_000);

  it("find a read of an absent entry once per reader, listing every entry written but that one", async () => {
    const keys = new Map<number, Measured["keys"]>();
    const recorded: Record<number, Measured> = {};
    for (const k of KS) {
      const found = await measure(`structural-choice-read-${k}.yaml`, celRead(k));
      recorded[k] = found;
      keys.set(k, found.keys);
      if (record) continue;
      expectOneRun(found, k);
      const written = [...Array.from({ length: k }, (_, i) => `e${i + 1}`), "main"];
      expect(found.findings.map((f) => [f.code, f.message])).toEqual(
        Array.from({ length: k - 1 }, (_, i) => {
          const reader = i + 2;
          const available = written.filter((name) => name !== `e${reader - 1}`);
          return [
            "CEL_UNKNOWN_FIELD",
            `Telo.Definition/Row: !cel: 'resources.e${reader - 1}' is not defined (available: ${available.join(", ")}) ` +
              `(when self.f${reader - 1} is false and self.f${reader} is true)`,
          ];
        }),
      );
    }
    if (record) writeFileSync(`${record}-read.json`, JSON.stringify(recorded, null, 2));
    else {
      expectLinear(keys);
      expectTimeLinear(new Map(Object.entries(recorded).map(([k, m]) => [Number(k), m])));
    }
  }, 600_000);

  it("key a template's `inputs:` by the entry it dispatches, never by every entry beside it", async () => {
    const keys = new Map<number, Measured["keys"]>();
    const recorded: Record<number, Measured> = {};
    for (const k of KS) {
      const found = await measure(`structural-choice-inputs-${k}.yaml`, inputsRow(k));
      recorded[k] = found;
      keys.set(k, found.keys);
      if (!record) expect(found.findings).toEqual([]);
    }
    if (record) writeFileSync(`${record}-inputs.json`, JSON.stringify(recorded, null, 2));
    else {
      expectLinear(keys);
      expectTimeLinear(new Map(Object.entries(recorded).map(([k, m]) => [Number(k), m])));
    }
  }, 600_000);
});
