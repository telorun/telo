import { gzip } from "node:zlib";
import { promisify } from "node:util";

import { normalizeBundlePath, type RunBundle } from "@telorun/runner-core";

const BLOCK = 512;
const gzipAsync = promisify(gzip);

/**
 * Minimal ustar + gzip writer — enough to ship a Telo bundle to a busybox
 * `tar xzf` initContainer without pulling a tar dependency. Bundle paths are
 * re-normalized (traversal-guarded) before they enter the archive. Gzip runs
 * async so a large, user-controlled bundle doesn't block the event loop (and
 * the runner's HTTP handling) during session creation.
 */
export async function makeBundleTarGz(bundle: RunBundle): Promise<Buffer> {
  const blocks: Buffer[] = [];
  for (const file of bundle.files) {
    const name = normalizeBundlePath(file.relativePath);
    // ustar names are capped at 100 bytes; truncating would risk path
    // collisions, so reject instead of silently shortening.
    if (Buffer.byteLength(name, "utf8") > 100) {
      throw new Error(`bundle path too long for tar (max 100 bytes): '${name}'`);
    }
    const content = Buffer.from(file.contents, "utf8");
    blocks.push(makeHeader(name, content.byteLength));
    blocks.push(padToBlock(content));
  }
  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipAsync(Buffer.concat(blocks));
}

function makeHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  writeString(header, name, 0, 100);
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, size, 124, 12); // size
  writeOctal(header, 0, 136, 12); // mtime (0 — reproducible)
  header.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii"); // magic
  header.write("00", 263, 2, "ascii"); // version

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += header[i]!;
  writeOctal(header, sum, 148, 8);
  return header;
}

function padToBlock(content: Buffer): Buffer {
  const remainder = content.byteLength % BLOCK;
  if (remainder === 0) return content;
  return Buffer.concat([content, Buffer.alloc(BLOCK - remainder)]);
}

function writeString(buf: Buffer, value: string, offset: number, length: number): void {
  buf.write(value, offset, length, "utf8");
}

/** ustar numeric fields are zero-padded octal, NUL-terminated. */
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const octal = value.toString(8);
  const padded = octal.padStart(length - 1, "0").slice(-(length - 1));
  buf.write(padded + "\0", offset, length, "ascii");
}
