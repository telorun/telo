import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { observeBodyReadings, observeKeyCosts } from "../src/cel-site-judgements.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { TEMPLATE_BODY_FIELDS } from "../src/template-expansion.js";
import type { ManifestSource } from "../src/types.js";
import { GENERATED, RUN } from "./configuration-cost-fixtures.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** A library of two templated kinds, each body holding a choice and an
 *  expression: `Reached` is what the application declares, `Unreached`
 *  nothing reaches. */
const LIBRARY = [
  "kind: Telo.Library",
  "metadata: { name: Reach }",
  "imports:",
  `  Run: ${RUN}`,
  ...["Reached", "Unreached"].flatMap((name) => [
    "---",
    "kind: Telo.Definition",
    `metadata: { name: ${name} }`,
    "capability: Telo.Invocable",
    "schema:",
    "  type: object",
    "  properties: { flag: { type: boolean }, v: { type: integer } }",
    "resources:",
    "  - kind: Telo.Value",
    "    metadata: { name: chosen }",
    "    value: !if",
    '      if: !cel "self.flag"',
    '      then: !cel "self.v + 1"',
    "      else: 0",
    "invoke: !ref chosen",
  ]),
  "",
].join("\n");

/** The application at `consumers` declarations of the reached kind and `k`
 *  independent flags, each read by a choice of its own (`2^k` configurations). */
function application(consumers: number, k: number): string {
  const flags = Array.from({ length: k }, (_, i) => i + 1);
  return [
    "kind: Telo.Application",
    "metadata: { name: ReachCost }",
    "imports:",
    "  Reach: ./reach",
    `  Run: ${RUN}`,
    ...(k > 0 ? ["variables:", ...flags.map((i) => `  f${i}: { env: F_${i}, type: boolean, default: false }`)] : []),
    ...Array.from({ length: consumers }, (_, c) => ["---", "kind: Reach.Reached", `metadata: { name: c${c} }`, "flag: true", `v: ${c}`].join("\n")),
    ...flags.map((i) =>
      ["---", "kind: Telo.Value", `metadata: { name: choice${i} }`, "value: !if", `  if: !cel "variables.f${i}"`, "  then: 1", "  else: 2"].join("\n"),
    ),
    "",
  ].join("\n");
}

async function load(consumers: number, k: number) {
  const base = join(GENERATED, `reached-definitions-${consumers}-${k}`);
  const texts = new Map([
    [join(base, "telo.yaml"), application(consumers, k)],
    [join(base, "reach", "telo.yaml"), LIBRARY],
  ]);
  const source: ManifestSource = {
    supports: (url) => isAbsolute(url),
    async read(url) {
      const text = texts.get(url) ?? texts.get(join(url, "telo.yaml"));
      if (text !== undefined) return { text, source: texts.has(url) ? url : join(url, "telo.yaml") };
      const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
      return { text: readFileSync(file, "utf8"), source: file };
    },
    resolveRelative: (from, relative) => resolve(dirname(from), relative),
  };
  const graph = await new Loader([source]).loadGraph(join(base, "telo.yaml"), { desugarImports: true });
  return { manifests: flattenForAnalyzer(graph), moduleDocuments: collectModuleDocuments(graph) };
}

type Counts = Record<"lifting" | "solving" | "passes", number>;

/** How often each library definition is lifted, has a key of a site in its
 *  body solved, and has a written pass read it. */
async function countsOf(consumers: number, k: number): Promise<Record<string, Counts>> {
  const loaded = await load(consumers, k);
  const out: Record<string, Counts> = {
    Reached: { lifting: 0, solving: 0, passes: 0 },
    Unreached: { lifting: 0, solving: 0, passes: 0 },
  };
  const nameOf = (m: unknown) => {
    const named = m as { metadata?: { name?: unknown }; manifest?: { metadata?: { name?: unknown } } };
    return String((named.manifest ?? named).metadata?.name);
  };
  const stopReadings = observeBodyReadings((definition) => {
    const name = nameOf(definition);
    if (out[name]) out[name].lifting++;
  });
  const stopCosts = observeKeyCosts((cost) => {
    if (cost.kind === "pass-reading" && (cost.pass === "templateBody" || cost.pass === "referenceForms")) {
      const name = nameOf(cost.declaration);
      if (out[name]) out[name].passes++;
      return;
    }
    if (cost.kind === "door") {
      const site = JSON.parse(cost.site) as unknown[];
      const place = site[site.length - 1];
      const field = Array.isArray(place) ? place[0] : typeof place === "string" ? place.split(/[.[]/)[0] : undefined;
      if (!TEMPLATE_BODY_FIELDS.includes(String(field))) return;
      for (const name of Object.keys(out)) if (site.includes(name)) out[name]!.solving++;
    }
  });
  try {
    new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
  } finally {
    stopReadings();
    stopCosts();
  }
  return out;
}

describe("the dependency definitions an analysis reads", () => {
  it("reads a reached one once, flat over consumers and configurations, and an unreached one never", async () => {
    const rows: Record<string, Record<string, Counts>> = {};
    for (const consumers of [1, 4]) for (const k of [0, 2, 3]) rows[`${consumers} consumers, ${2 ** k} configurations`] = await countsOf(consumers, k);
    console.log(Object.entries(rows).map(([row, counts]) => `${row}: ${JSON.stringify(counts)}`).join("\n"));
    const first = Object.values(rows)[0]!;
    expect(first.Reached!.lifting).toBe(1);
    expect(first.Reached!.solving).toBeGreaterThan(0);
    expect(first.Reached!.passes).toBeGreaterThan(0);
    for (const row of Object.values(rows)) {
      expect(row.Unreached).toEqual({ lifting: 0, solving: 0, passes: 0 });
      expect(row.Reached).toEqual(first.Reached);
    }
  }, 600_000);
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the template-definitions cover", () => {
  it("is fed by every definition the analysis reads, ownership deciding only what is reported", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const name = file.slice(SRC.length + 1);
      const text = readFileSync(file, "utf8");
      for (const gone of ["ownBodyFindings", "ownFindings"]) if (new RegExp(`\\b${gone}\\b`).test(text)) found.push(`${name}: ${gone}`);
    }
    const analyzer = readFileSync(join(SRC, "analyzer.ts"), "utf8");
    const cover = analyzer.slice(analyzer.indexOf("function definitionBodyCovers("), analyzer.indexOf("\n}\n", analyzer.indexOf("function definitionBodyCovers(")));
    if (/\bisOwnDefinition\b|\bisOwn\b/.test(cover)) found.push("analyzer.ts: definitionBodyCovers reads ownership");
    const pipeline = readFileSync(join(SRC, "finishing-pipeline.ts"), "utf8");
    const entry = pipeline.slice(pipeline.indexOf("export function bodyEntryCovers("), pipeline.indexOf("\n}\n", pipeline.indexOf("export function bodyEntryCovers(")));
    if (/\bisOwn/.test(entry)) found.push("finishing-pipeline.ts: bodyEntryCovers reads ownership");
    if ((entry.match(/covers:/g) ?? []).length !== 1 || !/\bincomplete\b/.test(entry)) found.push("finishing-pipeline.ts: bodyEntryCovers holds more than the consumer-expansion cover");
    expect(found).toEqual([]);
  });
});
