import { PE_PAYLOAD_RESOURCE, encodeTrailer } from "./app-trailer.js";
import {
  alignUp,
  bufferReader,
  DIRECTORY,
  endOfSectionData,
  OPTIONAL,
  peChecksum,
  readPeImage,
  SECTION_HEADER_SIZE,
  SUBSYSTEM_WINDOWS_GUI,
  type PeImage,
  type PeSection,
} from "./pe-image.js";
import {
  readResources,
  RT_GROUP_ICON,
  RT_ICON,
  RT_RCDATA,
  RT_VERSION,
  serializeResources,
  type ResourceEntry,
} from "./pe-resources.js";
import { encodeVersionInfo, VERSION_LANGUAGE, type VersionInfo } from "./pe-version-info.js";
import { buildWindowsIcon } from "./windows-icon.js";

/**
 * A Windows desktop app's executable: the carrier with its console subsystem
 * switched to the GUI one, so a start opens no console window, the application's
 * icon and version resources, and the payload carried as a resource.
 *
 * The payload is a resource rather than bytes appended after the image because
 * signing writes the certificate table at the end of the file: a trailer that
 * must end the file is no longer at the end once the file is signed, while a
 * resource is inside the image Authenticode hashes.
 *
 * Every resource the carrier holds is kept (the runtime's own `NODE_SEA_BLOB`
 * among them) except those the app replaces: the version, the icons when the app
 * names one, and a previous payload. The rebuilt tree is written over the
 * carrier's resource section when that section ends the image, and otherwise as
 * a new section after the last one, leaving every other section's bytes and
 * addresses where they were.
 */

export interface WindowsGuiExecutableInput {
  readonly carrier: Buffer;
  readonly payload: Buffer;
  /** The application's PNG; without one the carrier's icon stays. */
  readonly icon?: Buffer;
  readonly version: VersionInfo;
}

const NEW_SECTION_NAME = ".rsrc";
/** The name the replaced resource section keeps, so one name means one section. */
const RETIRED_SECTION_NAME = ".rsrc0";
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;
const IMAGE_SCN_MEM_READ = 0x40000000;
const DEBUG_DIRECTORY_ENTRY_SIZE = 28;
const LANGUAGE_NEUTRAL = 0;

