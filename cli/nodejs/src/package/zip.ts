import { inflateRawSync } from "node:zlib";

/**
 * One file out of a zip archive.
 *
 * The Windows carrier is a `.zip`, because that is what a Windows machine can
 * unpack without installing anything — `install.ps1` uses `Expand-Archive` and
 * the release builds it with `Compress-Archive`. Packaging for Windows from a
 * Linux or macOS host therefore has to read one, and shelling out to `unzip` is
 * not available: the CLI that does this is usually a single-file executable on a
 * machine that carries no such tool.
 *
 * Deliberately just enough to take one named entry out of an archive this
 * project publishes: the central directory, stored or deflated entries, no
 * zip64. An archive that needs more says so rather than being half-read.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The comment that may follow the end-of-central-directory record. */
const MAX_COMMENT = 0xffff;
/** A u32 field at its maximum means the real value is in a zip64 record. */
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipEntry {
  readonly name: string;
  readonly contents: Buffer;
}

/** Read one entry by exact name, or `undefined` when the archive does not hold
 *  it. Every other entry is skipped without being decompressed. */
export function readZipEntry(archive: Buffer, name: string): ZipEntry | undefined {
  for (const entry of centralDirectory(archive)) {
    if (entry.name !== name) continue;
    return { name: entry.name, contents: extract(archive, entry) };
  }
  return undefined;
}

/** Every entry's name, for reporting what an archive holds when the wanted one
 *  is not in it. */
export function zipEntryNames(archive: Buffer): string[] {
  return centralDirectory(archive).map((entry) => entry.name);
}

interface CentralEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function centralDirectory(archive: Buffer): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);
  if (at === ZIP64_SENTINEL) throw new Error("this zip archive is zip64, which telo does not read");

  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error("this zip archive's central directory is malformed");
    }
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    entries.push({
      method: archive.readUInt16LE(at + 10),
      compressedSize: archive.readUInt32LE(at + 20),
      uncompressedSize: archive.readUInt32LE(at + 24),
      localHeaderOffset: archive.readUInt32LE(at + 42),
      // Zip stores names with forward slashes, whatever wrote it.
      name: archive.subarray(at + 46, at + 46 + nameLength).toString("utf8").split("\\").join("/"),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let at = archive.length - EOCD_MIN_SIZE; at >= earliest; at--) {
    if (archive.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new Error("this file is not a zip archive (no end-of-central-directory record)");
}

function extract(archive: Buffer, entry: CentralEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (local + 30 > archive.length || archive.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`the zip entry '${entry.name}' has no local header`);
  }
  if (entry.compressedSize === ZIP64_SENTINEL || entry.uncompressedSize === ZIP64_SENTINEL) {
    throw new Error("this zip archive is zip64, which telo does not read");
  }
  const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
  const data = archive.subarray(start, start + entry.compressedSize);
  // Stored and deflated are the two methods anything in this project produces.
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(
    `the zip entry '${entry.name}' uses compression method ${entry.method}, which telo does not read`,
  );
}
