/**
 * Which libraries ship inside the module being published.
 *
 * A library whose manifest lies inside the directory of the PUBLISH ROOT — the
 * module named on the command line — is embedded in the root's artifact; one
 * outside it is published as a separate artifact. Decided from paths on disk,
 * against the root and never the immediate importer, so a nested library
 * importing another library elsewhere under the root embeds it too.
 */

import { DEFAULT_MANIFEST_FILENAME, splitIntegrity } from "@telorun/analyzer";
import { defaultCustomTags } from "@telorun/templating";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import { findModuleDoc, importSourceRefs } from "../commands/manifest-imports.js";
import { PublishFailure } from "../publish-failure.js";

/** The directory a publish root owns, and every library inside it. */
export interface RootScope {
  /** Absolute manifest path of the module named on the command line. */
  readonly manifestPath: string;
  /** Its directory. */
  readonly dir: string;
  /** Absolute manifest paths of every library shipped inside it, transitively. */
  readonly nested: readonly string[];
}

export function isRelativeSource(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/");
}

/** Whether `target` lies inside `dir` (and is not `dir` itself). */
export function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A relative `imports:` source resolved to the manifest it names. */
export function resolveImportedManifest(manifestDir: string, source: string): string {
  const resolved = path.resolve(manifestDir, source);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, DEFAULT_MANIFEST_FILENAME);
    }
  } catch {
    throw new Error(`import source '${source}' does not resolve to a file or directory on disk.`);
  }
  return resolved;
}

/** The relative imports a manifest declares, each resolved to its manifest. */
export function relativeImportTargets(
  manifestPath: string,
): { alias: string; source: string; manifestPath: string }[] {
  const docs = parseAllDocuments(fs.readFileSync(manifestPath, "utf8"), {
    customTags: defaultCustomTags(),
  });
  const moduleDoc = findModuleDoc(docs);
  if (!moduleDoc) return [];
  const dir = path.dirname(manifestPath);
  return importSourceRefs(moduleDoc)
    .filter((entry) => isRelativeSource(entry.source))
    .map((entry) => ({
      alias: entry.alias,
      source: entry.source,
      manifestPath: resolveImportedManifest(dir, splitIntegrity(entry.source).base),
    }));
}

/**
 * The libraries inside the root's directory that its import graph reaches —
 * through nested libraries too. Reads manifest text only; builds nothing.
 */
export function rootScopeOf(rootManifestPath: string): RootScope {
  const manifestPath = path.resolve(rootManifestPath);
  const dir = path.dirname(manifestPath);
  const nested: string[] = [];
  const seen = new Set<string>([manifestPath]);
  const visit = (manifest: string): void => {
    for (const target of relativeImportTargets(manifest)) {
      if (!isInside(dir, target.manifestPath) || seen.has(target.manifestPath)) continue;
      seen.add(target.manifestPath);
      nested.push(target.manifestPath);
      visit(target.manifestPath);
    }
  };
  visit(manifestPath);
  return { manifestPath, dir, nested };
}

/** The nested library's manifest path inside the artifact, `/`-separated. */
export function nestedArtifactPath(scope: RootScope, manifestPath: string): string {
  const relative = path.relative(scope.dir, manifestPath).split(path.sep).join("/");
  if (relative === DEFAULT_MANIFEST_FILENAME) {
    throw new Error(
      `'${manifestPath}' is imported by '${scope.manifestPath}' but would take the artifact's ` +
        `own ${DEFAULT_MANIFEST_FILENAME} path; rename it.`,
    );
  }
  return relative;
}

/**
 * The directories of nested libraries that sit strictly inside `manifestDir`:
 * a nested directory belongs to its library, so this module's own file
 * selection leaves them out.
 */
export function ownedNestedDirectories(scope: RootScope, manifestDir: string): string[] {
  return scope.nested
    .filter((manifest) => path.basename(manifest) === DEFAULT_MANIFEST_FILENAME)
    .map((manifest) => path.dirname(manifest))
    .filter((dir) => isInside(manifestDir, dir));
}

/**
 * Refuse an import that leaves the publish root and lands inside another
 * module's directory: that library ships inside the module enclosing it, so it
 * has no artifact of its own to be addressed by.
 *
 * Walks up from the target, below the nearest directory holding both the
 * importer and the target, to the nearest directory holding a module's
 * `telo.yaml`.
 */
export function assertNotNestedElsewhere(
  importerManifest: string,
  targetManifest: string,
  alias: string,
  publishRoot: string,
): void {
  const relativeToRoot = (file: string): string =>
    path.relative(publishRoot, file).split(path.sep).join("/");
  const importerDir = path.dirname(importerManifest);
  let ceiling = importerDir;
  while (ceiling !== path.dirname(ceiling) && path.relative(ceiling, targetManifest).startsWith("..")) {
    ceiling = path.dirname(ceiling);
  }
  let dir = path.dirname(targetManifest);
  // A directory-form target IS its directory's module; its enclosing module is above.
  if (path.basename(targetManifest) === DEFAULT_MANIFEST_FILENAME) dir = path.dirname(dir);
  while (isInside(ceiling, dir)) {
    const enclosing = path.join(dir, DEFAULT_MANIFEST_FILENAME);
    if (fs.existsSync(enclosing) && enclosing !== path.resolve(importerManifest)) {
      const enclosingName = path.relative(ceiling, dir).split(path.sep).join("/");
      throw new PublishFailure(
        "import_nested",
        `import '${alias}' reaches '${relativeToRoot(targetManifest)}', which lies inside the module ` +
          `'${enclosingName}' (${relativeToRoot(enclosing)}). A library inside a module's directory ` +
          `ships inside that module's artifact and is not published on its own — move the library ` +
          `out of '${enclosingName}' to share it.`,
        {
          alias,
          target: relativeToRoot(targetManifest),
          module: enclosingName,
          enclosing: relativeToRoot(enclosing),
        },
      );
    }
    dir = path.dirname(dir);
  }
}
