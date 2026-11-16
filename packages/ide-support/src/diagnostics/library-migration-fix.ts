import { planLibraryWriteBack, type LoadedGraph } from "@telorun/analyzer";

/** An edit of one file, as editor positions. */
export interface LibraryMigrationFixEdit {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  readonly newText: string;
}

/** The quick fix of the library migrations of one module: every file it edits. */
export interface LibraryMigrationFix {
  readonly title: string;
  /** The edits by file source. */
  readonly changes: ReadonlyMap<string, readonly LibraryMigrationFixEdit[]>;
}

function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, character: offset - lineStart };
}

/**
 * The edit set `telo migrate` writes for the module whose files include
 * `source`, offered as one quick fix when none of it is unwritable: a module
 * with a node `telo migrate` would leave as written gets no fix, since a
 * partial edit would leave the manifest half-repaired. Only the graph's entry
 * module has one — a dependency is repaired by naming it.
 */
export function libraryMigrationFix(graph: LoadedGraph, source: string): LibraryMigrationFix | undefined {
  const outcome = graph.libraryMigrations;
  const module = [...graph.modules.values()].find((m) => [m.owner, ...m.partials].some((f) => f.source === source));
  if (!outcome || !module || module.owner.source !== graph.rootSource) return undefined;
  const record = outcome.records.get(module.owner.source);
  if (!record) return undefined;
  const files = [module.owner, ...module.partials];
  if (files.some((file) => file.migrations.rewrites.length > 0)) return undefined;
  const plan = planLibraryWriteBack({
    record,
    files,
    originals: outcome.originals,
    findings: outcome.findings,
    handOvers: outcome.handOvers,
  });
  if (plan.unwritable.length > 0 || plan.edits.size === 0) return undefined;
  const changes = new Map<string, LibraryMigrationFixEdit[]>();
  for (const [file, edits] of plan.edits) {
    const text = files.find((f) => f.source === file)!.text;
    changes.set(
      file,
      edits.map((edit) => ({ start: positionAt(text, edit.start), end: positionAt(text, edit.end), newText: edit.newText })),
    );
  }
  return { title: "Apply the library migrations of this module", changes };
}

/** The codes of the library migrations that fired in the entry module of `graph`. */
export function firedLibraryMigrationCodes(graph: LoadedGraph): ReadonlySet<string> {
  return new Set(
    (graph.libraryMigrations?.findings ?? []).filter((f) => f.code !== "MIGRATION_FAILED").map((f) => f.code),
  );
}
