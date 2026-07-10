import { sha256Base64Url } from "@telorun/analyzer";

const MANIFEST_FILENAME = "telo.yaml";

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
    if (file.name === MANIFEST_FILENAME) continue;
    const bytes = file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content);
    lines.push(`${file.name}\0${await sha256Base64Url(bytes)}`);
  }
  lines.sort();
  const canonical = new TextEncoder().encode(lines.join("\n"));
  return `sha256-${await sha256Base64Url(canonical)}`;
}
