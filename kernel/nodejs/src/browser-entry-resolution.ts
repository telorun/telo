import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { BrowserEntry, LoadedGraph } from "@telorun/analyzer";
import { RuntimeError, type BrowserEntryFiles } from "@telorun/sdk";

import { computeFilesIntegrity } from "./bundle/files-integrity.js";
import type { ModuleArtifact } from "./bundle/module-artifact.js";
import {
  BrowserSidecarError,
  buildBrowserEntries,
  readBrowserSiblings,
  type BrowserBuildGroup,
} from "./controller-loaders/browser-bundle-builder.js";

/** The module a browser entry is resolved against. */
export interface BrowserEntryModule {
  /** Canonical source of the module's `telo.yaml`. */
  readonly source: string;
  /** The module's `metadata.name`, when it declares one. */
  readonly name?: string;
  readonly browser: readonly BrowserEntry[];
}

export interface BrowserEntryHost {
  getModuleArtifact(source: string | undefined): ModuleArtifact | undefined;
  getCacheRoot(): string | undefined;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function unknownEntry(specifier: string, module: BrowserEntryModule | undefined, asked: string): RuntimeError {
  const declared = module?.browser.map((entry) => `'${entry.specifier}'`) ?? [];
  return new RuntimeError(
    "ERR_BROWSER_ENTRY_UNKNOWN",
    `${asked}: no browser entry '${specifier}'. ` +
      (module === undefined
        ? `The module was not loaded from a manifest, so it declares none.`
        : declared.length > 0
          ? `Its module declares ${declared.join(", ")} under exports.browser.`
          : `Its module declares no exports.browser entry.`),
  );
}

const describeModule = (module: BrowserEntryModule) =>
  module.name === undefined ? `'${module.source}'` : `'${module.name}' (${module.source})`;

/**
 * The canonical sources of the modules each module imports directly, keyed by
 * its owner's source: an import declared in an `include:` partial is the
 * module's own.
 */
export function directImportSources(graph: Pick<LoadedGraph, "modules" | "importEdges">): Map<string, string[]> {
  const ownerOf = new Map<string, string>();
  for (const [, module] of graph.modules) {
    ownerOf.set(module.owner.source, module.owner.source);
    for (const partial of module.partials) ownerOf.set(partial.source, module.owner.source);
  }
  const out = new Map<string, string[]>();
  for (const [declaringFile, edges] of graph.importEdges) {
    const owner = ownerOf.get(declaringFile) ?? declaringFile;
    const targets = out.get(owner) ?? [];
    for (const [, edge] of edges) {
      const target = graph.modules.get(edge.targetSource)?.owner.source ?? edge.targetSource;
      if (!targets.includes(target)) targets.push(target);
    }
    out.set(owner, targets);
  }
  return out;
}

/**
 * The module a controller's browser entry is resolved against: the module
 * declaring the controller's kind when it declares `specifier`, otherwise the
 * one module among its direct imports that does. Two such imports is
 * `ERR_BROWSER_ENTRY_AMBIGUOUS`, naming both; none is `ERR_BROWSER_ENTRY_UNKNOWN`.
 */
export function controllerBrowserEntryModule(
  specifier: string,
  module: BrowserEntryModule | undefined,
  imports: readonly BrowserEntryModule[],
  asked: string,
): BrowserEntryModule {
  const declares = (candidate: BrowserEntryModule) =>
    candidate.browser.some((entry) => entry.specifier === specifier);
  if (!module) throw unknownEntry(specifier, module, asked);
  if (declares(module)) return module;
  const declaring = imports.filter(declares);
  if (declaring.length === 1) return declaring[0]!;
  if (declaring.length > 1) {
    throw new RuntimeError(
      "ERR_BROWSER_ENTRY_AMBIGUOUS",
      `${asked}: browser entry '${specifier}' is not declared by the module declaring this ` +
        `kind, and ${declaring.length} of the modules it imports declare it: ` +
        `${declaring.map(describeModule).join(" and ")}. Declare the entry in the module ` +
        `itself, or import only one module that declares it.`,
    );
  }
  const reachable = imports.flatMap((imported) => imported.browser.map((entry) => `'${entry.specifier}'`));
  throw new RuntimeError(
    "ERR_BROWSER_ENTRY_UNKNOWN",
    `${asked}: no browser entry '${specifier}'. ` +
      (module.browser.length > 0
        ? `Its module declares ${module.browser.map((entry) => `'${entry.specifier}'`).join(", ")} under exports.browser`
        : `Its module declares no exports.browser entry`) +
      (reachable.length > 0
        ? `, and the modules it imports declare ${reachable.join(", ")}.`
        : `, and none of the modules it imports declares one.`),
  );
}

/** The entries built with `entry`: every one of the module declaring the
 *  identical `external` set that names a source. */
function buildGroupOf(entry: BrowserEntry, module: BrowserEntryModule, moduleDir: string): BrowserBuildGroup {
  const same = (other: BrowserEntry) =>
    other.localPath !== undefined &&
    other.external.length === entry.external.length &&
    other.external.every((name, i) => name === entry.external[i]);
  return {
    moduleDir,
    external: entry.external,
    entries: module.browser.filter(same).map((member) => ({
      specifier: member.specifier,
      source: path.resolve(moduleDir, member.localPath!),
      path: member.path,
      exports: member.exports,
    })),
  };
}

/**
 * Resolve a browser entry by its specifier against `module`: the built file, the
 * files built beside it, and a digest over all of them.
 *
 * From a published artifact the entry's `browser` layer is materialized,
 * verified before extraction. From a source checkout the entry is built from its
 * `source`, together with every entry of the module that shares its `external`
 * set, into the kernel's cache. Either way the files it loads are read from the
 * sidecar its build wrote beside it, and a sidecar that is missing, malformed or
 * names a file outside that directory is `ERR_BROWSER_ENTRY_UNAVAILABLE`.
 */
export async function resolveBrowserEntryFiles(
  specifier: string,
  module: BrowserEntryModule | undefined,
  host: BrowserEntryHost,
  asked: string,
): Promise<BrowserEntryFiles> {
  const entry = module?.browser.find((candidate) => candidate.specifier === specifier);
  if (!module || !entry) throw unknownEntry(specifier, module, asked);

  let directory: string;
  const artifact = host.getModuleArtifact(module.source);
  if (artifact) {
    const layer = await artifact.materializeBrowser(entry.selector);
    if (!layer) {
      throw new RuntimeError(
        "ERR_BROWSER_ENTRY_UNAVAILABLE",
        `${asked}: the published artifact of the module declaring browser entry '${specifier}' ` +
          `ships no browser layer for it. It ships: ${artifact.describeLayers()}. The module has ` +
          `to be republished.`,
      );
    }
    directory = layer.dir;
  } else {
    const local = module.source.startsWith("file://")
      ? fileURLToPath(module.source)
      : path.isAbsolute(module.source)
        ? module.source
        : undefined;
    if (local === undefined) {
      throw new RuntimeError(
        "ERR_BROWSER_ENTRY_UNAVAILABLE",
        `${asked}: browser entry '${specifier}' belongs to module '${module.source}', whose ` +
          `artifact carries no layer index, so its files cannot be located. Republish the ` +
          `module, or import it from a local path during development.`,
      );
    }
    const moduleDir = path.dirname(local);
    const hasSource =
      entry.localPath !== undefined && (await isFile(path.resolve(moduleDir, entry.localPath)));
    if (hasSource) {
      const cacheRoot = host.getCacheRoot();
      if (!cacheRoot) {
        throw new RuntimeError(
          "ERR_BROWSER_BUILD_FAILED",
          `${asked}: browser entry '${specifier}' must be built from source, and this kernel has ` +
            `no cache directory to build it into.`,
        );
      }
      directory = (await buildBrowserEntries(buildGroupOf(entry, module, moduleDir), cacheRoot)).directory;
    } else if (await isFile(path.join(moduleDir, entry.path))) {
      // A module carried built (a packaged application) ships no sources: the
      // entry and the sidecar its build wrote are at the path the manifest names.
      directory = moduleDir;
    } else {
      throw new RuntimeError(
        "ERR_BROWSER_BUILD_FAILED",
        `${asked}: browser entry '${specifier}' cannot be built — ` +
          (entry.localPath === undefined
            ? `it names no 'source'`
            : `its source '${entry.localPath}' is not a file`) +
          `, and no built '${entry.path}' is on disk either. A module read from a source ` +
          `checkout builds the entry from the 'source' it names in ${path.join(moduleDir, "telo.yaml")}.`,
      );
    }
  }

  let siblings: string[];
  try {
    siblings = await readBrowserSiblings(directory, entry.path);
  } catch (err) {
    if (!(err instanceof BrowserSidecarError)) throw err;
    throw new RuntimeError(
      "ERR_BROWSER_ENTRY_UNAVAILABLE",
      `${asked}: browser entry '${specifier}' cannot be served from ${directory} — ${err.message} ` +
        `The sidecar is written by the entry's build and says which files the entry loads; ` +
        `without a readable one nothing of the entry is served.`,
    );
  }
  const files = [entry.path, ...siblings];
  const digest = await computeFilesIntegrity(
    await Promise.all(
      files.map(async (name) => ({ name, content: await fs.readFile(path.join(directory, name)) })),
    ),
  );
  const uri = (name: string) => pathToFileURL(path.join(directory, name)).href;
  return {
    specifier,
    file: uri(entry.path),
    siblings: siblings.map(uri),
    digest,
    ...(entry.abi !== undefined ? { abi: entry.abi } : {}),
    external: [...entry.external],
    exports: [...entry.exports],
  };
}
