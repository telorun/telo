import {
  AnalysisRegistry,
  applyTextEdits,
  Loader,
  migrateFileText,
  planLibraryWriteBack,
  registerLoadedGraph,
  type LoadedFile,
  type LoadedGraph,
} from "@telorun/analyzer";
import { LocalFileSource } from "@telorun/kernel/manifest-sources/local-file-source";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { isScalar } from "yaml";
import type { Argv } from "yargs";
import { createLogger } from "../logger.js";
import { outErrLine, output } from "../output.js";

/**
 * `telo migrate` — the REFERENCE application of the migration operation, not
 * the only one. It repairs the FILES of the given modules in two steps: the core
 * migrations (tags, the definition grammar) are written first, then the library
 * migrations — what the libraries a module imports declare about their own
 * vocabulary — against the text the first step left. A path may name a Library
 * as well as an Application; only the named module's own files are written, so a
 * dependency is repaired by naming it.
 *
 * The rewrite has already happened in memory by the time anyone runs this — the
 * loader's migration phase and the library stage make the old spelling and the
 * new one behave the same — so this is a repair of the FILE, never a
 * prerequisite for the manifest to work. `telo upgrade` moves pins only; a node
 * needing a hand edit needs the new spelling, which only the new pin accepts.
 */

/** A file the command may write: local, and inside the entry's own module. An
 *  imported module is fetched, often read-only, and is not the consumer's to
 *  fix — the same rule that scopes the diagnostic. */
function writablePath(file: LoadedFile): string | null {
  if (!file.source.startsWith("file://")) return null;
  return fileURLToPath(file.source);
}

const relative = (filePath: string): string => path.relative(process.cwd(), filePath);

function displayPath(source: string): string {
  return source.startsWith("file://") ? relative(fileURLToPath(source)) : source;
}

interface MigrationLine {
  /** What the line is headed by: a core entry id, or `<CODE> (<module>)`. */
  label: string;
  module?: string;
  code?: string;
  count: number;
  unwritable: Array<{ path: string; reason: string }>;
  dropped: Array<{ line: number; column: number; text: string }>;
}

interface FileOutcome {
  filePath: string;
  /** Per migration, in first-seen order. */
  lines: Map<string, MigrationLine>;
}

interface FailedMigration {
  migration: string;
  module: string;
  file: string;
  path: string;
  message: string;
}

const linesFor = (outcome: FileOutcome, label: string, module?: string, code?: string): MigrationLine => {
  let line = outcome.lines.get(label);
  if (!line) {
    line = { label, module, code, count: 0, unwritable: [], dropped: [] };
    outcome.lines.set(label, line);
  }
  return line;
};

