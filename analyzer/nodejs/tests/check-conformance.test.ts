import { readdirSync, readFileSync, statSync } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectByPatterns } from "@telorun/glob";
import { describe, expect, it } from "vitest";
import { DependencyVerdictMemo } from "../src/dependency-verdicts.js";
import { locateDiagnostic } from "../src/diagnostic-location.js";
import { analyzeLoadedGraph } from "../src/graph-analysis.js";
import { Loader } from "../src/manifest-loader.js";
import { fileSourceFailure, ManifestSourceFailure } from "../src/sources/source-failure.js";
import { TELO_RUNNING_SURFACE } from "../src/telo-version.js";
import type { ManifestSource } from "../src/types.js";

/** `analyzer/check-conformance/`: each row is a manifest tree and what `telo check`
 *  reports for it — the entry's assembly plus every imported library's verdict — every
 *  diagnostic whole and at the range it is shown at. */
const VECTORS = fileURLToPath(new URL("../../check-conformance/vectors/", import.meta.url));

/** The filesystem as `telo check` reads it — the kernel's local file source: every source
 *  a `file://` URL, a directory read as its `telo.yaml`, a failure in Telo's words, an
 *  `include:` glob expanded over the owner's directory, and what a module file claim names
 *  answered from the disk. */
const fileSource: ManifestSource = {
  supports: (url) =>
    url.startsWith("file://") ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("../") ||
    (!url.includes("://") && !url.includes("@")),
  async read(url) {
    const path = resolve(url.startsWith("file://") ? fileURLToPath(url) : url);
    let directory: boolean;
    try {
      directory = statSync(path).isDirectory();
    } catch (error) {
      throw fileSourceFailure(error, pathToFileURL(path).href);
    }
    const file = directory ? join(path, "telo.yaml") : path;
    try {
      return { text: readFileSync(file, "utf8"), source: pathToFileURL(file).href };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (directory && (code === "ENOENT" || code === "ENOTDIR")) {
        throw new ManifestSourceFailure("not-a-module", pathToFileURL(path).href, { cause: error });
      }
      throw fileSourceFailure(error, pathToFileURL(file).href);
    }
  },
  resolveRelative: (base, relative) =>
    pathToFileURL(resolve(dirname(base.startsWith("file://") ? fileURLToPath(base) : base), relative)).href,
  async expandGlob(base, patterns) {
    const baseDir = dirname(resolve(base.startsWith("file://") ? fileURLToPath(base) : base));
    const rels = readdirSync(baseDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(baseDir, join(entry.parentPath, entry.name)).replace(/\\/g, "/"));
    return selectByPatterns(rels, patterns, { applyDefaultIgnore: false }).map(
      (rel) => pathToFileURL(resolve(baseDir, rel)).href,
    );
  },
  async entryAt(base, relative) {
    try {
      return (await stat(locate(base, relative))).isDirectory() ? "directory" : "file";
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  },
  async readHead(base, relative, length) {
    let handle: FileHandle;
    try {
      handle = await open(locate(base, relative), "r");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
      throw error;
    }
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EISDIR") return undefined;
      throw error;
    } finally {
      await handle.close();
    }
  },
  locate,
  async listDirectory(base, relative) {
    try {
      return await readdir(locate(base, relative));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  },
};

/** Where `relative` lies beside the module file `base`, as the local file source places it. */
function locate(base: string, relative: string): string {
  return resolve(dirname(resolve(base.startsWith("file://") ? fileURLToPath(base) : base)), relative);
}

/** `text` with the row directory's prefix removed, so a file reads relative to it with `/`
 *  separators on every platform. */
function relativeToRow(text: string, dir: string): string {
  const parts = text.split(`${pathToFileURL(dir).href}/`).join("").split(`${dir}${sep}`);
  if (sep === "/") return parts.join("");
  return parts
    .map((part, i) => (i === 0 ? part : part.replace(/^[^\s()'"`]*/, (path) => path.split(sep).join("/"))))
    .join("");
}

/** Every string relative to the row directory, then this build's running surface written
 *  as `<running-surface>`. */
function relativize(value: unknown, dir: string): unknown {
  if (typeof value === "string") {
    return relativeToRow(value, dir).split(TELO_RUNNING_SURFACE).join("<running-surface>");
  }
  if (Array.isArray(value)) return value.map((item) => relativize(item, dir));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relativize(item, dir)]));
  }
  return value;
}

/** The canonical sort: by each diagnostic's JSON text with keys sorted at every depth,
 *  compared by code point. */
function sorted(diagnostics: unknown[]): unknown[] {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as any)[key])]))
        : value;
  const text = (value: unknown) => Buffer.from(JSON.stringify(canonical(value)), "utf8");
  return [...diagnostics].sort((a, b) => Buffer.compare(text(a), text(b)));
}

describe("check conformance", () => {
  for (const id of readdirSync(VECTORS)) {
    it(id, async () => {
      const dir = join(VECTORS, id);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      expect(Object.keys(expected).sort()).toEqual(["diagnostics", "runFails"]);
      const graph = await new Loader([fileSource]).loadGraph(join(dir, "telo.yaml"), {
        desugarImports: true,
        migrate: true,
      });
      const { diagnostics: reported } = await analyzeLoadedGraph(graph, {
        hostVersions: { node: process.versions.node },
        memo: new DependencyVerdictMemo(),
      });
      const diagnostics = reported.map((d) => {
        const located = locateDiagnostic(graph, d);
        const shown = JSON.parse(JSON.stringify(d));
        delete shown.range;
        if (located) shown.range = located.range;
        return relativize(shown, dir);
      });
      expect(sorted(diagnostics)).toEqual(sorted(expected.diagnostics));
    });
  }
});
