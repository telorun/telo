/**
 * Writing a module's version into its `telo.yaml`: the module doc's
 * `metadata.version`, and the `pkg:npm` pins naming the module's own package.
 * Find the scalar, splice over its span, touch nothing else — the
 * `yaml-source-edit.ts` primitive the quick fix, `telo migrate` and `telo
 * upgrade`'s pin rewrite use — so a bump is a one-line diff rather than a
 * re-serialized manifest. The module's npm and Cargo packages are written by
 * their own ecosystems' handlers (`@telorun/release`).
 *
 * A stamp returns `undefined` when the file carries no version to write; a
 * version in a shape it cannot address is a hard error, because skipping it
 * would publish an artifact whose files disagree about what it is.
 */

import { defaultCustomTags } from "@telorun/templating";
import { isScalar, parseAllDocuments, type Scalar } from "yaml";
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

/**
 * `pkg:npm/<name>@<version>` candidates naming the module's OWN package.
 *
 * A module has one version, and its manifest pins the package it ships itself —
 * so the pin has to move with the rest of it. Left behind, the manifest names a
 * tarball older than the module describing it, which is exactly how an
 * npm-delivered module came to point at a years-old version of itself.
 *
 * Anchored on the `controllers:` SCALARS the YAML actually holds, not on a free
 * text match: this file's whole rule is find the scalar, splice its span, touch
 * nothing else, and a bare regex over the document would also reach a PURL
 * written in a description, an example or a comment. Matched by exact package
 * name, so a PURL naming a DIFFERENT package — a real dependency, pinned
 * deliberately — is untouched.
 */
export function stampSelfNpmPins(
  text: string,
  packageName: string,
  version: string,
  where = "controllers",
): string {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const prefix = `pkg:npm/${packageName}@`;
  const edits: { start: number; end: number; newText: string }[] = [];

  for (const doc of docs) {
    const controllers = doc.get("controllers", true);
    const items = (controllers as { items?: unknown[] } | undefined)?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const purl = item.value;
      if (!purl.startsWith(prefix)) continue;
      // Everything from the version up to the first qualifier or fragment is the
      // pin; the rest of the PURL (`?local_path=…#Export`) is carried through.
      const rest = purl.slice(prefix.length);
      const tail = rest.search(/[?#]/);
      const rewritten = `${prefix}${version}${tail === -1 ? "" : rest.slice(tail)}`;
      if (rewritten === purl) continue;
      const range = item.range;
      if (!range) {
        throw new VersionStampError(`${where}: a controller PURL carries no source range.`);
      }
      const [start, end] = range;
      const replacement = renderFixReplacement(text.slice(start, end), rewritten);
      if (replacement === undefined) {
        throw new VersionStampError(
          `${where}: the controller PURL '${purl}' cannot be rewritten in place. ` +
            `Write it as a plain or quoted scalar on one line.`,
        );
      }
      edits.push({ start, end, newText: replacement });
    }
  }

  return edits.length === 0 ? text : applyTextEdits(text, edits);
}

/** Read the module doc's `metadata.version` without rewriting it. */
export function readManifestVersion(text: string): string | undefined {
  const docs = parseAllDocuments(text, { customTags: defaultCustomTags() });
  const first = docs[0]?.toJSON() as { kind?: unknown; metadata?: { version?: unknown } } | undefined;
  if (first?.kind !== "Telo.Application" && first?.kind !== "Telo.Library") return undefined;
  const version = first.metadata?.version;
  return typeof version === "string" ? version : undefined;
}