export async function buildWindowsGuiExecutable(input: WindowsGuiExecutableInput): Promise<Buffer> {
  let bytes: Buffer = Buffer.from(input.carrier);
  let image = await parse(bytes);

  const security = image.directories[DIRECTORY.security];
  if (security && security.size > 0) {
    // A signed carrier's signature cannot survive the edit; the operator signs the result.
    // One naming bytes inside the sections is stale — a tool that rebuilt the image wrote
    // over the table — so there is no table to take out, only the directory to clear.
    if (security.rva >= endOfSectionData(image)) {
      bytes = Buffer.concat([bytes.subarray(0, security.rva), bytes.subarray(security.rva + security.size)]);
    }
    writeDirectory(bytes, image, DIRECTORY.security, 0, 0);
  }

  const existing = await readResources(bufferReader(bytes), image);
  if (!existing) throw new Error("the Windows carrier's resource directory cannot be read, so its resources cannot be rewritten.");
  const entries = [...existing.filter((entry) => !replaced(entry, input.icon !== undefined)), ...appResources(input)];

  const resourceDirectory = image.directories[DIRECTORY.resource];
  const current = resourceDirectory?.size ? image.sections.find((section) => section.virtualAddress === resourceDirectory.rva) : undefined;
  const sectionsEnd = endOfSectionData(image);
  const last = image.sections.reduce<PeSection | undefined>(
    (top, section) => (!top || section.virtualAddress > top.virtualAddress ? section : top),
    undefined,
  );
  const inPlace = current !== undefined && current === last && current.pointerToRawData + current.sizeOfRawData === sectionsEnd;

  let out: Buffer;
  let resourceRva: number;
  let resourceSize: number;
  if (inPlace) {
    resourceRva = current.virtualAddress;
    const section = serializeResources(entries, resourceRva);
    resourceSize = section.length;
    const raw = padTo(section, image.fileAlignment);
    out = Buffer.concat([bytes.subarray(0, current.pointerToRawData), raw, bytes.subarray(sectionsEnd)]);
    out.writeUInt32LE(section.length, current.headerOffset + 8);
    out.writeUInt32LE(raw.length, current.headerOffset + 16);
    addInitializedData(out, image, raw.length - current.sizeOfRawData);
  } else {
    if (!(await hasHeaderRoom(bytes, image))) {
      bytes = await growHeaders(bytes, image);
      image = await parse(bytes);
      if (!(await hasHeaderRoom(bytes, image))) {
        throw new Error("the Windows carrier's headers have no room for another section, so its resources cannot be rewritten.");
      }
    }
    const end = endOfSectionData(image);
    resourceRva = alignUp(
      image.sections.reduce((top, section) => Math.max(top, section.virtualAddress + (section.virtualSize || section.sizeOfRawData)), 0),
      image.sectionAlignment,
    );
    const section = serializeResources(entries, resourceRva);
    resourceSize = section.length;
    const raw = padTo(section, image.fileAlignment);
    const rawAt = alignUp(end, image.fileAlignment);
    out = Buffer.concat([bytes.subarray(0, end), Buffer.alloc(rawAt - end), raw, bytes.subarray(end)]);
    const header = image.sectionTableOffset + image.sections.length * SECTION_HEADER_SIZE;
    out.fill(0, header, header + SECTION_HEADER_SIZE);
    out.write(NEW_SECTION_NAME, header, "latin1");
    out.writeUInt32LE(section.length, header + 8);
    out.writeUInt32LE(resourceRva, header + 12);
    out.writeUInt32LE(raw.length, header + 16);
    out.writeUInt32LE(rawAt, header + 20);
    out.writeUInt32LE((IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ) >>> 0, header + 36);
    out.writeUInt16LE(image.sections.length + 1, image.coffOffset + 2);
    if (current?.name === NEW_SECTION_NAME) {
      out.fill(0, current.headerOffset, current.headerOffset + 8);
      out.write(RETIRED_SECTION_NAME, current.headerOffset, "latin1");
    }
    addInitializedData(out, image, raw.length);
  }

  const final = await parse(out);
  const imageEnd = final.sections.reduce(
    (top, section) => Math.max(top, section.virtualAddress + (section.virtualSize || section.sizeOfRawData)),
    0,
  );
  out.writeUInt32LE(alignUp(imageEnd, final.sectionAlignment), final.optionalOffset + OPTIONAL.sizeOfImage);
  writeDirectory(out, final, DIRECTORY.resource, resourceRva, resourceSize);
  out.writeUInt16LE(SUBSYSTEM_WINDOWS_GUI, final.optionalOffset + OPTIONAL.subsystem);
  out.writeUInt32LE(peChecksum(out, final.optionalOffset + OPTIONAL.checkSum), final.optionalOffset + OPTIONAL.checkSum);
  return out;
}

async function parse(bytes: Buffer): Promise<PeImage> {
  const image = await readPeImage(bufferReader(bytes), bytes.length);
  if (!image) throw new Error("the Windows carrier is not a PE executable.");
  return image;
}

function replaced(entry: ResourceEntry, ownIcon: boolean): boolean {
  if (entry.type === RT_VERSION) return true;
  if (ownIcon && (entry.type === RT_ICON || entry.type === RT_GROUP_ICON)) return true;
  return entry.type === RT_RCDATA && entry.name === PE_PAYLOAD_RESOURCE;
}

function appResources(input: WindowsGuiExecutableInput): ResourceEntry[] {
  const resources: ResourceEntry[] = [];
  if (input.icon) {
    const icon = buildWindowsIcon(input.icon);
    icon.images.forEach((data, i) => resources.push({ type: RT_ICON, name: i + 1, language: VERSION_LANGUAGE, codePage: 0, data }));
    resources.push({ type: RT_GROUP_ICON, name: 1, language: VERSION_LANGUAGE, codePage: 0, data: icon.group });
  }
  resources.push({ type: RT_VERSION, name: 1, language: VERSION_LANGUAGE, codePage: 0, data: encodeVersionInfo(input.version) });
  resources.push({
    type: RT_RCDATA,
    name: PE_PAYLOAD_RESOURCE,
    language: LANGUAGE_NEUTRAL,
    codePage: 0,
    data: Buffer.concat([input.payload, encodeTrailer(input.payload)]),
  });
  return resources;
}

