/**
 * Reading and rewriting a module's `telo.yaml` on the way to the artifact.
 *
 * These three transforms sit between the author's manifest and the published
 * one, and both gates that care about the published bytes — `telo publish` and
 * `telo release` — go through them. They were inside the publish command, which
 * is where a second copy would have appeared the moment anything else needed to
 * know what a module ships.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultCustomTags } from "@telorun/templating";
import { parseAllDocuments } from "yaml";
import { selectFiles } from "./select-files.js";

/**
 * Resolve `include:` globs and inline each partial as an extra document, then
 * drop the `include:` key.
 *
 * The declaring file does not exist in the artifact, which is why every
 * module-relative path in a manifest is module-ROOT-relative rather than
 * relative to the file it was written in.
 */
export function expandAndInlineIncludes(content: string, manifestDir: string): string {
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const firstParsed = docs[0]?.toJSON();
  if (!firstParsed || !Array.isArray(firstParsed.include) || firstParsed.include.length === 0) {
    return content;
  }

  const patterns: string[] = firstParsed.include.filter(
    (p: unknown): p is string => typeof p === "string",
  );
  if (patterns.length === 0) return content;

  // A glob entry is matched with the shared `ignore` engine (gitignore
  // semantics); a plain path is taken verbatim and validated to exist — an
  // explicit `include:` of a missing file is an error, unlike a glob that
  // simply matches nothing.
  const hasGlobs = patterns.some((p) => /[*?{}\[\]!]/.test(p));
  let resolvedFiles: string[];

  if (hasGlobs) {
    resolvedFiles = selectFiles(manifestDir, patterns, { applyDefaultIgnore: false }).map((rel) =>
      path.resolve(manifestDir, rel),
    );
  } else {
    resolvedFiles = [...new Set(patterns.map((p) => path.resolve(manifestDir, p)))];

    const realManifestDir = fs.realpathSync(manifestDir) + path.sep;
    for (const filePath of resolvedFiles) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`Included file not found: ${filePath}`);
      }
      const realPath = fs.realpathSync(filePath);
      if (!realPath.startsWith(realManifestDir)) {
        throw new Error(
          `Include path '${filePath}' resolves outside the module directory. ` +
            `Publishing files from outside the module root is not allowed.`,
        );
      }
    }
  }

  docs[0].deleteIn(["include"]);

  let inlined = "";
  for (const filePath of resolvedFiles) {
    const partialContent = fs.readFileSync(filePath, "utf-8").trim();
    if (!partialContent) continue;
    inlined += "\n---\n" + partialContent + "\n";
  }

  const serialized = docs.map((d) => d.toString()).join("---\n");
  return serialized + inlined;
}

/** The owner doc's `files:` globs — the payload set the manifest cannot
 *  otherwise name. Empty when none are declared. */
export function readFilesPatterns(content: string): string[] {
  return readPatternField(content, "files");
}

/** The owner doc's `assets:` globs — the author-claimed subset of `files:` that
 *  ships in the lazily materialized asset layer. */
export function readAssetPatterns(content: string): string[] {
  return readPatternField(content, "assets");
}

/** The owner doc's `metadata.version` — the tag this artifact publishes under,
 *  and so the version every drift check compares against. */
export function readOwnerVersion(content: string): string | undefined {
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const first = docs[0]?.toJSON() as { metadata?: { version?: unknown } } | undefined;
  const version = first?.metadata?.version;
  return typeof version === "string" ? version : undefined;
}

function readPatternField(content: string, field: "files" | "assets"): string[] {
  const docs = parseAllDocuments(content, { customTags: defaultCustomTags() });
  const first = docs[0]?.toJSON();
  const value = first?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((p: unknown): p is string => typeof p === "string");
}
