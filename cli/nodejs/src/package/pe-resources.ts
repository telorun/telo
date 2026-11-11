import { DIRECTORY, fileOffsetOf, sectionOf, type PeImage, type ReadAt } from "./pe-image.js";

/**
 * A PE image's resources: the three-level directory tree (type, name, language)
 * the Windows loader's `FindResource` walks, read and written.
 *
 * Reading is bounded to the section the tree lives in, and a tree that leaves it
 * or nests deeper than three levels is not one: the reader answers `undefined`,
 * and the caller decides whether that is a refusal.
 */

/** An integer id, or a name (stored as written; `FindResource` upper-cases what it looks up). */
export type ResourceKey = number | string;

export const RT_ICON = 3;
export const RT_RCDATA = 10;
export const RT_GROUP_ICON = 14;
export const RT_VERSION = 16;

export interface ResourceEntry {
  readonly type: ResourceKey;
  readonly name: ResourceKey;
  readonly language: number;
  readonly codePage: number;
  readonly data: Buffer;
}

/** Where one resource's bytes are. */
export interface ResourceLocation {
  /** File offset of the data. */
  readonly offset: number;
  readonly size: number;
}

const SUBDIRECTORY = 0x80000000;
const DIRECTORY_HEADER_SIZE = 16;
const DIRECTORY_ENTRY_SIZE = 8;
const DATA_ENTRY_SIZE = 16;
/** Ids and names one directory may list, far above anything a linker writes. */
const MAX_DIRECTORY_ENTRIES = 0x10000;

interface DirectoryEntry {
  readonly key: ResourceKey;
  readonly subdirectory: boolean;
  /** Relative to the tree's root. */
  readonly offset: number;
}

interface Tree {
  readonly readAt: ReadAt;
  readonly image: PeImage;
  /** File offset of the root directory. */
  readonly root: number;
  /** How many bytes past the root the tree may address: the rest of its section. */
  readonly extent: number;
}

async function openTree(readAt: ReadAt, image: PeImage): Promise<Tree | undefined> {
  const directory = image.directories[DIRECTORY.resource];
  if (!directory || directory.size === 0 || directory.rva === 0) return undefined;
  const section = sectionOf(image, directory.rva);
  const root = fileOffsetOf(image, directory.rva);
  if (!section || root === undefined) return undefined;
  return { readAt, image, root, extent: section.pointerToRawData + section.sizeOfRawData - root };
}

async function readDirectory(tree: Tree, at: number): Promise<DirectoryEntry[] | undefined> {
  if (at + DIRECTORY_HEADER_SIZE > tree.extent) return undefined;
  const header = await tree.readAt(tree.root + at, DIRECTORY_HEADER_SIZE);
  if (header.length < DIRECTORY_HEADER_SIZE) return undefined;
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  if (count > MAX_DIRECTORY_ENTRIES || at + DIRECTORY_HEADER_SIZE + count * DIRECTORY_ENTRY_SIZE > tree.extent) return undefined;
  const raw = await tree.readAt(tree.root + at + DIRECTORY_HEADER_SIZE, count * DIRECTORY_ENTRY_SIZE);
  if (raw.length < count * DIRECTORY_ENTRY_SIZE) return undefined;
  const entries: DirectoryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const name = raw.readUInt32LE(i * DIRECTORY_ENTRY_SIZE);
    const target = raw.readUInt32LE(i * DIRECTORY_ENTRY_SIZE + 4);
    let key: ResourceKey;
    if (name & SUBDIRECTORY) {
      const named = await readName(tree, name & ~SUBDIRECTORY);
      if (named === undefined) return undefined;
      key = named;
    } else {
      key = name & 0xffff;
    }
    entries.push({ key, subdirectory: (target & SUBDIRECTORY) !== 0, offset: target & ~SUBDIRECTORY });
  }
  return entries;
}

async function readName(tree: Tree, at: number): Promise<string | undefined> {
  if (at + 2 > tree.extent) return undefined;
  const length = (await tree.readAt(tree.root + at, 2)).readUInt16LE(0);
  if (at + 2 + length * 2 > tree.extent) return undefined;
  return (await tree.readAt(tree.root + at + 2, length * 2)).toString("utf16le");
}

