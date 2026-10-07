import { RuntimeError } from "@telorun/sdk";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadEsbuild } from "./esbuild-runtime.js";

/**
 * Build a module's **browser entries** — the ES modules its `exports.browser:`
 * block names — from their sources. The browser variant of
 * `source-bundle-builder.ts`: one builder for the run path (a source checkout,
 * built on first use) and the publish path (the `browser` layer), so what a
 * contributor serves is what ships.
 *
 * ## Why entries are built together
 *
 * A page that loads two entries of one module must not get two copies of what
 * they share. Making one entry external to the other does not work for the
 * dependencies that matter most: a CommonJS package is wrapped at bundle time,
 * and a wrapped package reaching another through an external specifier is a
 * `require()` no browser can answer. So every entry of a module that declares
 * the IDENTICAL `external` set is one build with code splitting, and the shared
 * code lands in chunks both import. Entries with different `external` sets are
 * separate builds and share nothing.
 *
 * ## What a build produces
 *
 * Each entry at its declared `path`, a stylesheet beside it when its sources
 * import one, the chunks the group shares, and — beside every entry — a
 * `<path>.siblings.json` listing the other files that entry needs:
 * `{ "files": [ { "path": "<module-relative POSIX path>" } ] }`, sorted by
 * `path`. The sidecar is what lets a reader holding only the files (a published
 * layer, extracted) answer "what does this entry load" without a metafile. It
 * is inside the layer's integrity, so it is serialized one way; a reader
 * ignores members it does not know, and serves no file the sidecar names that
 * is not a regular file inside the directory the sidecar is in.
 *
 * ## How the cache is keyed
 *
 * As a controller build is: stat-addressed over every input esbuild reported,
 * plus the options and the group's own declarations, with each build written to
 * a private directory and renamed into place.
 */

const CACHE_DIR = "browser-src";

/** Suffix of the per-entry sidecar listing the files built beside it. The name
 *  is reserved: no author-declared file may sit at `<entry path><suffix>`. */
export const BROWSER_SIBLINGS_SUFFIX = ".siblings.json";

/** Moves when what a build writes changes, so a cached build of the previous
 *  layout is not served. */
const BUILD_LAYOUT = 2;

/**
 * The esbuild options a browser entry is built with. Beside
 * `CONTROLLER_BUNDLE_OPTIONS`, and unlike it: the output runs in a page, so
 * there is no `require` banner and no realm external — the only names left out
 * of a bundle are the ones the entry's own `external` list hands to the host.
 */
const BROWSER_BUNDLE_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  splitting: true,
  conditions: ["source"],
  define: { "process.env.NODE_ENV": '"production"' },
} as const;

/** One entry of a build group. */
export interface BrowserBuildEntry {
  readonly specifier: string;
  /** Absolute path of the entry's source. */
  readonly source: string;
  /** Module-root-relative POSIX path of the built file. */
  readonly path: string;
  /** Export names the built entry must have. */
  readonly exports: readonly string[];
}

/** The entries of one module that declare the identical `external` set. */
export interface BrowserBuildGroup {
  /** Absolute module root: what every `path` is relative to. */
  readonly moduleDir: string;
  readonly external: readonly string[];
  readonly entries: readonly BrowserBuildEntry[];
}

/** A built group, on disk. */
export interface BuiltBrowserGroup {
  /** The directory holding every built file at its module-root-relative path. */
  readonly directory: string;
  /** Every built file, sidecars included, as module-root-relative POSIX paths. */
  readonly files: readonly string[];
  /** Absolute paths of every file the build read. */
  readonly inputs: readonly string[];
}

interface BuildIndexEntry {
  inputs: string[];
  key: string;
  files: string[];
}

