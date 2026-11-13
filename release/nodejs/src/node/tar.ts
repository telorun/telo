/**
 * Reading a `.tgz` a package manager or a registry hands back, as the file set
 * it holds. ustar with GNU long names and pax `path` / `linkpath` records;
 * directories are dropped, since a file set is its files.
 */

import { gunzipSync } from "node:zlib";
import type { FileSetEntry } from "./files-digest.js";

export function readTarGz(bytes: Uint8Array, where: string): FileSetEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes);
  } catch (err) {
    throw new Error(`${where} is not a gzip archive: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries: FileSetEntry[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "K") {
      longLink = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      pax = readPax(body);
      continue;
    }
    if (type === "g") continue;
    const prefix = text(345, 155);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
    const link = pax.linkpath ?? longLink ?? text(157, 100);
    const mode = parseInt(text(100, 8).trim() || "0", 8);
    longName = longLink = undefined;
    pax = {};
    const relative = name.replace(/^\.\//, "");
    if (type === "0" || type === "\0" || type === "7") {
      entries.push({ path: relative, content: Buffer.from(body), ...((mode & 0o111) !== 0 ? { executable: true } : {}) });
    } else if (type === "2") {
      entries.push({ path: relative, link });
    } else if (type !== "5") {
      throw new Error(`${where} holds '${relative}' of tar type '${type}', which no file set can carry.`);
    }
  }
  return entries;
}

function readPax(body: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) break;
    const length = parseInt(body.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

/** Entries beneath `prefix/`, renamed relative to it; every entry must be there. */
export function stripPrefix(entries: readonly FileSetEntry[], prefix: string, where: string): FileSetEntry[] {
  return entries.map((entry) => {
    if (!entry.path.startsWith(`${prefix}/`)) {
      throw new Error(`${where} holds '${entry.path}', outside its '${prefix}/' directory.`);
    }
    return { ...entry, path: entry.path.slice(prefix.length + 1) };
  });
}
