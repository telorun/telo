/**
 * The headers of a PE image (a Windows executable): the section table and the
 * data directories, read without reading the image itself. One reader serves
 * both halves — a start finding its payload reads it over a file handle, and
 * packaging reads it over the carrier's bytes before rewriting them.
 */

/** Reads `length` bytes at `offset`; fewer at the end of the file. */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>;

export const DOS_MAGIC = 0x5a4d;
export const PE_SIGNATURE = 0x00004550;
export const PE32_MAGIC = 0x10b;
export const PE32_PLUS_MAGIC = 0x20b;
export const SECTION_HEADER_SIZE = 40;
const COFF_HEADER_SIZE = 20;

/** Offsets inside the optional header, the same for PE32 and PE32+. */
export const OPTIONAL = {
  sizeOfInitializedData: 8,
  sectionAlignment: 32,
  fileAlignment: 36,
  sizeOfImage: 56,
  sizeOfHeaders: 60,
  checkSum: 64,
  subsystem: 68,
} as const;

/** The data directories this code reads or writes, by index. */
export const DIRECTORY = {
  resource: 2,
  security: 4,
  debug: 6,
  boundImport: 11,
} as const;

export const SUBSYSTEM_WINDOWS_GUI = 2;

export interface PeSection {
  readonly name: string;
  readonly virtualSize: number;
  readonly virtualAddress: number;
  readonly sizeOfRawData: number;
  readonly pointerToRawData: number;
  readonly characteristics: number;
  /** File offset of this section's header. */
  readonly headerOffset: number;
}

export interface PeDirectory {
  readonly rva: number;
  readonly size: number;
}

export interface PeImage {
  /** File offset of the COFF header. */
  readonly coffOffset: number;
  readonly optionalOffset: number;
  readonly magic: number;
  readonly sectionAlignment: number;
  readonly fileAlignment: number;
  readonly sizeOfHeaders: number;
  readonly sizeOfImage: number;
  /** File offset of the first data directory, and how many there are. */
  readonly directoriesOffset: number;
  readonly directoryCount: number;
  readonly directories: readonly PeDirectory[];
  /** File offset of the section table. */
  readonly sectionTableOffset: number;
  readonly sections: readonly PeSection[];
}

/** The PE headers of a file, or `undefined` for one that is not a PE image. */
export async function readPeImage(readAt: ReadAt, fileSize: number): Promise<PeImage | undefined> {
  const dos = await readAt(0, 64);
  if (dos.length < 64 || dos.readUInt16LE(0) !== DOS_MAGIC) return undefined;
  const peOffset = dos.readUInt32LE(60);
  if (peOffset + 4 + COFF_HEADER_SIZE > fileSize) return undefined;
  const coff = await readAt(peOffset, 4 + COFF_HEADER_SIZE);
  if (coff.length < 4 + COFF_HEADER_SIZE || coff.readUInt32LE(0) !== PE_SIGNATURE) return undefined;
  const sectionCount = coff.readUInt16LE(6);
  const optionalSize = coff.readUInt16LE(20);
  const optionalOffset = peOffset + 4 + COFF_HEADER_SIZE;
  const optional = await readAt(optionalOffset, optionalSize);
  if (optional.length < optionalSize || optionalSize < 2) return undefined;
  const magic = optional.readUInt16LE(0);
  const countAt = magic === PE32_PLUS_MAGIC ? 108 : magic === PE32_MAGIC ? 92 : -1;
  if (countAt < 0 || optionalSize < countAt + 4) return undefined;
  const directoryCount = Math.min(optional.readUInt32LE(countAt), Math.floor((optionalSize - countAt - 4) / 8));
  const directories: PeDirectory[] = [];
  for (let i = 0; i < directoryCount; i++) {
    directories.push({ rva: optional.readUInt32LE(countAt + 4 + i * 8), size: optional.readUInt32LE(countAt + 8 + i * 8) });
  }
  const sectionTableOffset = optionalOffset + optionalSize;
  const table = await readAt(sectionTableOffset, sectionCount * SECTION_HEADER_SIZE);
  if (table.length < sectionCount * SECTION_HEADER_SIZE) return undefined;
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = i * SECTION_HEADER_SIZE;
    const raw = table.subarray(at, at + 8);
    const end = raw.indexOf(0);
    sections.push({
      name: raw.subarray(0, end === -1 ? 8 : end).toString("latin1"),
      virtualSize: table.readUInt32LE(at + 8),
      virtualAddress: table.readUInt32LE(at + 12),
      sizeOfRawData: table.readUInt32LE(at + 16),
      pointerToRawData: table.readUInt32LE(at + 20),
      characteristics: table.readUInt32LE(at + 36),
      headerOffset: sectionTableOffset + at,
    });
  }
  return {
    coffOffset: peOffset + 4,
    optionalOffset,
    magic,
    sectionAlignment: optional.readUInt32LE(OPTIONAL.sectionAlignment),
    fileAlignment: optional.readUInt32LE(OPTIONAL.fileAlignment),
    sizeOfHeaders: optional.readUInt32LE(OPTIONAL.sizeOfHeaders),
    sizeOfImage: optional.readUInt32LE(OPTIONAL.sizeOfImage),
    directoriesOffset: optionalOffset + countAt + 4,
    directoryCount,
    directories,
    sectionTableOffset,
    sections,
  };
}

/** The section holding `rva` in its file bytes. */
export function sectionOf(image: PeImage, rva: number): PeSection | undefined {
  return image.sections.find(
    (section) => rva >= section.virtualAddress && rva < section.virtualAddress + section.sizeOfRawData,
  );
}

/** The file offset of `rva`, when its bytes are in the file. */
export function fileOffsetOf(image: PeImage, rva: number): number | undefined {
  const section = sectionOf(image, rva);
  return section ? section.pointerToRawData + (rva - section.virtualAddress) : undefined;
}

/** Where the sections' bytes end in the file: what follows is the certificate table and any overlay. */
export function endOfSectionData(image: PeImage): number {
  return image.sections.reduce(
    (end, section) => (section.sizeOfRawData ? Math.max(end, section.pointerToRawData + section.sizeOfRawData) : end),
    image.sizeOfHeaders,
  );
}

/** A `ReadAt` over bytes already in memory. */
export function bufferReader(bytes: Buffer): ReadAt {
  return async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length));
}

export function alignUp(value: number, alignment: number): number {
  return alignment > 0 ? Math.ceil(value / alignment) * alignment : value;
}

/**
 * The PE checksum (`CheckSumMappedFile`): the file summed as 16-bit words with
 * the carry folded back in, the checksum field itself skipped, plus the length.
 */
export function peChecksum(bytes: Buffer, checksumOffset: number): number {
  let sum = 0;
  const even = bytes.length & ~1;
  for (let i = 0; i < even; i += 2) {
    if (i === checksumOffset || i === checksumOffset + 2) continue;
    sum += bytes[i]! | (bytes[i + 1]! << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (bytes.length & 1) {
    sum += bytes[bytes.length - 1]!;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + bytes.length) >>> 0;
}
