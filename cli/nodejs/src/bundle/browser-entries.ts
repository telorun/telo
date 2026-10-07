import type { ModuleFileClaim } from "@telorun/analyzer";
import { BROWSER_SIBLINGS_SUFFIX, buildBrowserEntries, readBrowserSiblings } from "@telorun/kernel";
import * as fs from "node:fs";
import * as path from "node:path";

/** What building a module's browser entries produced. */
export interface BuiltBrowserEntries {
  /** Every produced file's bytes, by module-root-relative POSIX path. */
  readonly files: Map<string, Uint8Array>;
  /** Per entry path, the files built beside it — its sidecar, its chunks, its
   *  stylesheet. They ship wherever the entry does. */
  readonly beside: Map<string, string[]>;
  /** Absolute paths of every file the builds read. */
  readonly inputs: string[];
}

/**
 * Refuse a module that declares a file where a browser entry's sidecar is
 * written. `<entry path>.siblings.json` is the build's: it records which files
 * the entry loads and ships in the entry's layer, so an author's file there
 * would either be replaced silently or be read as that record.
 *
 * `declared` is every module-relative path the author's manifest puts in the
 * payload.
 */
export function assertSidecarNamesFree(
  claims: readonly ModuleFileClaim[],
  declared: Iterable<string>,
): void {
  const reserved = new Map<string, string>();
  for (const claim of claims) {
    if (claim.role === "browser") {
      reserved.set(`${claim.path}${BROWSER_SIBLINGS_SUFFIX}`, claim.specifier);
    }
  }
  if (reserved.size === 0) return;
  for (const file of declared) {
    const specifier = reserved.get(file);
    if (specifier === undefined) continue;
    throw new Error(
      `'${file}' is a reserved name: building browser entry '${specifier}' writes the list of ` +
        `files that entry loads there. Rename the file, or stop declaring it.`,
    );
  }
}

/**
 * Build every `exports.browser:` entry a module declares, through the kernel's
 * builder — the one a source checkout serves from — one build per distinct
 * `external` set, so entries sharing a set share their chunks.
 *
 * An entry naming no `source` is refused: a browser entry is always built, so
 * it has to say what it is built from.
 */
export async function buildBrowserClaims(
  moduleDir: string,
  claims: readonly ModuleFileClaim[],
  cacheRoot: string,
): Promise<BuiltBrowserEntries> {
  const entries = claims.filter(
    (claim): claim is Extract<ModuleFileClaim, { role: "browser" }> => claim.role === "browser",
  );
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    if (!entry.localPath) {
      throw new Error(
        `browser entry '${entry.specifier}' names no 'source' (from ${entry.origin}). A browser ` +
          `entry is built, so it has to say what it is built from.`,
      );
    }
    const key = JSON.stringify(entry.external);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const files = new Map<string, Uint8Array>();
  const beside = new Map<string, string[]>();
  const inputs = new Set<string>();
  for (const group of groups.values()) {
    const result = await buildBrowserEntries(
      {
        moduleDir,
        external: group[0]!.external,
        entries: group.map((entry) => ({
          specifier: entry.specifier,
          source: path.resolve(moduleDir, entry.localPath!),
          path: entry.path,
          exports: entry.exports,
        })),
      },
      cacheRoot,
    );
    for (const file of result.files) {
      files.set(file, fs.readFileSync(path.join(result.directory, file)));
    }
    for (const input of result.inputs) inputs.add(input);
    for (const entry of group) {
      beside.set(entry.path, [
        `${entry.path}${BROWSER_SIBLINGS_SUFFIX}`,
        ...(await readBrowserSiblings(result.directory, entry.path)),
      ]);
    }
  }
  return { files, beside, inputs: [...inputs] };
}
