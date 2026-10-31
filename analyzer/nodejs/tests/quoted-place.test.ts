import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { isTaggedSentinel } from "@telorun/templating";
import { quotedPlacesOf, quotedTexts } from "../src/quoted-place.js";
import { parseKeys, pathText } from "../src/template-expansion.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import {
  flagSequenceInTry,
  forwardedSequence,
  generatedCorpus,
  loadGenerated,
  mergedPlaceViews,
  nestedConsumers,
  RUN,
  scopeMemberCrossing,
  scopeMemberOnwardCrossing,
  topLevelCrossing,
  viewOnlyStatus,
  shiftedConsumerName,
  drawnOutOrder,
  nestedInlinePlaces,
  SWEPT_CHOICES,
} from "./configuration-cost-fixtures.js";
import { fileCorpus, loadFile, ROOT, writesExpansion } from "./configuration-corpus.js";

// Names of the declarations carrying `xTeloOrigin` in the analysis last run:
// the extractions, whose generated names no message may hold.
const extractedNames = vi.hoisted(() => new Set<string>());
// Names of the declarations the author wrote (no origin, or an author-named one).
const authoredNames = vi.hoisted(() => new Set<string>());
// Findings the reroute moved to a holder: the message, and the extracted declaration it was made on.
const rerouted = vi.hoisted(() => [] as { message: string; carried: string[]; extracted: unknown }[]);
vi.mock("../src/rewrite-synthetic-origins.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rewrite-synthetic-origins.js")>();
  return {
    ...actual,
    rewriteSyntheticOrigins: (...args: Parameters<typeof actual.rewriteSyntheticOrigins>) => {
      for (const m of args[1]) {
        const meta = m.metadata as { name?: unknown; xTeloOrigin?: unknown } | undefined;
        if (typeof meta?.name !== "string") continue;
        const origin = meta.xTeloOrigin as { named?: true } | undefined;
        if (origin === undefined || origin.named === true) authoredNames.add(meta.name);
        else extractedNames.add(meta.name);
      }
      const out = actual.rewriteSyntheticOrigins(...args);
      out.forEach((moved, i) => {
        const was = (args[0][i]!.data as { resource?: { name?: string } } | undefined)?.resource?.name;
        const now = (moved.data as { resource?: { name?: string } } | undefined)?.resource?.name;
        if (was === now) return;
        const extracted = args[1].find((m) => m.metadata?.name === was);
        rerouted.push({ message: moved.message, carried: (quotedTexts(moved) ?? []).map((t) => t.carried), extracted });
      });
      return out;
    },
  };
});

/**
 * A message quoting its place quotes the place its `data.path` names, at every
 * diagnostic of the configuration corpus — keyed judgements and configuration
 * runs alike render it from where the value was written, never from where a
 * configuration projected it (an item after an `!if` item).
 */
type Loaded = Awaited<ReturnType<typeof loadFile>>;

