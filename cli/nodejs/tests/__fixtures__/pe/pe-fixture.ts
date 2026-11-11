/**
 * A fabricated PE32+ image and a minimal reader of one, written apart from the
 * code under test so its output is judged by a second reading of the format.
 *
 * The image has three sections — `.text`, `.rsrc`, `.reloc` — with `.rsrc`
 * either before `.reloc` or last, a debug directory in `.text` pointing at bytes
 * of `.text` by file offset, and a resource tree holding a runtime blob, a
 * manifest, an icon, an icon group and a version.
 */

export const FILE_ALIGNMENT = 0x200;
export const SECTION_ALIGNMENT = 0x1000;
const PE_OFFSET = 0x80;
const OPTIONAL_SIZE = 240;

export interface FixtureResource {
  type: number | string;
  name: number | string;
  language: number;
  data: Buffer;
}

export const CARRIER_RESOURCES: FixtureResource[] = [
  { type: 10, name: "NODE_SEA_BLOB", language: 0x409, data: Buffer.from("the runtime's own blob ".repeat(40)) },
  { type: 24, name: 1, language: 0x409, data: Buffer.from("<assembly>manifest</assembly>") },
  { type: 3, name: 1, language: 0x409, data: Buffer.from("old icon image") },
  { type: 14, name: 1, language: 0x409, data: Buffer.from("old icon group") },
  { type: 16, name: 1, language: 0x409, data: Buffer.from("old version") },
];

/** The bytes the debug directory entry points at, by file offset, inside `.text`. */
export const DEBUG_DATA = Buffer.from("CODEVIEW-RSDS-fixture-debug-data");
const DEBUG_DIRECTORY_AT = 0x100;
const DEBUG_DATA_AT = 0x180;

function resourceTree(resources: FixtureResource[], rva: number): Buffer {
  const types = [...new Set(resources.map((r) => r.type))];
  const header = (named: number, ids: number) => {
    const b = Buffer.alloc(16);
    b.writeUInt16LE(named, 12);
    b.writeUInt16LE(ids, 14);
    return b;
  };
  // Every directory is one entry wide below the root, which keeps the layout plain.
  const parts: Buffer[] = [];
  let size = 16 + types.length * 8;
  const perType = types.map((type) => resources.filter((r) => r.type === type));
  const typeDirs = perType.map((group) => {
    const at = size;
    size += 16 + group.length * 8;
    return at;
  });
  const langDirs = perType.flat().map(() => {
    const at = size;
    size += 16 + 8;
    return at;
  });
  const strings = new Map<string, number>();
  for (const r of resources) {
    for (const key of [r.type, r.name]) {
      if (typeof key === "string" && !strings.has(key)) {
        strings.set(key, size);
        size += 2 + key.length * 2;
      }
    }
  }
  size = Math.ceil(size / 4) * 4;
  const dataEntries = perType.flat().map(() => {
    const at = size;
    size += 16;
    return at;
  });
  const blobs = perType.flat().map((r) => {
    size = Math.ceil(size / 8) * 8;
    const at = size;
    size += r.data.length;
    return at;
  });
  const out = Buffer.alloc(size);
  const key = (k: number | string) => (typeof k === "string" ? (0x80000000 | strings.get(k)!) >>> 0 : k);
  header(types.filter((t) => typeof t === "string").length, types.filter((t) => typeof t === "number").length).copy(out, 0);
  types.forEach((type, i) => {
    out.writeUInt32LE(key(type), 16 + i * 8);
    out.writeUInt32LE((0x80000000 | typeDirs[i]!) >>> 0, 20 + i * 8);
  });
  let flat = 0;
  perType.forEach((group, i) => {
    const at = typeDirs[i]!;
    header(group.filter((r) => typeof r.name === "string").length, group.filter((r) => typeof r.name === "number").length).copy(out, at);
    group.forEach((r, j) => {
      out.writeUInt32LE(key(r.name), at + 16 + j * 8);
      out.writeUInt32LE((0x80000000 | langDirs[flat]!) >>> 0, at + 20 + j * 8);
      header(0, 1).copy(out, langDirs[flat]!);
      out.writeUInt32LE(r.language, langDirs[flat]! + 16);
      out.writeUInt32LE(dataEntries[flat]!, langDirs[flat]! + 20);
      out.writeUInt32LE(rva + blobs[flat]!, dataEntries[flat]!);
      out.writeUInt32LE(r.data.length, dataEntries[flat]! + 4);
      r.data.copy(out, blobs[flat]!);
      flat++;
    });
  });
  for (const [text, at] of strings) {
    out.writeUInt16LE(text.length, at);
    out.write(text, at + 2, "utf16le");
  }
  return out;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(Math.ceil(b.length / FILE_ALIGNMENT) * FILE_ALIGNMENT - b.length)]);