function padTo(bytes: Buffer, alignment: number): Buffer {
  const size = alignUp(bytes.length, alignment);
  return size === bytes.length ? bytes : Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
}

function writeDirectory(bytes: Buffer, image: PeImage, index: number, rva: number, size: number): void {
  if (index >= image.directoryCount) throw new Error(`the Windows carrier declares no data directory ${index}.`);
  bytes.writeUInt32LE(rva >>> 0, image.directoriesOffset + index * 8);
  bytes.writeUInt32LE(size >>> 0, image.directoriesOffset + index * 8 + 4);
}

function addInitializedData(bytes: Buffer, image: PeImage, delta: number): void {
  const at = image.optionalOffset + OPTIONAL.sizeOfInitializedData;
  bytes.writeUInt32LE((bytes.readUInt32LE(at) + delta) >>> 0, at);
}

/** The first byte any section's data starts at: what the headers may not reach. */
function firstSectionData(image: PeImage): number {
  return image.sections.reduce(
    (first, section) => (section.sizeOfRawData ? Math.min(first, section.pointerToRawData) : first),
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * Whether one more section header fits after the table. Bound imports, which a
 * linker may park in that space, are dropped first: they are only a load-time
 * shortcut, and the loader resolves the imports without them.
 */
async function hasHeaderRoom(bytes: Buffer, image: PeImage): Promise<boolean> {
  const slot = image.sectionTableOffset + image.sections.length * SECTION_HEADER_SIZE;
  const bound = image.directories[DIRECTORY.boundImport];
  if (bound && bound.size > 0 && bound.rva < image.sizeOfHeaders) {
    bytes.fill(0, bound.rva, bound.rva + bound.size);
    writeDirectory(bytes, image, DIRECTORY.boundImport, 0, 0);
  }
  if (slot + SECTION_HEADER_SIZE > Math.min(image.sizeOfHeaders, firstSectionData(image))) return false;
  if (bytes.subarray(slot, slot + SECTION_HEADER_SIZE).some((byte) => byte !== 0)) {
    throw new Error("the Windows carrier keeps data after its section table, so no section can be added to it.");
  }
  return true;
}

/**
 * Make the headers one file-alignment unit larger, moving every section's bytes
 * down by that much. Only file offsets move — a section's address in memory,
 * and so everything the loader reaches by address, stays — so the offsets the
 * image records are moved with them: each section's, each debug directory
 * entry's and the symbol table's.
 */
async function growHeaders(bytes: Buffer, image: PeImage): Promise<Buffer> {
  const delta = alignUp(SECTION_HEADER_SIZE, image.fileAlignment);
  const firstAddress = image.sections.reduce((first, section) => Math.min(first, section.virtualAddress), Number.MAX_SAFE_INTEGER);
  if (image.sizeOfHeaders + delta > firstAddress) {
    throw new Error("the Windows carrier's headers have no room for another section, so its resources cannot be rewritten.");
  }
  const at = image.sizeOfHeaders;
  const grown = Buffer.concat([bytes.subarray(0, at), Buffer.alloc(delta), bytes.subarray(at)]);
  grown.writeUInt32LE(at + delta, image.optionalOffset + OPTIONAL.sizeOfHeaders);
  for (const section of image.sections) {
    if (section.pointerToRawData >= at) grown.writeUInt32LE(section.pointerToRawData + delta, section.headerOffset + 20);
  }
  const symbols = grown.readUInt32LE(image.coffOffset + 8);
  if (symbols >= at) grown.writeUInt32LE(symbols + delta, image.coffOffset + 8);
  const moved = await parse(grown);
  const debug = moved.directories[DIRECTORY.debug];
  if (debug && debug.size > 0) {
    const section = moved.sections.find(
      (candidate) => debug.rva >= candidate.virtualAddress && debug.rva < candidate.virtualAddress + candidate.sizeOfRawData,
    );
    if (section) {
      const start = section.pointerToRawData + (debug.rva - section.virtualAddress);
      for (let entry = start; entry + DEBUG_DIRECTORY_ENTRY_SIZE <= start + debug.size; entry += DEBUG_DIRECTORY_ENTRY_SIZE) {
        const pointer = grown.readUInt32LE(entry + 24);
        if (pointer >= at) grown.writeUInt32LE(pointer + delta, entry + 24);
      }
    }
  }
  return grown;
}