function fingerprint(group: BrowserBuildGroup): string {
  return createHash("sha256")
    .update(JSON.stringify(BROWSER_BUNDLE_OPTIONS))
    .update("\n")
    .update(String(BUILD_LAYOUT))
    .update("\n")
    .update(JSON.stringify([...group.external].sort()))
    .update("\n")
    .update(
      JSON.stringify(
        group.entries.map((e) => [e.specifier, e.source, e.path, [...e.exports].sort()]),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

async function signInputs(inputs: readonly string[], group: BrowserBuildGroup): Promise<string | null> {
  const stats = await Promise.all(
    inputs.map(async (file) => {
      try {
        const stat = await fs.stat(file);
        return `${file}\0${stat.size}\0${stat.mtimeMs}`;
      } catch {
        return null;
      }
    }),
  );
  if (stats.some((entry) => entry === null)) return null;
  return createHash("sha256")
    .update(fingerprint(group))
    .update("\n")
    .update(stats.join("\n"))
    .digest("hex")
    .slice(0, 32);
}

function groupId(group: BrowserBuildGroup): string {
  return createHash("sha256")
    .update(group.moduleDir)
    .update("\n")
    .update(JSON.stringify([...group.external].sort()))
    .update("\n")
    .update(JSON.stringify(group.entries.map((e) => e.path).sort()))
    .digest("hex")
    .slice(0, 32);
}

async function readIndex(file: string): Promise<BuildIndexEntry | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as BuildIndexEntry;
    return Array.isArray(parsed.inputs) && Array.isArray(parsed.files) && typeof parsed.key === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const buildsInFlight = new Map<string, Promise<BuiltBrowserGroup>>();
let tmpCounter = 0;

function failure(group: BrowserBuildGroup, detail: string): RuntimeError {
  const names = group.entries.map((e) => `'${e.specifier}'`).join(", ");
  return new RuntimeError(
    "ERR_BROWSER_BUILD_FAILED",
    `Failed to build browser ${group.entries.length === 1 ? "entry" : "entries"} ${names} of ` +
      `the module at ${group.moduleDir}:\n${detail}`,
  );
}

/**
 * The built files of `group`, building them when the cache holds none that
 * match. Throws `ERR_BROWSER_BUILD_FAILED` when the group does not build —
 * there is no prebuilt file to fall back to, on either path.
 */
export async function buildBrowserEntries(
  group: BrowserBuildGroup,
  cacheRoot: string,
): Promise<BuiltBrowserGroup> {
  const cacheDir = path.join(cacheRoot, CACHE_DIR);
  const id = groupId(group);
  const indexFile = path.join(cacheDir, `${id}.index.json`);
  const index = await readIndex(indexFile);
  if (index) {
    const key = await signInputs(index.inputs, group);
    const directory = path.join(cacheDir, index.key);
    if (key === index.key && (await exists(directory))) {
      return { directory, files: index.files, inputs: index.inputs };
    }
  }
  const inFlight = buildsInFlight.get(id);
  if (inFlight) return inFlight;
  const work = build(group, cacheDir, indexFile).finally(() => buildsInFlight.delete(id));
  buildsInFlight.set(id, work);
  return work;
}

const posix = (file: string): string => file.split(path.sep).join("/");

async function build(
  group: BrowserBuildGroup,
  cacheDir: string,
  indexFile: string,
): Promise<BuiltBrowserGroup> {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    throw failure(
      group,
      "esbuild is not installed. Building a browser entry from source needs it; a published " +
        "module ships its entries built.",
    );
  }
  const extensions = new Set(group.entries.map((e) => path.posix.extname(e.path)));
  const [extension] = extensions;
  if (extensions.size !== 1 || (extension !== ".js" && extension !== ".mjs")) {
    throw failure(
      group,
      `entries built together must share one of the extensions '.js' or '.mjs'; their paths are ` +
        `${group.entries.map((e) => `'${e.path}'`).join(", ")}.`,
    );
  }
  const stem = (file: string) => file.slice(0, -extension.length);
  const chunkDir = path.posix.join(path.posix.dirname(group.entries[0]!.path), "chunks");

  // esbuild resolves links in its working directory and names every output
  // relative to the result, so the root it is given is the resolved one.
  let root: string;
  try {
    root = await fs.realpath(group.moduleDir);
  } catch (err) {
    throw failure(group, err instanceof Error ? err.message : String(err));
  }

  let built: import("esbuild").BuildResult<{ write: false; metafile: true }>;
  try {
    built = await esbuild.build({
      ...BROWSER_BUNDLE_OPTIONS,
      conditions: [...BROWSER_BUNDLE_OPTIONS.conditions],
      define: { ...BROWSER_BUNDLE_OPTIONS.define },
      external: [...group.external],
      entryPoints: group.entries.map((e) => ({ in: e.source, out: stem(e.path) })),
      absWorkingDir: root,
      outdir: root,
      outExtension: { ".js": extension },
      chunkNames: `${chunkDir}/[name]-[hash]`,
      assetNames: `${chunkDir}/[name]-[hash]`,
      write: false,
      metafile: true,
      logLevel: "silent",
    });
  } catch (err) {
    throw failure(group, err instanceof Error ? err.message : String(err));
  }

  const outputs = built.metafile.outputs;
  const contents = new Map<string, Uint8Array>();
  for (const file of built.outputFiles) {
    contents.set(posix(path.relative(root, file.path)), file.contents);
  }

  for (const entry of group.entries) {
    const output = outputs[entry.path];
    if (!output) throw failure(group, `esbuild produced no output for '${entry.specifier}'.`);
    const missing = entry.exports.filter((name) => !output.exports.includes(name));
    if (missing.length > 0) {
      throw failure(
        group,
        `'${entry.specifier}' declares ${missing.length === 1 ? "the export" : "the exports"} ` +
          `${missing.map((n) => `'${n}'`).join(", ")}, which '${path.relative(group.moduleDir, entry.source)}' ` +
          `does not export. It exports: ${output.exports.join(", ") || "(nothing)"}.`,
      );
    }
    // Everything the entry loads: the chunks it imports, transitively, and the
    // stylesheet built beside any of them.
    const siblings = new Set<string>();
    const queue = [entry.path];
    while (queue.length > 0) {
      const current = outputs[queue.pop()!];
      if (!current) continue;
      const next = [
        ...current.imports.filter((i) => !i.external).map((i) => i.path),
        ...(current.cssBundle ? [current.cssBundle] : []),
      ];
      for (const file of next) {
        if (file === entry.path || siblings.has(file)) continue;
        siblings.add(file);
        queue.push(file);
      }
    }
    contents.set(
      `${entry.path}${BROWSER_SIBLINGS_SUFFIX}`,
      new TextEncoder().encode(serializeBrowserSiblings([...siblings])),
    );
  }

  // An input inside the module keeps the caller's spelling of the module root.
  const inputs = Object.keys(built.metafile.inputs).map((rel) =>
    rel.startsWith("..") || path.isAbsolute(rel)
      ? path.resolve(root, rel)
      : path.join(group.moduleDir, rel),
  );
  const files = [...contents.keys()].sort();
  const key =
    (await signInputs(inputs, group)) ??
    createHash("sha256").update(fingerprint(group)).update(files.join("\n")).digest("hex").slice(0, 32);
  const directory = path.join(cacheDir, key);

  if (!(await exists(directory))) {
    const tmp = `${directory}.${process.pid}.${tmpCounter++}.tmp`;
    for (const [file, content] of contents) {
      const target = path.join(tmp, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    try {
      await fs.rename(tmp, directory);
    } catch (err) {
      // A peer building the same key won the rename; its bytes are these bytes.
      await fs.rm(tmp, { force: true, recursive: true });
      if (!(await exists(directory))) throw err;
    }
  }
  const superseded = (await readIndex(indexFile))?.key;
  const tmpIndex = `${indexFile}.${process.pid}.${tmpCounter++}.tmp`;
  await fs.writeFile(tmpIndex, JSON.stringify({ inputs, key, files } satisfies BuildIndexEntry));
  await fs.rename(tmpIndex, indexFile);
  if (superseded && superseded !== key) {
    await fs.rm(path.join(cacheDir, superseded), { force: true, recursive: true }).catch(() => {});
  }
  return { directory, files, inputs };
}

/** The sidecar's bytes for `files`: one serialization, since the sidecar is
 *  inside its layer's integrity. */
export function serializeBrowserSiblings(files: readonly string[]): string {
  const sorted = [...new Set(files)].sort();
  return `${JSON.stringify({ files: sorted.map((file) => ({ path: file })) })}\n`;
}

/** A sidecar that cannot be served from: absent, not the declared shape, or
 *  naming a file outside the directory it is in. */
export class BrowserSidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSidecarError";
  }
}

/** Refuse `file` unless it names a regular file inside `directory`. */
async function assertConfined(directory: string, file: string, sidecar: string): Promise<void> {
  const escapes =
    file === "" ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    file.split(/[\\/]/).includes("..");
  if (escapes) {
    throw new BrowserSidecarError(
      `'${sidecar}' names '${file}', which is not a path inside the directory the sidecar is in.`,
    );
  }
  const root = await fs.realpath(directory);
  let real: string;
  try {
    real = await fs.realpath(path.join(directory, file));
  } catch {
    throw new BrowserSidecarError(`'${sidecar}' names '${file}', and there is no such file.`);
  }
  if (!real.startsWith(root + path.sep)) {
    throw new BrowserSidecarError(
      `'${sidecar}' names '${file}', which leads outside the directory the sidecar is in.`,
    );
  }
  if (!(await fs.stat(real)).isFile()) {
    throw new BrowserSidecarError(`'${sidecar}' names '${file}', which is not a regular file.`);
  }
}

/**
 * The files an entry needs beside itself, read from the sidecar its build wrote
 * next to it. Members the reader does not know are ignored, at both levels.
 * Throws {@link BrowserSidecarError} for a sidecar that is absent or malformed,
 * and for a listed path that is not a regular file inside `directory` — such a
 * path is never read or served.
 */
export async function readBrowserSiblings(directory: string, entryPath: string): Promise<string[]> {
  const name = `${entryPath}${BROWSER_SIBLINGS_SUFFIX}`;
  let text: string;
  try {
    text = await fs.readFile(path.join(directory, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new BrowserSidecarError(`'${name}' is missing beside the entry it describes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BrowserSidecarError(
      `'${name}' is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const files =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { files?: unknown }).files
      : undefined;
  const paths = Array.isArray(files)
    ? files.map((item) =>
        item !== null && typeof item === "object" ? (item as { path?: unknown }).path : undefined,
      )
    : undefined;
  if (!paths || paths.some((file) => typeof file !== "string")) {
    throw new BrowserSidecarError(
      `'${name}' is not of the shape { "files": [ { "path": "<file>" } ] }.`,
    );
  }
  for (const file of paths as string[]) await assertConfined(directory, file, name);
  return paths as string[];
}
