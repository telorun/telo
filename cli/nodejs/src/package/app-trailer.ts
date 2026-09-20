import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

/**
 * Where a packaged application's payload lives inside its carrier, and how it is
 * found again.
 *
 * The payload is followed by a fixed trailer ending in a magic, and the payload
 * is the `length` bytes immediately BEFORE that trailer. Nothing records an
 * absolute offset, which is what lets one reader serve both placements: on ELF
 * and PE the pair is appended, so the trailer ends the file; on Mach-O it rides
 * inside a segment, because data after `__LINKEDIT` is what "main executable
 * failed strict validation" means and an unsigned arm64 binary does not launch
 * at all.
 *
 * A carrier with no payload is an ordinary `telo`, which is why the read is one
 * 52-byte tail read before anything else happens.
 */

/** Ends the trailer, and says the bytes before it are a telo application. */
export const APP_MAGIC = Buffer.from("TELOAPP1", "ascii");

/** `version` (u32) + `length` (u64) + sha256 (32) + magic (8). */
export const TRAILER_SIZE = 4 + 8 + 32 + APP_MAGIC.length;

/** Bumped when this layout changes. A reader that does not know a version
 *  refuses rather than guessing at the fields behind it. */
export const APP_FORMAT_VERSION = 1;

/** The Mach-O segment the payload rides in, and the section (also the postject
 *  resource name) inside it. Both are within Mach-O's 16-character limit. */
export const MACHO_SEGMENT = "TELO_APP";
export const MACHO_SECTION = "TELO_APP_PAYLOAD";

export interface EmbeddedPayload {
  readonly bytes: Buffer;
  /** How it was carried, for `telo package inspect` to report. */
  readonly placement: "appended" | "macho-segment";
}

export function encodeTrailer(payload: Buffer): Buffer {
  const trailer = Buffer.alloc(TRAILER_SIZE);
  trailer.writeUInt32LE(APP_FORMAT_VERSION, 0);
  trailer.writeBigUInt64LE(BigInt(payload.length), 4);
  createHash("sha256").update(payload).digest().copy(trailer, 12);
  APP_MAGIC.copy(trailer, 44);
  return trailer;
}

/** The payload digest, which names the unpack directory and keys nothing else. */
export function payloadDigest(payload: Buffer): string {
  return createHash("sha256").update(payload).digest("hex");
}

interface Trailer {
  readonly version: number;
  readonly length: number;
  readonly digest: Buffer;
}

/** Read a trailer out of the last `TRAILER_SIZE` bytes of `tail`, or
 *  `undefined` when they do not end in the magic. */
function decodeTrailer(tail: Buffer): Trailer | undefined {
  if (tail.length < TRAILER_SIZE) return undefined;
  const start = tail.length - TRAILER_SIZE;
  if (!tail.subarray(start + 44, start + 52).equals(APP_MAGIC)) return undefined;
  return {
    version: tail.readUInt32LE(start),
    length: Number(tail.readBigUInt64LE(start + 4)),
    digest: Buffer.from(tail.subarray(start + 12, start + 44)),
  };
}

/** A trailer's own verdict on the bytes it describes. The digest is checked
 *  here rather than by each caller: a magic can occur by accident inside a
 *  140 MB binary's own data, and the digest is what separates that from a
 *  payload. */
function verify(trailer: Trailer, payload: Buffer, where: string): Buffer {
  if (trailer.version !== APP_FORMAT_VERSION) {
    throw new Error(
      `${where} carries a telo application in format version ${trailer.version}, ` +
        `which this telo (format ${APP_FORMAT_VERSION}) cannot read.`,
    );
  }
  const actual = createHash("sha256").update(payload).digest();
  if (!actual.equals(trailer.digest)) {
    throw new Error(
      `${where} carries a telo application whose payload does not match its digest ` +
        `(expected sha256:${trailer.digest.toString("hex")}, read sha256:${actual.toString("hex")}). ` +
        `The file is truncated or modified.`,
    );
  }
  return payload;
}

/**
 * The payload embedded in `file`, or `undefined` when it carries none.
 *
 * Two lookups, in the order that costs least: the tail read every `telo`
 * startup pays, then — only for a Mach-O — a walk of its load commands.
 */