async function readDataEntry(tree: Tree, at: number): Promise<(ResourceLocation & { codePage: number }) | undefined> {
  if (at + DATA_ENTRY_SIZE > tree.extent) return undefined;
  const raw = await tree.readAt(tree.root + at, DATA_ENTRY_SIZE);
  if (raw.length < DATA_ENTRY_SIZE) return undefined;
  const rva = raw.readUInt32LE(0);
  const size = raw.readUInt32LE(4);
  const section = sectionOf(tree.image, rva);
  if (!section || rva + size > section.virtualAddress + section.sizeOfRawData) return undefined;
  return { offset: section.pointerToRawData + (rva - section.virtualAddress), size, codePage: raw.readUInt32LE(8) };
}

/**
 * Where the first language of resource `type`/`name` is, or `undefined` when
 * the image has no such resource or no readable tree.
 */
export async function findResource(
  readAt: ReadAt,
  image: PeImage,
  type: ResourceKey,
  name: ResourceKey,
): Promise<ResourceLocation | undefined> {
  const tree = await openTree(readAt, image);
  if (!tree) return undefined;
  const types = await readDirectory(tree, 0);
  const typeEntry = types?.find((entry) => entry.key === type && entry.subdirectory);
  if (!typeEntry) return undefined;
  const names = await readDirectory(tree, typeEntry.offset);
  const nameEntry = names?.find((entry) => entry.key === name && entry.subdirectory);
  if (!nameEntry) return undefined;
  const languages = await readDirectory(tree, nameEntry.offset);
  const language = languages?.[0];
  if (!language || language.subdirectory) return undefined;
  const located = await readDataEntry(tree, language.offset);
  return located && { offset: located.offset, size: located.size };
}

/**
 * Every resource of the image, its bytes copied out, or `undefined` when its
 * tree cannot be read. An image with no resource directory has none (`[]`).
 */
export async function readResources(readAt: ReadAt, image: PeImage): Promise<ResourceEntry[] | undefined> {
  const directory = image.directories[DIRECTORY.resource];
  if (!directory || directory.size === 0 || directory.rva === 0) return [];
  const tree = await openTree(readAt, image);
  if (!tree) return undefined;
  const entries: ResourceEntry[] = [];
  const types = await readDirectory(tree, 0);
  if (!types) return undefined;
  for (const type of types) {
    if (!type.subdirectory) return undefined;
    const names = await readDirectory(tree, type.offset);
    if (!names) return undefined;
    for (const name of names) {
      if (!name.subdirectory) return undefined;
      const languages = await readDirectory(tree, name.offset);
      if (!languages) return undefined;
      for (const language of languages) {
        if (language.subdirectory || typeof language.key !== "number") return undefined;
        const located = await readDataEntry(tree, language.offset);
        if (!located) return undefined;
        const data = Buffer.from(await readAt(located.offset, located.size));
        if (data.length !== located.size) return undefined;
        entries.push({ type: type.key, name: name.key, language: language.key, codePage: located.codePage, data });
      }
    }
  }
  return entries;
}

/** Named entries first, in code-unit order, then ids ascending: the order the loader's binary search assumes. */
function compareKeys(a: ResourceKey, b: ResourceKey): number {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string") return -1;
  if (typeof b === "string") return 1;
  return a - b;
}

function sortedKeys<K extends ResourceKey>(map: Map<K, unknown>): K[] {
  return [...map.keys()].sort(compareKeys);
}

const align = (value: number, to: number) => Math.ceil(value / to) * to;

/**
 * The resource section holding `entries`, laid out as `rc` lays one out —
 * directories, then names, then data entries, then each resource's bytes on an
 * 8-byte boundary — for a section loaded at `sectionRva`. A resource named
 * twice (same type, name and language) is refused.
 */
