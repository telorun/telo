import {
  DEFAULT_MANIFEST_FILENAME,
  sha256Base64Url,
  type ArtifactLayer,
} from "@telorun/analyzer";

import { findOwnerDoc, parseManifestDocs } from "./module-manifest.js";

export interface PayloadFile {
  /** POSIX-relative path inside the bundle. */
  name: string;
  content: Buffer | Uint8Array;
}

/**
 * Canonical per-file content digest of one **layer**'s files — the `integrity`
 * value of that layer's entry in the published `layers:` index. SHA-256 over the
 * sorted `<path>\0<sha256(content)>` lines of every file in the layer,
 * `telo.yaml` excluded (it is the manifest layer, which carries the index and so
 * cannot hash itself; the importer's `#sha256-...` pin covers it instead).
 *
 * Hashing file *contents* rather than the tar/gzip bytes makes the digest
 * independent of archive framing, so publisher and client compute the same
 * value from the same file set, and it can be re-derived from the extracted
 * files on disk — which is what makes a per-layer cache marker checkable without
 * re-tarring. Distinct from the layer's `blob` digest, which covers the pushed
 * bytes and addresses the layer. Returns `sha256-<base64url>`.
 */
export async function computeFilesIntegrity(files: PayloadFile[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    if (file.name === DEFAULT_MANIFEST_FILENAME) continue;
    const bytes = file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content);
    lines.push(`${file.name}\0${await sha256Base64Url(bytes)}`);
  }
  lines.sort();
  const canonical = new TextEncoder().encode(lines.join("\n"));
  return `sha256-${await sha256Base64Url(canonical)}`;
}

/**
 * Write the `layers:` index onto the manifest's owner doc so the published
 * `telo.yaml` pins and addresses every payload layer — transitively covered by
 * importers' `#sha256-...` hash over this manifest.
 *
 * Called after the payload blobs are pushed and before the manifest blob is,
 * which is what keeps the index non-circular: it names only layers other than
 * the one carrying it. Each layer's own digest excludes `telo.yaml`, so
 * injecting the index does not invalidate any of them. Returns the manifest
 * unchanged when it has no owner doc.
 */
export function injectLayerIndex(manifest: string, layers: readonly ArtifactLayer[]): string {
  const docs = parseManifestDocs(manifest);
  const owner = findOwnerDoc(docs);
  if (!owner) return manifest;
  owner.set(
    "layers",
    layers.map((layer) => ({
      role: layer.role,
      ...(layer.selector ? { selector: { ...layer.selector } } : {}),
      blob: layer.blob,
      integrity: layer.integrity,
    })),
  );
  return docs.map((d) => d.toString()).join("---\n");
}
