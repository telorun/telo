/**
 * Writing a module's one version into every manifest it owns.
 *
 * A module has a single version across `telo.yaml`, `nodejs/package.json` and
 * `rust/Cargo.toml`. Three formats, one rule: find the scalar, splice over its
 * span, touch nothing else. That is `yaml-source-edit.ts`'s primitive — the same
 * one the quick fix, `telo migrate` and `telo upgrade`'s pin rewrite use — so a
 * bump lands as a one-line diff instead of a re-serialized file that re-folds
 * every block scalar in a 900-line manifest.
 *
 * Each stamp returns `undefined` when the file carries no version to write,
 * which is not an error: a module may own only a `telo.yaml`, and 42 of the
 * standard library's packages have no Rust crate. A file that *has* a version in
 * a shape this cannot address is a hard error instead, because silently skipping
 * it would publish an artifact whose manifests disagree about what it is.
 */

import { defaultCustomTags } from "@telorun/templating";
import { isScalar, parseAllDocuments, parseDocument, type Scalar } from "yaml";
import { applyTextEdits, renderFixReplacement } from "../yaml-source-edit.js";

export class VersionStampError extends Error {}

/** Replace the scalar at `[start, end)` with `version`, re-quoted in the
 *  author's own style. */
function spliceScalar(text: string, node: Scalar, version: string, where: string): string {
  const range = node.range;
  if (!range) {
    throw new VersionStampError(`${where}: the version scalar carries no source range.`);
  }
  const [start, end] = range;
  const source = text.slice(start, end);
  const replacement = renderFixReplacement(source, version);
  if (replacement === undefined) {
    throw new VersionStampError(
      `${where}: the version is written as '${source}', which cannot be rewritten in place. ` +
        `Write it as a plain or quoted scalar on one line.`,
    );
  }
  return applyTextEdits(text, [{ start, end, newText: replacement }]);
}

/**
 * `metadata.version` on the **module doc** — the first document, the one whose
 * kind is `Telo.Application` or `Telo.Library`. Deliberately not "any
 * `metadata.version` in the file": a `Telo.Definition` further down may carry
 * one, and the regex-replacement changie was configured with matched by line
 * shape rather than by position, which is why it needed a hand-maintained count
 * of how many lines it was allowed to hit.
 */
export function stampManifestVersion(
  text: string,
  version: string,
  where: string,
): string | undefined {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const doc = docs[0];
  if (!doc) return undefined;
  const metadata = doc.get("metadata", true);
  if (!metadata || typeof (metadata as { get?: unknown }).get !== "function") return undefined;
  const node = (metadata as { get(key: string, keepScalar: boolean): unknown }).get(
    "version",
    true,
  );
  if (!isScalar(node)) return undefined;
  return spliceScalar(text, node, version, where);
}

/** Read the module doc's `metadata.version` without rewriting it. */
export function readManifestVersion(text: string): string | undefined {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const first = docs[0]?.toJSON() as { kind?: unknown; metadata?: { version?: unknown } } | undefined;
  if (first?.kind !== "Telo.Application" && first?.kind !== "Telo.Library") return undefined;
  const version = first.metadata?.version;
  return typeof version === "string" ? version : undefined;
}

/**
 * The top-level `"version"` of a `package.json`.
 *
 * Parsed with the YAML reader rather than `JSON.parse`, because JSON is a YAML
 * subset and this one needs the node's *source range* — `JSON.parse` discards it,
 * and re-serializing with `JSON.stringify` would reformat a file whose
 * indentation, key order and trailing newline are all conventions someone chose.
 */
export function stampPackageVersion(
  text: string,
  version: string,
  where: string,
): string | undefined {
  const doc = parseDocument(text);
  const node = doc.get("version", true);
  if (!isScalar(node)) return undefined;
  return spliceScalar(text, node, version, where);
}

/**
 * `version` in a `Cargo.toml`'s `[package]` table.
 *
 * Scanned rather than parsed: TOML is not YAML, adding a TOML parser to the
 * browser-safe analyzer for one scalar is not a trade worth making, and the
 * shape being addressed is the canonical one cargo itself writes. The scan is
 * bounded to the `[package]` table so a `version` under `[dependencies.x]`
 * cannot be hit, and a `[package]` whose version is not a simple quoted scalar
 * is refused rather than guessed at.
 */
export function stampCrateVersion(
  text: string,
  version: string,
  where: string,
): string | undefined {
  const table = /^[ \t]*\[package\][ \t]*$/m.exec(text);
  if (!table) return undefined;
  const bodyStart = table.index + table[0].length;
  const next = /^[ \t]*\[/m.exec(text.slice(bodyStart));
  const bodyEnd = next ? bodyStart + next.index : text.length;

  const entry = /^([ \t]*version[ \t]*=[ \t]*)(".*?"|'.*?')[ \t]*$/m.exec(
    text.slice(bodyStart, bodyEnd),
  );
  if (!entry) {
    // A `[package]` with `version.workspace = true` inherits from the workspace
    // and genuinely has nothing here to stamp; anything else is a shape this
    // cannot address, and writing nothing would leave the crate behind.
    if (/^[ \t]*version[ \t]*\.[ \t]*workspace[ \t]*=/m.test(text.slice(bodyStart, bodyEnd))) {
      return undefined;
    }
    if (/^[ \t]*version[ \t]*=/m.test(text.slice(bodyStart, bodyEnd))) {
      throw new VersionStampError(
        `${where}: [package].version is not a quoted scalar on one line, so it cannot be ` +
          `rewritten in place.`,
      );
    }
    return undefined;
  }

  const start = bodyStart + entry.index + entry[1].length;
  const quote = entry[2][0];
  return applyTextEdits(text, [
    { start, end: start + entry[2].length, newText: `${quote}${version}${quote}` },
  ]);
}