export interface FabricateOptions {
  /** `.rsrc` is the last section, rather than before `.reloc`. */
  resourceLast?: boolean;
  /** The headers end exactly where the section table does. */
  fullHeaders?: boolean;
  /** A certificate table appended after the sections. */
  certificate?: Buffer;
}

export function fabricatePe(options: FabricateOptions = {}): Buffer {
  const headersSize = options.fullHeaders ? 0x200 : 0x400;
  const text = Buffer.alloc(0x400);
  for (let i = 0; i < text.length; i++) text[i] = (i * 7 + 3) & 0xff;
  const reloc = Buffer.alloc(0x200, 0xab);
  const order = options.resourceLast ? [".text", ".reloc", ".rsrc"] : [".text", ".rsrc", ".reloc"];
  const vas: Record<string, number> = {};
  order.forEach((name, i) => (vas[name] = SECTION_ALIGNMENT * (i + 1)));
  const rsrc = resourceTree(CARRIER_RESOURCES, vas[".rsrc"]!);
  const datas: Record<string, Buffer> = { ".text": text, ".rsrc": rsrc, ".reloc": reloc };

  const raws: Record<string, number> = {};
  let fileAt = headersSize;
  for (const name of order) {
    raws[name] = fileAt;
    fileAt += pad(datas[name]!).length;
  }
  // The debug directory and the bytes it names, by file offset, inside .text.
  DEBUG_DATA.copy(text, DEBUG_DATA_AT);
  text.writeUInt32LE(DEBUG_DATA.length, DEBUG_DIRECTORY_AT + 16);
  text.writeUInt32LE(vas[".text"]! + DEBUG_DATA_AT, DEBUG_DIRECTORY_AT + 20);
  text.writeUInt32LE(raws[".text"]! + DEBUG_DATA_AT, DEBUG_DIRECTORY_AT + 24);

  const headers = Buffer.alloc(headersSize);
  headers.write("MZ", 0, "latin1");
  headers.writeUInt32LE(PE_OFFSET, 60);
  headers.writeUInt32LE(0x00004550, PE_OFFSET);
  const coff = PE_OFFSET + 4;
  headers.writeUInt16LE(0x8664, coff);
  headers.writeUInt16LE(order.length, coff + 2);
  headers.writeUInt16LE(OPTIONAL_SIZE, coff + 16);
  headers.writeUInt16LE(0x22, coff + 18);
  const opt = coff + 20;
  headers.writeUInt16LE(0x20b, opt);
  headers.writeUInt32LE(0x1000, opt + 16);
  headers.writeUInt32LE(SECTION_ALIGNMENT, opt + 32);
  headers.writeUInt32LE(FILE_ALIGNMENT, opt + 36);
  headers.writeUInt16LE(6, opt + 40);
  headers.writeUInt32LE(SECTION_ALIGNMENT * (order.length + 1), opt + 56);
  headers.writeUInt32LE(headersSize, opt + 60);
  headers.writeUInt16LE(3, opt + 68);
  headers.writeUInt32LE(16, opt + 108);
  const dir = (index: number, rva: number, size: number) => {
    headers.writeUInt32LE(rva, opt + 112 + index * 8);
    headers.writeUInt32LE(size, opt + 116 + index * 8);
  };
  dir(2, vas[".rsrc"]!, rsrc.length);
  dir(5, vas[".reloc"]!, reloc.length);
  dir(6, vas[".text"]! + DEBUG_DIRECTORY_AT, 28);
  const table = opt + OPTIONAL_SIZE;
  order.forEach((name, i) => {
    const at = table + i * 40;
    headers.write(name, at, "latin1");
    headers.writeUInt32LE(datas[name]!.length, at + 8);
    headers.writeUInt32LE(vas[name]!, at + 12);
    headers.writeUInt32LE(pad(datas[name]!).length, at + 16);
    headers.writeUInt32LE(raws[name]!, at + 20);
    headers.writeUInt32LE(name === ".text" ? 0x60000020 : 0x40000040, at + 36);
  });
  let image = Buffer.concat([headers, ...order.map((name) => pad(datas[name]!))]);
  if (options.certificate) {
    dir(4, image.length, options.certificate.length);
    headers.copy(image, 0);
    image = Buffer.concat([image, options.certificate]);
  }
  return image;
}

export interface ParsedSection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  rawSize: number;
  rawAt: number;
}

export interface ParsedPe {
  optional: number;
  subsystem: number;
  checksum: number;
  sizeOfImage: number;
  sizeOfHeaders: number;
  directory(index: number): { rva: number; size: number };
  sections: ParsedSection[];
  /** File offset of an address. */
  offset(rva: number): number;
}