export async function readEmbeddedPayload(file: string): Promise<EmbeddedPayload | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < TRAILER_SIZE) return undefined;

    const tail = Buffer.alloc(TRAILER_SIZE);
    await handle.read(tail, 0, TRAILER_SIZE, size - TRAILER_SIZE);
    const appended = decodeTrailer(tail);
    if (appended) {
      const start = size - TRAILER_SIZE - appended.length;
      if (start < 0) {
        throw new Error(
          `${file} carries a telo application trailer claiming ${appended.length} payload bytes, ` +
            `which is more than the file holds.`,
        );
      }
      const bytes = Buffer.alloc(appended.length);
      await handle.read(bytes, 0, appended.length, start);
      return { bytes: verify(appended, bytes, file), placement: "appended" };
    }

    const section = await machoSection(handle, size);
    if (!section) return undefined;
    const carried = Buffer.alloc(section.size);
    await handle.read(carried, 0, section.size, section.offset);
    const embedded = decodeTrailer(carried);
    if (!embedded) return undefined;
    const payload = carried.subarray(
      carried.length - TRAILER_SIZE - embedded.length,
      carried.length - TRAILER_SIZE,
    );
    return { bytes: verify(embedded, payload, file), placement: "macho-segment" };
  } finally {
    await handle.close();
  }
}

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;
const MACHO_HEADER_SIZE = 32;
const SEGMENT_COMMAND_SIZE = 72;
const SECTION_SIZE = 80;

/** The `TELO_APP,TELO_APP_PAYLOAD` section of a 64-bit little-endian Mach-O.
 *
 *  Only that one shape is read: every carrier is a single-architecture build for
 *  a little-endian target, so a universal binary is something this did not
 *  produce and is reported rather than guessed at. */
async function machoSection(
  handle: fs.FileHandle,
  size: number,
): Promise<{ offset: number; size: number } | undefined> {
  const header = Buffer.alloc(MACHO_HEADER_SIZE);
  await handle.read(header, 0, MACHO_HEADER_SIZE, 0);
  const magic = header.readUInt32LE(0);
  if (magic === FAT_MAGIC || header.readUInt32BE(0) === FAT_MAGIC) {
    throw new Error(
      "this executable is a universal (fat) Mach-O binary, which telo does not package into or read a payload out of.",
    );
  }
  if (magic !== MH_MAGIC_64 && magic !== MH_CIGAM_64) return undefined;
  if (magic === MH_CIGAM_64) {
    throw new Error("this executable is a big-endian Mach-O binary, which telo does not read.");
  }

  const ncmds = header.readUInt32LE(16);
  const sizeofcmds = header.readUInt32LE(20);
  if (sizeofcmds === 0 || MACHO_HEADER_SIZE + sizeofcmds > size) return undefined;
  const commands = Buffer.alloc(sizeofcmds);
  await handle.read(commands, 0, sizeofcmds, MACHO_HEADER_SIZE);

  let at = 0;
  for (let i = 0; i < ncmds && at + 8 <= sizeofcmds; i++) {
    const cmd = commands.readUInt32LE(at);
    const cmdsize = commands.readUInt32LE(at + 4);
    if (cmdsize < 8 || at + cmdsize > sizeofcmds) return undefined;
    if (cmd === LC_SEGMENT_64 && cmdsize >= SEGMENT_COMMAND_SIZE) {
      const segname = cString(commands, at + 8, 16);
      if (segname === MACHO_SEGMENT) {
        const nsects = commands.readUInt32LE(at + 64);
        for (let s = 0; s < nsects; s++) {
          const section = at + SEGMENT_COMMAND_SIZE + s * SECTION_SIZE;
          if (section + SECTION_SIZE > sizeofcmds) return undefined;
          if (cString(commands, section, 16) !== MACHO_SECTION) continue;
          return {
            size: Number(commands.readBigUInt64LE(section + 40)),
            offset: commands.readUInt32LE(section + 48),
          };
        }
      }
    }
    at += cmdsize;
  }
  return undefined;
}

/** A fixed-width Mach-O name field, which pads with NULs and does not terminate
 *  a name that fills the field. */
function cString(buf: Buffer, at: number, width: number): string {
  const raw = buf.subarray(at, at + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? width : end).toString("ascii");
}
