import { DEFAULT_MANIFEST_FILENAME, sha256Base64Url, type ArtifactLayer } from "@telorun/analyzer";
import * as fs from "fs/promises";
import * as path from "path";

import { findOwnerDoc, parseManifestDocs } from "./module-manifest.js";

/** A regular file of a payload layer; `executable` when it ships with its
 *  execute bit set. */
export interface PayloadRegularFile {
  /** POSIX-relative path inside the bundle. */
  name: string;
  content: Buffer | Uint8Array;
  executable?: boolean;
}

/** A symbolic link of a payload layer. `link` is the target exactly as the link
 *  stores it, relative to the link's own directory. */
export interface PayloadLink {
  /** POSIX-relative path inside the bundle. */
  name: string;
  link: string;
}

export type PayloadFile = PayloadRegularFile | PayloadLink;

/** A regular file known by its `sources:` pin rather than by bytes on disk — a
 *  staged file on a tree where nothing is staged. It digests exactly as the file
 *  it pins, and cannot be framed. */
export interface PayloadPinnedFile {
  /** POSIX-relative path inside the bundle. */
  name: string;
  /** Lowercase hex SHA-256 of the file's bytes, as the pin records it. */
  sha256: string;
  executable: boolean;
}

/** An entry a layer's integrity is computed over. */
export type LayerEntry = PayloadFile | PayloadPinnedFile;

export function isPayloadLink(file: LayerEntry): file is PayloadLink {
  return "link" in file;
}

export function isPinnedFile(file: LayerEntry): file is PayloadPinnedFile {
  return "sha256" in file;
}

/**
 * Canonical per-file content digest of one **layer**'s files — the `integrity`
 * value of that layer's entry in the published `layers:` index. SHA-256 over the
 * sorted lines of every file in the layer, `telo.yaml` excluded (it is the
 * manifest layer, which carries the index and so cannot hash itself; the
 * importer's `#sha256-...` pin covers it instead). The lines:
 *
 * - regular file: `<path>\0<sha256(content)>`
 * - executable file: `<path>\0<sha256(content)>\0x`
 * - symbolic link: `<path>\0l\0<target>`
 *
 * A regular file's line predates the other two and is unchanged, so every
 * integrity already published still verifies. The forms cannot collide: a path
 * holds no `\0`, and a digest is 43 base64url characters where `l` is one.
 *
 * Hashing file *contents* rather than the tar/gzip bytes makes the digest
 * independent of archive framing, so publisher and client compute the same
 * value from the same file set, and it can be re-derived from the extracted
 * files on disk ({@link readPayloadFile}) — which is what makes a per-layer
 * cache checkable without re-tarring, and why the execute bit and a link's
 * target are in the line. Distinct from the layer's `blob` digest, which covers
 * the pushed bytes and addresses the layer. Returns `sha256-<base64url>`.
 *
 * A pinned entry contributes the line of the file it pins, which is what lets a
 * tree with nothing staged compute the number publish derives from the bytes.
 */
export async function computeFilesIntegrity(files: readonly LayerEntry[]): Promise<string> {
  const lines: string[] = [];
  for (const file of files) {
    if (file.name === DEFAULT_MANIFEST_FILENAME) continue;
    if (isPayloadLink(file)) {
      lines.push(`${file.name}\0l\0${file.link}`);
      continue;
    }
    const digest = isPinnedFile(file)
      ? Buffer.from(file.sha256, "hex").toString("base64url")
      : await sha256Base64Url(
          file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content),
        );
    lines.push(file.executable ? `${file.name}\0${digest}\0x` : `${file.name}\0${digest}`);
  }
  lines.sort();
  return `sha256-${await sha256Base64Url(new TextEncoder().encode(lines.join("\n")))}`;
}

/**
 * Read one payload file off disk as the kind it is: a symbolic link as a link
 * (never followed), a file with any execute bit as executable. What publish
 * reads a module directory with; re-deriving a materialized layer's integrity
 * from disk reads it the same way.
 */
export async function readPayloadFile(dir: string, name: string): Promise<PayloadFile> {
  const abs = path.resolve(dir, name);
  const stat = await fs.lstat(abs);
  if (stat.isSymbolicLink()) return { name, link: (await fs.readlink(abs)).replace(/\\/g, "/") };
  if (!stat.isFile()) {
    throw new Error(`'${name}' is neither a regular file nor a symbolic link, so it cannot ship.`);
  }
  const content = await fs.readFile(abs);
  return (stat.mode & 0o111) !== 0 ? { name, content, executable: true } : { name, content };
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