/** The value at `keys` in a declaration as written, if there is one. */
function valueAt(declaration: unknown, keys: readonly (string | number)[]): unknown {
  let at = declaration;
  for (const key of keys) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

/** The places of `declaration` a message writes: single-quoted dotted paths and
 *  pointers, each one naming a value the declaration holds or an item of a
 *  field it holds (a place a choice may have projected elsewhere). */
function writtenPlaces(message: string, declaration: unknown): string[] {
  const found: string[] = [];
  for (const [, token] of message.matchAll(/'([^'\s]+)'/g)) {
    if (!/[.[]/.test(token!) || pathText(parseKeys(token!)) !== token) continue;
    const keys = parseKeys(token!);
    if (valueAt(declaration, keys) !== undefined || (/\[\d+\]/.test(token!) && valueAt(declaration, keys.slice(0, 1)) !== undefined)) found.push(token!);
  }
  for (const [, token] of message.matchAll(/(?:^|[\s(])(\/[^\s'"),:]+)/g)) {
    const keys = token!.slice(1).split("/").map((key) => (/^\d+$/.test(key) ? Number(key) : key));
    if (valueAt(declaration, keys) !== undefined || (keys.some((key) => typeof key === "number") && valueAt(declaration, keys.slice(0, 1)) !== undefined)) found.push(token!);
  }
  return found;
}

/** The name of every declaration the manifests as loaded hold, scope members included. */
function collectAuthoredNames(value: unknown): void {
  if (Array.isArray(value)) value.forEach(collectAuthoredNames);
  else if (value !== null && typeof value === "object" && !isTaggedSentinel(value)) {
    const name = (value as { metadata?: { name?: unknown } }).metadata?.name;
    if (typeof name === "string") authoredNames.add(name);
    Object.values(value).forEach(collectAuthoredNames);
  }
}

/** The text of every expression the author wrote: the only text in which a generated name is echoed, not generated. */
function expressionText(value: unknown): string {
  if (isTaggedSentinel(value)) return value.source;
  if (Array.isArray(value)) return value.map(expressionText).join("\n");
  if (value !== null && typeof value === "object") return Object.values(value).map(expressionText).join("\n");
  return "";
}

/** The places an extraction-relative message writes under its holder's label, with no quote recording them. */
function unquotedUnderHolder(): string[] {
  const out: string[] = [];
  for (const { message, carried, extracted } of rerouted) {
    for (const [, before, token] of message.matchAll(/(\bat |[^\w])?'([^'\s]+)'/g)) {
      // A bare word is a place only after "at"; elsewhere it is a name (an identifier, a property).
      if (!/[.[]/.test(token!) && before !== "at ") continue;
      if (carried.includes(token!) || pathText(parseKeys(token!)) !== token) continue;
      if (valueAt(extracted, parseKeys(token!)) !== undefined) out.push(`${message}: writes ${token} with no recorded quote`);
    }
  }
  return out;
}

/** What a message says that the author did not write: the name of a declaration
 *  an extraction made anywhere in it, or a `<kind>/<name>:` label other than the
 *  declaration the finding is reported at. */
function namesWrittenByTheAuthor(d: AnalysisDiagnostic, extracted: readonly string[], written: string): string[] {
  const out: string[] = [];
  // A name the manifest spells out is echoed, not generated.
  for (const name of extracted.filter((n) => !written.includes(n))) {
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(d.message)) out.push(`names the extraction '${name}'`);
  }
  const resource = (d.data as { resource?: { kind?: string; name?: string } } | undefined)?.resource;
  const label = /^([A-Za-z0-9_.]+)\/([A-Za-z0-9_]+): /.exec(d.message);
  // A declaration of a branch no configuration takes is reported under its choice's name.
  const choice = resource?.kind?.startsWith("!") === true;
  // A collision names both declarations it is about; a scope member is named by its author.
  const named = label !== null && authoredNames.has(label[2]!);
  if (d.code !== "DUPLICATE_RESOURCE_NAME" && !named && label && resource && ((!choice && label[1] !== resource.kind) || label[2] !== resource.name)) {
    out.push(`labelled ${label[1]}/${label[2]}, reported at ${resource.kind}/${resource.name}`);
  }
  return out;
}

/** Whether the text is relative to a declaration the author named other than the one it is reported at: a template body entry, a branch of a choice, a scope member. */
function relativeToNamed(d: AnalysisDiagnostic, resource: { kind?: string; name?: string } | undefined): boolean {
  if (resource?.kind === "Telo.Definition" || resource?.kind?.startsWith("!")) return true;
  const label = /^([A-Za-z0-9_.]+)\/([A-Za-z0-9_]+): /.exec(d.message);
  return label !== null && label[2] !== resource?.name && authoredNames.has(label[2]!);
}

function mismatches(loaded: Loaded): string[] {
  const out: string[] = [];
  extractedNames.clear();
  rerouted.length = 0;
  authoredNames.clear();
  collectAuthoredNames(loaded.manifests);
  const diagnostics: AnalysisDiagnostic[] = new StaticAnalyzer().analyze(loaded.manifests, {
    moduleDocuments: loaded.moduleDocuments,
  });
  const written = expressionText(loaded.manifests);
  out.push(...unquotedUnderHolder());
  for (const d of diagnostics) {
    const texts = quotedTexts(d);
    const quotes = quotedPlacesOf(d) ?? [];
    const data = d.data as { path?: unknown; resource?: { kind?: string; name?: string } } | undefined;
    const path = data?.path;
    const declaration = loaded.manifests.find(
      (m) => m.kind === data?.resource?.kind && (m.metadata as { name?: string } | undefined)?.name === data?.resource?.name,
    );
    const at = `${d.message} @ ${String(path)}`;
    out.push(...namesWrittenByTheAuthor(d, [...extractedNames], written).map((problem) => `${at}: ${problem}`));
    if (texts === undefined) {
      // A schema finding opening with a pointer is a quote of its place.
      if (d.code === "SCHEMA_VIOLATION" && /^[^\s:]+: \//.test(d.message)) out.push(`unquoted: ${at}`);
    } else {
      for (const { quoted, carried, place, renderedFor } of texts) {
        if (renderedFor !== path) out.push(`${at}: quotes were rendered for ${renderedFor}`);
        if (!relativeToNamed(d, data?.resource) && quotes.find((q) => q.place === place)!.from !== 0) {
          out.push(`${at}: quotes ${place} relative to a declaration other than the one it is reported at`);
        }
        if (quoted !== carried) out.push(`${at}: quotes ${quoted}, carries ${carried}`);
        if (declaration && valueAt(declaration, parseKeys(place)) === undefined) out.push(`${at}: quotes ${place}, which the declaration does not hold`);
      }
    }
    if (declaration === undefined) continue;
    const recorded = new Set((texts ?? []).map((t) => t.carried));
    for (const place of writtenPlaces(d.message, declaration)) {
      if (!recorded.has(place)) out.push(`${at}: writes ${place} with no recorded quote`);
    }
  }
  return out;
}

const SUITE_SKIP = new Set(["node_modules", ".telo", "dist", ".claude", ".git", "__fixtures__"]);

/** Every manifest the root module suite runs that writes a choice or a repeat: the files its
 *  `**\/tests/*.yaml` glob reaches, and the files their `source:` lines check or run. */
function moduleSuiteSources(): string[] {
  const tests: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SUITE_SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".yaml") && basename(dirname(path)) === "tests") tests.push(path);
    }
  };
  walk(ROOT);
  const sources = new Set<string>();
  for (const test of tests) {
    sources.add(test);
    for (const [, source] of readFileSync(test, "utf8").matchAll(/^\s*source: (\.\.?\/\S+)/gm)) {
      const file = resolve(dirname(test), source!);
      if (existsSync(file)) sources.add(statSync(file).isDirectory() ? join(file, "telo.yaml") : file);
    }
  }
  return [...sources].filter((file) => existsSync(file) && writesExpansion(file)).sort();
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/quoted-place");

/** Findings the producers of every family make at a place `flag2` chooses, after
 *  one `flag1` chooses: projected one index earlier where `flag1` is false. */
const SHIFTED = [
  "kind: Telo.Application",
  "metadata: { name: ShiftedFinding }",
  "imports:",
  `  Run: ${RUN}`,
  `  Tree: ${FIXTURE}`,
  "variables:",
  "  flag1: { env: FLAG_1, type: boolean, default: false }",
  "  flag2: { env: FLAG_2, type: boolean, default: false }",
  "targets:",
  "  - !if",
  '    if: !cel "variables.flag1"',
  "    then: !ref ok",
  "  - !if",
  '    if: !cel "variables.flag2"',
  "    then: { name: late, invoke: !ref val, timeout: 0 }",
  "  - !if",
  '    if: !cel "variables.flag2"',
  "    then: !ref val",
  "---",
  "kind: Run.Value",
  "metadata: { name: val }",
  "value: 1",
  "---",
  "kind: Run.Sequence",
  "metadata: { name: ok }",
  "steps:",
  "  - name: noop",
  "    invoke: !ref val",
  "---",
  "kind: Tree.Holder",
  "metadata: { name: holder }",
  "---",
  "kind: Run.Sequence",
  "metadata: { name: stepped }",
  "steps:",
  "  - !if",
  '    if: !cel "variables.flag1"',
  "    then: { name: first, invoke: !ref val }",
  "  - !if",
  '    if: !cel "variables.flag2"',
  "    then: { name: second, invoke: !ref holder }",
  "---",
  "kind: Tree.View",
  "metadata: { name: page }",
  "content:",
  "  children:",
  "    - !if",
  '      if: !cel "variables.flag1"',
  "      then: {}",
  "    - !if",
  '      if: !cel "variables.flag2"',
  "      then:",
  "        shown:",
  '          at: !cel "row.amount"',
  "          matches: { const: billing }",
  "",
].join("\n");

describe("a message quoting its place quotes its data.path", () => {
  it("quotes the written index of a finding after an item a choice may leave out", async () => {
    const loaded = await loadGenerated("shifted-finding.yaml", SHIFTED);
    expect(mismatches(loaded)).toEqual([]);
    for (const flag of [false, true]) {
      const found = new StaticAnalyzer().analyze(loaded.manifests, {
        moduleDocuments: loaded.moduleDocuments,
        within: { "variables.flag1": flag, "variables.flag2": true },
      });
      const message = (d: AnalysisDiagnostic) => [d.code, d.message, (d.data as { path?: unknown }).path];
      expect(found.map(message).sort((x, y) => String(x[2]).localeCompare(String(y[2])))).toEqual([
        [
          "MATCH_UNSATISFIABLE",
          "Tree.View/page: the schema at 'content.children[1].then.shown.matches' can never hold for 'content.children[1].then.shown.at' — it requires \"billing\", and the value is integer.",
          "content.children[1].then.shown.matches",
        ],
        [
          "REFERENCE_KIND_MISMATCH",
          "Run.Sequence/stepped: step invoke at 'steps[1].then.invoke' → 'Tree.Holder' is a Telo.Mount and cannot be invoked in a step — it has no invoke or run method (runtime ERR_RESOURCE_NOT_INVOKABLE)",
          "steps[1].then.invoke",
        ],
        [
          "SCHEMA_VIOLATION",
          "Telo.Application/ShiftedFinding: /targets/1/then/timeout must be >= 1",
          "targets[1].then.timeout",
        ],
        [
          "REFERENCE_KIND_MISMATCH",
          "Telo.Application/ShiftedFinding: reference at 'targets[2].then' → 'Run.Value' does not implement 'Telo.Runnable' (known implementations: Run.Sequence, Run.Iteration, Run.Loop); 'Run.Value' does not implement 'Telo.Service' — it declares 'Telo.Invocable'",
          "targets[2].then",
        ],
      ]);
    }
  });
  for (const file of fileCorpus()) {
    it(file, async () => expect(mismatches(await loadFile(join(ROOT, file)))).toEqual([]), 120_000);
  }
  for (const [name, text] of generatedCorpus(SWEPT_CHOICES)) {
    it(`generated ${name}`, async () => expect(mismatches(await loadGenerated(name, text))).toEqual([]), 120_000);
  }
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    const name = `forwarded-sequence-${n}.yaml`;
    it(`generated ${name}`, async () => expect(mismatches(await loadGenerated(name, forwardedSequence(n)))).toEqual([]), 120_000);
  }
  it("generated merged-place-views.yaml", async () =>
    expect(mismatches(await loadGenerated("merged-place-views.yaml", mergedPlaceViews()))).toEqual([]), 120_000);
  it("generated nested-consumers.yaml", async () =>
    expect(mismatches(await loadGenerated("nested-consumers.yaml", nestedConsumers()))).toEqual([]), 120_000);
  for (const shadowed of [false, true]) {
    const name = `scope-member-crossing${shadowed ? "-shadowed" : ""}.yaml`;
    it(`generated ${name}`, async () =>
      expect(mismatches(await loadGenerated(name, scopeMemberCrossing(shadowed)))).toEqual([]), 120_000);
  }
  it("generated top-level-crossing.yaml", async () =>
    expect(mismatches(await loadGenerated("top-level-crossing.yaml", topLevelCrossing()))).toEqual([]), 120_000);
  for (const topLevel of [false, true]) {
    const name = `scope-member-onward-crossing${topLevel ? "-top-level" : ""}.yaml`;
    it(`generated ${name}`, async () =>
      expect(mismatches(await loadGenerated(name, scopeMemberOnwardCrossing(topLevel)))).toEqual([]), 120_000);
  }
  it("generated view-only-status.yaml", async () =>
    expect(mismatches(await loadGenerated("view-only-status.yaml", viewOnlyStatus()))).toEqual([]), 120_000);
  it("generated shifted-consumer-name.yaml", async () =>
    expect(mismatches(await loadGenerated("shifted-consumer-name.yaml", shiftedConsumerName()))).toEqual([]), 120_000);
  it("generated drawn-out-order.yaml", async () =>
    expect(mismatches(await loadGenerated("drawn-out-order.yaml", drawnOutOrder()))).toEqual([]), 120_000);
  for (const [lead, named] of [[false, false], [true, false], [false, true]] as const) {
    const name = `nested-inline-places${lead ? "-lead" : ""}${named ? "-named" : ""}.yaml`;
    it(`generated ${name}`, async () =>
      expect(mismatches(await loadGenerated(name, nestedInlinePlaces(lead, named)))).toEqual([]), 120_000);
  }
  it("names no generated declaration in any analysis of the module suite", async () => {
    const found: string[] = [];
    const unloadable: Record<string, string> = {};
    const swept = moduleSuiteSources();
    expect(swept.length).toBeGreaterThan(0);
    for (const file of swept) {
      let loaded: Loaded;
      try {
        loaded = await loadFile(file);
      } catch (error) {
        unloadable[relative(ROOT, file).split(sep).join("/")] = error instanceof Error ? error.message.split("\n")[0]! : String(error);
        continue;
      }
      extractedNames.clear();
      rerouted.length = 0;
      authoredNames.clear();
      collectAuthoredNames(loaded.manifests);
      const diagnostics = new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      found.push(...unquotedUnderHolder().map((problem) => `${relative(ROOT, file).split(sep).join("/")}: ${problem}`));
      const written = expressionText(loaded.manifests);
      for (const d of diagnostics) {
        found.push(...namesWrittenByTheAuthor(d, [...extractedNames], written).map((problem) => `${relative(ROOT, file).split(sep).join("/")}: ${d.message}: ${problem}`));
      }
    }
    expect(found).toEqual([]);
    expect(unloadable).toEqual({});
  }, 3_000_000);
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    const name = `flag-sequence-in-try-${n}.yaml`;
    it(`generated ${name} (parity only)`, async () =>
      expect(mismatches(await loadGenerated(name, flagSequenceInTry(n)))).toEqual([]), 120_000);
  }
});