const pointerOf = (segments: readonly (string | number)[]): string =>
  `/${segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;

/** Segments of a dotted path (`a.b[0].c`). */
const segmentsOf = (dotted: string): (string | number)[] =>
  [...dotted.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]!));

/** Where the node at `segments` of a document starts, from its AST. */
function positionOf(file: LoadedFile, document: number, segments: readonly (string | number)[]): { line: number; column: number } | undefined {
  const doc = file.documents[document];
  const node = segments.length === 0 ? doc?.contents : doc?.getIn([...segments], true);
  const offset = (node as { range?: [number, number, number] } | null | undefined)?.range?.[0];
  if (offset === undefined) return undefined;
  const before = file.text.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** Why a core rewrite the tree accepted has no text edit. */
function coreReason(file: LoadedFile, documentIndex: number, legacyPath: string): string {
  const segments = segmentsOf(legacyPath);
  const range = file.positions[documentIndex]?.positionIndex.get(legacyPath);
  const at = range ? `${relative(fileURLToPath(file.source))}:${range.start.line + 1}:${range.start.character + 1}` : relative(fileURLToPath(file.source));
  const node = file.documents[documentIndex]?.getIn(segments, true);
  const cause =
    isScalar(node) && (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED")
      ? "sits in a block scalar, which cannot carry the edit"
      : "sits in YAML that cannot carry the edit";
  return `${at} (${pointerOf(segments)}) ${cause}. Fix it by hand.`;
}

async function migrateOne(
  inputPath: string,
  loader: Loader,
  outcomes: Map<string, FileOutcome>,
  failed: Map<string, FailedMigration>,
): Promise<{ error?: string }> {
  const entryPath = path.resolve(process.cwd(), inputPath);
  const outcomeOf = (filePath: string): FileOutcome => {
    let outcome = outcomes.get(filePath);
    if (!outcome) outcomes.set(filePath, (outcome = { filePath, lines: new Map() }));
    return outcome;
  };

  // Core migrations. Raw: no desugaring, no migration. The matchers select
  // LEGACY spellings, so a migrated tree would find nothing — and the edit target
  // is the author's own text, which only a raw load leaves paired with its
  // manifest.
  let files: LoadedFile[];
  try {
    const module = await loader.loadModule(entryPath);
    files = [module.owner, ...module.partials];
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  for (const file of files) {
    const filePath = writablePath(file);
    if (!filePath) continue;
    const migrated = migrateFileText({
      source: file.source,
      text: file.text,
      documents: file.documents,
      manifests: file.manifests,
    });
    if (!migrated) continue;
    if (migrated.rewrites.length > 0) {
      await fs.writeFile(filePath, migrated.text, "utf-8");
      // The written bytes are a different file; drop the loader's memo so a
      // later load through this path re-reads it.
      loader.forget(file.source);
    }
    const outcome = outcomeOf(filePath);
    for (const rewrite of migrated.rewrites) linesFor(outcome, rewrite.entryId).count++;
    for (const r of migrated.unwritable) {
      linesFor(outcome, r.entryId).unwritable.push({
        path: pointerOf(segmentsOf(r.legacyPath)),
        reason: coreReason(file, r.documentIndex, r.legacyPath),
      });
    }
  }

  // Library migrations, over the closure as the files stand now.
  let graph: LoadedGraph;
  try {
    graph = await loader.loadGraph(entryPath, { desugarImports: true, migrate: true });
    registerLoadedGraph(graph, new AnalysisRegistry());
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const outcome = graph.libraryMigrations;
  if (!outcome) return {};

  const fileOfSource = new Map<string, LoadedFile>();
  for (const mod of graph.modules.values()) for (const file of [mod.owner, ...mod.partials]) fileOfSource.set(file.source, file);

  for (const finding of outcome.findings) {
    if (finding.code !== "MIGRATION_FAILED") continue;
    const file = fileOfSource.get(finding.at.file);
    const range = file ? positionOf(file, finding.at.document, finding.at.path) : undefined;
    const failure: FailedMigration = {
      migration: finding.migration ?? finding.code,
      module: finding.library.module,
      file: displayPath(finding.at.file),
      path: pointerOf(finding.at.path),
      message: finding.cause ?? finding.message,
    };
    const key = JSON.stringify([failure.file, failure.path, failure.message]);
    if (failed.has(key)) continue;
    failed.set(key, failure);
    const at = range ? `${failure.file}:${range.line}:${range.column}` : failure.file;
    outErrLine(`${createLogger(false).err.error("✗")}  ${failure.migration}  ${at} (${failure.path})  ${failure.message}`);
  }

  const record = outcome.records.get(graph.rootSource);
  const root = graph.modules.get(graph.rootSource);
  if (!record || !root) return {};
  const own = [root.owner, ...root.partials];
  const blockedFiles = new Map<string, string>();
  for (const file of own) {
    const remaining = file.migrations.rewrites.length;
    if (remaining > 0) {
      blockedFiles.set(
        file.source,
        `${displayPath(file.source)} still holds a legacy spelling that could not be written (see above), so its library migrations wait. Fix it by hand and run again.`,
      );
    }
  }
  const plan = planLibraryWriteBack({
    record,
    files: own,
    originals: outcome.originals,
    findings: outcome.findings,
    handOvers: outcome.handOvers,
    fileLabel: displayPath,
    blockedFiles,
  });

  for (const [source, edits] of plan.edits) {
    const file = fileOfSource.get(source);
    const filePath = file && writablePath(file);
    if (!file || !filePath) continue;
    await fs.writeFile(filePath, applyTextEdits(file.text, edits), "utf-8");
    loader.forget(source);
  }
  const labelOf = (code: string, module: string) => (module ? `${code} (${module})` : code);
  const pathOfSource = (source: string): string | null => (source.startsWith("file://") ? fileURLToPath(source) : null);
  for (const rewrite of plan.rewrites) {
    const filePath = pathOfSource(rewrite.source);
    if (!filePath) continue;
    linesFor(outcomeOf(filePath), labelOf(rewrite.migration, rewrite.module), rewrite.module, rewrite.migration).count++;
  }
  for (const item of plan.unwritable) {
    const filePath = pathOfSource(item.source);
    if (!filePath) continue;
    linesFor(outcomeOf(filePath), labelOf(item.migration, item.module), item.module, item.migration).unwritable.push({
      path: item.path,
      reason: item.reason,
    });
  }
  for (const comment of plan.droppedComments) {
    const filePath = pathOfSource(comment.source);
    if (!filePath) continue;
    const owner = outcomeOf(filePath);
    const line = [...owner.lines.values()].find((l) => l.code === comment.migration) ?? [...owner.lines.values()][0];
    line?.dropped.push({ line: comment.line, column: comment.column, text: comment.text });
  }
  return {};
}

export async function migrate(argv: { paths: string[] }): Promise<void> {
  const log = createLogger(false);
  const loader = new Loader([new LocalFileSource(), ...defaultTransportRegistry().sources()]);

  const out = output();
  const outcomes = new Map<string, FileOutcome>();
  const failed = new Map<string, FailedMigration>();
  let errors = 0;

  for (const inputPath of argv.paths) {
    const { error } = await migrateOne(inputPath, loader, outcomes, failed);
    if (error) {
      errors++;
      outErrLine(`${log.err.error("✗")}  ${inputPath}: ${error}`);
    }
  }

  let total = 0;
  let unwritable = 0;
  const all = [...outcomes.values()].filter((o) => [...o.lines.values()].some((l) => l.count > 0 || l.unwritable.length > 0));
  const written = new Set<string>();
  for (const outcome of all) {
    const rel = relative(outcome.filePath);
    for (const line of outcome.lines.values()) {
      if (line.count === 0 && line.unwritable.length === 0) continue;
      if (line.count > 0) {
        total += line.count;
        written.add(outcome.filePath);
        out.line(`${line.label}  ${rel}  ${line.count} rewrite${line.count === 1 ? "" : "s"}`);
      } else {
        out.line(`${line.label}  ${rel}`);
      }
      for (const comment of line.dropped) {
        outErrLine(`  ${rel}:${comment.line}:${comment.column}  comment dropped: ${comment.text}`);
      }
      for (const skipped of line.unwritable) {
        unwritable++;
        outErrLine(`  not written: ${skipped.reason}`);
      }
    }
  }

  if (total === 0 && unwritable === 0 && failed.size === 0 && errors === 0) {
    out.line(`${log.ok("✓")}  Nothing to migrate`);
  } else if (total > 0 || unwritable > 0) {
    const files = written.size;
    out.line(
      `\n${total} rewrite${total === 1 ? "" : "s"}${total === 0 ? "" : ` in ${files} file${files === 1 ? "" : "s"}`}. ` +
        `Imported modules were not touched.`,
    );
  }

  const failing = errors > 0 || unwritable > 0 || failed.size > 0;
  out.emit({
    ok: !failing,
    rewrites: total,
    unwritable,
    files: all.map((o) => ({
      file: relative(o.filePath),
      rewrites: [...o.lines.values()]
        .filter((l) => l.count > 0)
        .map((l) => ({ migration: l.code ?? l.label, ...(l.module ? { module: l.module } : {}), count: l.count })),
      unwritable: [...o.lines.values()].flatMap((l) =>
        l.unwritable.map((u) => ({ migration: l.code ?? l.label, path: u.path, reason: u.reason })),
      ),
    })),
    failed: [...failed.values()],
  });

  if (failing) process.exitCode = 1;
}

export function migrateCommand(yargs: Argv): Argv {
  return yargs.command(
    "migrate <paths..>",
    "Rewrite legacy spellings in a module's own manifests — core and library migrations — to their current form",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to YAML manifests or directories containing telo.yaml — an Application or a Library",
          type: "string",
          array: true,
          demandOption: true,
        }),
    async (argv) => {
      await migrate(argv as any);
    },
  );
}