export function parsePe(bytes: Buffer): ParsedPe {
  const pe = bytes.readUInt32LE(60);
  if (bytes.readUInt32LE(pe) !== 0x00004550) throw new Error("not PE");
  const count = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const table = optional + optionalSize;
  const sections: ParsedSection[] = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 40;
    sections.push({
      name: bytes.toString("latin1", at, at + 8).replace(/\0+$/, ""),
      virtualSize: bytes.readUInt32LE(at + 8),
      virtualAddress: bytes.readUInt32LE(at + 12),
      rawSize: bytes.readUInt32LE(at + 16),
      rawAt: bytes.readUInt32LE(at + 20),
    });
  }
  const offset = (rva: number) => {
    const s = sections.find((c) => rva >= c.virtualAddress && rva < c.virtualAddress + c.rawSize);
    if (!s) throw new Error(`rva ${rva.toString(16)} is in no section`);
    return s.rawAt + rva - s.virtualAddress;
  };
  return {
    optional,
    subsystem: bytes.readUInt16LE(optional + 68),
    checksum: bytes.readUInt32LE(optional + 64),
    sizeOfImage: bytes.readUInt32LE(optional + 56),
    sizeOfHeaders: bytes.readUInt32LE(optional + 60),
    directory: (index) => ({ rva: bytes.readUInt32LE(optional + 112 + index * 8), size: bytes.readUInt32LE(optional + 116 + index * 8) }),
    sections,
    offset,
  };
}

/** Every resource, walked from the resource directory by address. */
export function parseResources(bytes: Buffer): FixtureResource[] {
  const pe = parsePe(bytes);
  const root = pe.offset(pe.directory(2).rva);
  const name = (field: number) => {
    if (!(field & 0x80000000)) return field & 0xffff;
    const at = root + (field & 0x7fffffff);
    return bytes.toString("utf16le", at + 2, at + 2 + bytes.readUInt16LE(at) * 2);
  };
  const entries = (at: number) => {
    const n = bytes.readUInt16LE(at + 12) + bytes.readUInt16LE(at + 14);
    const list: Array<{ key: number | string; target: number }> = [];
    for (let i = 0; i < n; i++) {
      list.push({ key: name(bytes.readUInt32LE(at + 16 + i * 8)), target: bytes.readUInt32LE(at + 20 + i * 8) });
    }
    return list;
  };
  const found: FixtureResource[] = [];
  for (const type of entries(root)) {
    for (const res of entries(root + (type.target & 0x7fffffff))) {
      for (const lang of entries(root + (res.target & 0x7fffffff))) {
        const data = root + lang.target;
        const at = pe.offset(bytes.readUInt32LE(data));
        found.push({ type: type.key, name: res.key, language: lang.key as number, data: bytes.subarray(at, at + bytes.readUInt32LE(data + 4)) });
      }
    }
  }
  return found;
}

/** The PE checksum, summed whole and folded once at the end. */
export function independentChecksum(bytes: Buffer, checksumAt: number): number {
  let sum = 0n;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (i === checksumAt || i === checksumAt + 2) continue;
    sum += BigInt(bytes.readUInt16LE(i));
  }
  if (bytes.length % 2) sum += BigInt(bytes[bytes.length - 1]!);
  while (sum > 0xffffn) sum = (sum & 0xffffn) + (sum >> 16n);
  return Number(sum) + bytes.length;
}

/** A version resource's string values, by key. */
export function versionStrings(info: Buffer): Record<string, string> {
  const strings: Record<string, string> = {};
  const walk = (at: number, end: number) => {
    while (at + 6 <= end) {
      const length = info.readUInt16LE(at);
      if (length === 0) break;
      const valueLength = info.readUInt16LE(at + 2);
      const type = info.readUInt16LE(at + 4);
      let k = at + 6;
      while (info.readUInt16LE(k) !== 0) k += 2;
      const key = info.toString("utf16le", at + 6, k);
      const value = Math.ceil((k + 2) / 4) * 4;
      if (type === 1 && valueLength > 0 && !["StringFileInfo", "VarFileInfo"].includes(key) && !/^[0-9A-F]{8}$/.test(key)) {
        strings[key] = info.toString("utf16le", value, value + (valueLength - 1) * 2);
      }
      const children = Math.ceil((value + (type === 1 ? valueLength * 2 : valueLength)) / 4) * 4;
      if (key === "VS_VERSION_INFO" || key === "StringFileInfo" || /^[0-9A-F]{8}$/.test(key)) walk(children, at + length);
      at = Math.ceil((at + length) / 4) * 4;
    }
  };
  walk(0, info.length);
  return strings;
}