export function serializeResources(entries: readonly ResourceEntry[], sectionRva: number): Buffer {
  const tree = new Map<ResourceKey, Map<ResourceKey, Map<number, ResourceEntry>>>();
  for (const entry of entries) {
    const names = tree.get(entry.type) ?? new Map<ResourceKey, Map<number, ResourceEntry>>();
    tree.set(entry.type, names);
    const languages = names.get(entry.name) ?? new Map<number, ResourceEntry>();
    names.set(entry.name, languages);
    if (languages.has(entry.language)) {
      throw new Error(`resource ${entry.type}/${entry.name} language ${entry.language} is given twice`);
    }
    languages.set(entry.language, entry);
  }

  const directorySize = (count: number) => DIRECTORY_HEADER_SIZE + count * DIRECTORY_ENTRY_SIZE;
  const types = sortedKeys(tree);
  let cursor = directorySize(types.length);
  const typeDirectory = new Map<ResourceKey, number>();
  for (const type of types) {
    typeDirectory.set(type, cursor);
    cursor += directorySize(tree.get(type)!.size);
  }
  const nameDirectory = new Map<Map<number, ResourceEntry>, number>();
  for (const type of types) {
    const names = tree.get(type)!;
    for (const name of sortedKeys(names)) {
      nameDirectory.set(names.get(name)!, cursor);
      cursor += directorySize(names.get(name)!.size);
    }
  }
  const strings = new Map<string, number>();
  for (const type of types) {
    for (const key of [type, ...tree.get(type)!.keys()]) {
      if (typeof key !== "string" || strings.has(key)) continue;
      strings.set(key, cursor);
      cursor += 2 + key.length * 2;
    }
  }
  cursor = align(cursor, 4);
  const ordered: ResourceEntry[] = [];
  for (const type of types) {
    const names = tree.get(type)!;
    for (const name of sortedKeys(names)) {
      const languages = names.get(name)!;
      for (const language of sortedKeys(languages)) ordered.push(languages.get(language)!);
    }
  }
  const dataEntry = new Map<ResourceEntry, number>();
  for (const entry of ordered) {
    dataEntry.set(entry, cursor);
    cursor += DATA_ENTRY_SIZE;
  }
  const dataAt = new Map<ResourceEntry, number>();
  for (const entry of ordered) {
    cursor = align(cursor, 8);
    dataAt.set(entry, cursor);
    cursor += entry.data.length;
  }

  const out = Buffer.alloc(cursor);
  const keyField = (key: ResourceKey) => (typeof key === "string" ? (SUBDIRECTORY | strings.get(key)!) >>> 0 : key);
  const writeDirectory = (at: number, keys: ResourceKey[], target: (key: ResourceKey) => number) => {
    const named = keys.filter((key) => typeof key === "string").length;
    out.writeUInt16LE(named, at + 12);
    out.writeUInt16LE(keys.length - named, at + 14);
    keys.forEach((key, i) => {
      out.writeUInt32LE(keyField(key), at + DIRECTORY_HEADER_SIZE + i * DIRECTORY_ENTRY_SIZE);
      out.writeUInt32LE(target(key) >>> 0, at + DIRECTORY_HEADER_SIZE + i * DIRECTORY_ENTRY_SIZE + 4);
    });
  };
  writeDirectory(0, types, (type) => SUBDIRECTORY | typeDirectory.get(type)!);
  for (const type of types) {
    const names = tree.get(type)!;
    writeDirectory(typeDirectory.get(type)!, sortedKeys(names), (name) => SUBDIRECTORY | nameDirectory.get(names.get(name)!)!);
    for (const name of sortedKeys(names)) {
      const languages = names.get(name)!;
      writeDirectory(nameDirectory.get(languages)!, sortedKeys(languages), (language) => dataEntry.get(languages.get(language as number)!)!);
    }
  }
  for (const [key, at] of strings) {
    out.writeUInt16LE(key.length, at);
    out.write(key, at + 2, "utf16le");
  }
  for (const entry of ordered) {
    const at = dataEntry.get(entry)!;
    out.writeUInt32LE(sectionRva + dataAt.get(entry)!, at);
    out.writeUInt32LE(entry.data.length, at + 4);
    out.writeUInt32LE(entry.codePage, at + 8);
    entry.data.copy(out, dataAt.get(entry)!);
  }
  return out;
}
