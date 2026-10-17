import type { LoadedModule } from "@telorun/analyzer";
import {
  emittedModuleKey,
  programsFromEmittedModule,
  type CelEnvironment,
  type EmittedModuleStore,
} from "@telorun/cel";
import type { Logger } from "@telorun/sdk";
import type { CelProgramSite } from "@telorun/templating";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * Load-time CEL compiled to JavaScript modules, under `<cache-root>/cel/`.
 *
 * The loader compiles every expression of a file against that file's one environment and
 * records each as a program site. Per file and environment the expressions are emitted as one
 * module, keyed by the engine (format, engine version, environment digest, the ordered
 * sources), stored as `<key>.mjs`, imported, and each site switched onto its emitted program —
 * before anything evaluates it. A later load imports the stored module; the engine verifies a
 * stored module's header and body before using it and re-emits one that does not match.
 *
 * Only a module on disk is imported: with no cache root, or a read-only cache that does not
 * hold the module, the sites keep their closure programs and nothing is emitted. A cache that
 * cannot be written is reported once and the load continues on closures, as the other caches
 * under the root do. A module that is on disk and cannot be imported fails the load, naming
 * the file.
 */
export class CelEmittedModules {
  private readonly adopted = new WeakMap<object, Promise<void>>();
  private readonly store: FileModuleStore | undefined;

  constructor(cacheRoot: string | undefined, options: { write: boolean; log: Logger }) {
    this.store = cacheRoot
      ? new FileModuleStore(path.join(cacheRoot, "cel"), options.write, options.log)
      : undefined;
  }

  /** Switch every program site of a loaded module's files onto its emitted program. */
  async adopt(module: LoadedModule): Promise<void> {
    const store = this.store;
    if (!store) return;
    for (const file of [module.owner, ...module.partials]) {
      const sites = file.celProgramSites;
      if (!sites || sites.length === 0) continue;
      // A file another load is already adopting is awaited, so no caller gets its
      // manifests back before the switch.
      let adopting = this.adopted.get(sites);
      if (!adopting) {
        adopting = adoptFile(sites, store);
        this.adopted.set(sites, adopting);
      }
      await adopting;
    }
  }
}

async function adoptFile(sites: readonly CelProgramSite[], store: FileModuleStore): Promise<void> {
  for (const [environment, group] of groupByEnvironment(sites)) {
    await adoptGroup(environment, group, store);
  }
}

async function adoptGroup(
  environment: CelEnvironment,
  sites: readonly CelProgramSite[],
  store: FileModuleStore,
): Promise<void> {
  const sources = [...new Set(sites.map((site) => site.source))];
  // A cache that cannot be written can only serve a module it already holds; emitting one
  // it would then discard is work with nothing to show for it.
  if (!store.canWrite() && !existsSync(store.pathOf(emittedModuleKey(environment.digest(), sources)))) {
    return;
  }
  const module = environment.emittedModule(sources, store);
  // An emitted module is on disk only once the store wrote it; a stale copy left beside a
  // failed write is never imported.
  if (module.emitted && !store.wrote(module.key)) return;
  const file = store.pathOf(module.key);
  let programs;
  try {
    const loaded = (await import(pathToFileURL(file).href)) as {
      readonly integrity?: unknown;
      readonly default?: unknown;
    };
    programs = programsFromEmittedModule(loaded, module, environment.emitterRuntime());
  } catch (error) {
    throw new Error(
      `telo: the emitted CEL module ${file} could not be loaded: ${messageOf(error)}. It is a derived cache; deleting it makes the next run emit it again.`,
      { cause: error },
    );
  }
  const bySource = new Map(sources.map((source, at) => [source, programs[at]!]));
  for (const site of sites) site.use(bySource.get(site.source)!);
}

function groupByEnvironment(
  sites: readonly CelProgramSite[],
): Map<CelEnvironment, CelProgramSite[]> {
  const groups = new Map<CelEnvironment, CelProgramSite[]>();
  for (const site of sites) {
    const group = groups.get(site.environment);
    if (group) group.push(site);
    else groups.set(site.environment, [site]);
  }
  return groups;
}

class FileModuleStore implements EmittedModuleStore {
  private writable: boolean;
  private directoryMade = false;
  private readonly written = new Set<string>();
  private readFailureReported = false;

  constructor(
    private readonly directory: string,
    write: boolean,
    private readonly log: Logger,
  ) {
    this.writable = write;
  }

  pathOf(key: string): string {
    return path.join(this.directory, `${key}.mjs`);
  }

  /** The host's SHA-256 — the engine's own runs in pure JavaScript, which is slow on a
   *  large module body. */
  digest(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  canWrite(): boolean {
    return this.writable;
  }

  wrote(key: string): boolean {
    return this.written.has(key);
  }

  read(key: string): string | undefined {
    const file = this.pathOf(key);
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      // Nothing is stored where the path does not exist, or where a part of it is not a
      // directory.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      if (!this.readFailureReported) {
        this.readFailureReported = true;
        this.log.warn(
          `telo: an emitted CEL module could not be read (${file}); it is emitted again: ${messageOf(error)}`,
        );
      }
      return undefined;
    }
  }

  write(key: string, text: string): void {
    if (!this.writable) return;
    const file = this.pathOf(key);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (!this.directoryMade) {
        mkdirSync(this.directory, { recursive: true });
        this.directoryMade = true;
      }
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      this.written.add(key);
    } catch (error) {
      // One report, then no more writes: the condition is the directory's, and every later
      // write would fail the same way.
      this.writable = false;
      let cleanup = "";
      try {
        rmSync(tmp, { force: true });
      } catch (removal) {
        cleanup = `; the partial file ${tmp} could not be removed: ${messageOf(removal)}`;
      }
      this.log.warn(
        `telo: the emitted CEL module cache at ${this.directory} cannot be written; expressions run on the closure backend: ${messageOf(error)}${cleanup}`,
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
