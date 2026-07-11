import { DEFAULT_MANIFEST_FILENAME, sha256Base64Url } from "@telorun/analyzer";

import { findOwnerDoc, parseManifestDocs } from "./module-manifest.js";

export interface PayloadFile {
  /** POSIX-relative path inside the bundle. */
  name: string;
  content: Buffer | Uint8Array;
}

/**
 * Canonical per-file content digest of a module's `files:` payload — the value
 * of `filesIntegrity` in a bundle's `telo.yaml`. SHA-256 over the sorted
 * `<path>\0<sha256(content)>` lines of every payload file, `telo.yaml`
 * excluded (the importer's `#sha256-...` hash already covers the manifest, and
 * excluding it breaks the self-reference — the manifest embeds this value).
 *
 * Hashing file *contents* rather than the tar/gzip bytes makes the digest
 * independent of archive framing, so publisher and client compute the same
 * value from the same file set, and it can be re-derived from the extracted
 * files on disk. Returns `sha256-<base64url>`.
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

/** Write `filesIntegrity` onto the manifest's owner doc so the published
 *  `telo.yaml` pins its payload — transitively covered by importers'
 *  `#sha256-...` hash. The digest excludes `telo.yaml`, so injecting it does
 *  not change the digest. Returns the manifest unchanged when it has no owner
 *  doc. */
export function injectFilesIntegrity(manifest: string, hash: string): string {
  const docs = parseManifestDocs(manifest);
  const owner = findOwnerDoc(docs);
  if (!owner) return manifest;
  owner.set("filesIntegrity", hash);
  return docs.map((d) => d.toString()).join("---\n");
}
