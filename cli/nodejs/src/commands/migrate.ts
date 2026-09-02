import { Loader, migrateFileText, type LoadedFile } from "@telorun/analyzer";
import { LocalFileSource } from "@telorun/kernel/manifest-sources/local-file-source";
import { defaultTransportRegistry } from "@telorun/kernel/transports";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Argv } from "yargs";
import { createLogger } from "../logger.js";
import { outErrLine, output } from "../output.js";


/**
 * `telo migrate` — the REFERENCE application of the migration operation, not
 * the only one. Applying pending migrations is an operation other commands
 * compose over a subset of entries; `telo upgrade` is the case that matters,
 * since it breaks a consumer's manifest by moving a pin and should repair what
 * it broke — applying the migrations of the modules it moved and nothing else,
 * so a version bump's diff carries no unrelated churn. That composition waits
 * on the module-migration surface, which is planned separately: with only core
 * entries there is no per-module subset to select.
 *
 * The rewrite has already happened in memory by the time anyone runs this — the
 * loader's migration phase makes the old spelling and the new one behave the
 * same — so this is a repair of the FILE, never a prerequisite for the manifest
 * to work.
 */

/** A file the command may write: local, and inside the entry's own module. An
 *  imported module is fetched, often read-only, and is not the consumer's to
 *  fix — the same rule that scopes the diagnostic. */
function writablePath(file: LoadedFile): string | null {
  if (!file.source.startsWith("file://")) return null;
  return fileURLToPath(file.source);
}

interface FileOutcome {
  filePath: string;
  /** Rewrite count per migration entry id, in first-seen order. */
  byEntry: Map<string, number>;
  /** Locations the in-memory rewrite accepted but this file's YAML could not
   *  express — a flow-style sequence, a block scalar span. They are REPORTED
   *  rather than dropped: the diagnostic that sent the author here says to run
   *  this command, so a silent skip would leave a warning with no way to act on
   *  it. Each needs a hand edit. */
  unwritable: Array<{ migration: string; path: string }>;
}

async function migrateOne(
  inputPath: string,
  loader: Loader,
): Promise<{ outcomes: FileOutcome[]; error?: string }> {
  const entryPath = path.resolve(process.cwd(), inputPath);

  let files: LoadedFile[];
  try {
    // Raw: no desugaring, no migration. The matchers select LEGACY spellings,
    // so a migrated tree would find nothing — and the edit target is the
    // author's own text, which only a raw load leaves paired with its manifest.
    const module = await loader.loadModule(entryPath);
    files = [module.owner, ...module.partials];
  } catch (err) {
    return { outcomes: [], error: err instanceof Error ? err.message : String(err) };
  }

  const outcomes: FileOutcome[] = [];
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
      // second input path resolving through this one re-reads it.
      loader.forget(file.source);
    }

    const byEntry = new Map<string, number>();
    for (const rewrite of migrated.rewrites) {
      byEntry.set(rewrite.entryId, (byEntry.get(rewrite.entryId) ?? 0) + 1);
    }
    outcomes.push({
      filePath,
      byEntry,
      unwritable: migrated.unwritable.map((r) => ({
        migration: r.entryId,
        path: r.legacyPath,
      })),
    });
  }
  return { outcomes };
}

export async function migrate(argv: { paths: string[] }): Promise<void> {
  const log = createLogger(false);
  const loader = new Loader([new LocalFileSource(), ...defaultTransportRegistry().sources()]);

  const out = output();
  const all: FileOutcome[] = [];
  let errors = 0;

  for (const inputPath of argv.paths) {
    const { outcomes, error } = await migrateOne(inputPath, loader);
    if (error) {
      errors++;
      outErrLine(`${log.err.error("✗")}  ${inputPath}: ${error}\n`);
      continue;
    }
    all.push(...outcomes);
  }

  let total = 0;
  let unwritable = 0;
  const written = all.filter((o) => o.byEntry.size > 0);
  for (const outcome of all) {
    const rel = path.relative(process.cwd(), outcome.filePath);
    for (const [entryId, count] of outcome.byEntry) {
      total += count;
      out.line(`${entryId}  ${rel}  ${count} rewrite${count === 1 ? "" : "s"}`);
    }
    for (const skipped of outcome.unwritable) {
      unwritable++;
      outErrLine(
        `${log.err.warn("!")}  ${skipped.migration}  ${rel}  ${skipped.path}  ` +
          `could not be rewritten in place (the YAML there cannot carry the edit) — fix it by hand\n`,
      );
    }
  }

  if (total === 0 && unwritable === 0) {
    out.line(`${log.ok("✓")}  Nothing to migrate`);
  } else if (total > 0) {
    const files = written.length;
    out.line(
      `\n${total} rewrite${total === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}. ` +
        `Imported modules were not touched.`,
    );
  }

  out.emit({
    ok: errors === 0,
    rewrites: total,
    unwritable,
    files: all.map((o) => ({
      file: path.relative(process.cwd(), o.filePath),
      rewrites: [...o.byEntry].map(([id, count]) => ({ migration: id, count })),
      unwritable: o.unwritable,
    })),
  });

  if (errors > 0) process.exitCode = 1;
}

export function migrateCommand(yargs: Argv): Argv {
  return yargs.command(
    "migrate <paths..>",
    "Rewrite legacy spellings in a manifest to their current form",
    (y) =>
      y
        .positional("paths", {
          describe: "Paths to YAML manifests or directories containing telo.yaml",
          type: "string",
          array: true,
          demandOption: true,
        }),
    async (argv) => {
      await migrate(argv as any);
    },
  );
}
