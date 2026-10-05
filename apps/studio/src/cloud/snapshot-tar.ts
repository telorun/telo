/** One entry of a repository snapshot. Directories are implied by paths. */
export type SnapshotEntry =
  | { path: string; kind: "file"; executable: boolean; bytes: Uint8Array }
  | { path: string; kind: "symlink"; target: string };

const BLOCK = 512;
const decoder = new TextDecoder();

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number, what: string): number {
  if (block[offset]! & 0x80) throw new Error(`The snapshot holds a ${what} Studio cannot read.`);
  const raw = text(block, offset, length).trim();
  if (raw === "") return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isFinite(value)) throw new Error(`The snapshot holds a malformed ${what}.`);
  return value;
}

/** A pax extended header: `<length> <key>=<value>\n` records. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/** A path inside the repository, or a refusal: a snapshot is written to the
 *  device, so a name that leaves the tree is never followed. */
function repositoryPath(raw: string): string | null {
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (raw.startsWith("/") || raw.includes("\\") || segments.includes("..")) {
    throw new Error(`The snapshot holds a path outside the repository: ${raw}`);
  }
  return segments.length === 0 ? null : segments.join("/");
}

/**
 * Reads a repository snapshot: a tar of the whole tree, regular files at mode
 * 0644 or 0755 and symbolic links as link entries. Long names arrive as pax or
 * GNU records. Entries share the input's buffer.
 */
export function readSnapshotTar(tar: Uint8Array): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  let offset = 0;
  let longPath: string | null = null;
  let longLink: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    // Two zero blocks end the archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break;

    const size = octal(header, 124, 12, "file size");
    const data = tar.subarray(offset, offset + size);
    if (data.length < size) throw new Error("The snapshot ends in the middle of a file.");
    offset += Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156]!);
    if (type === "x") {
      const records = paxRecords(data);
      longPath = records.get("path") ?? longPath;
      longLink = records.get("linkpath") ?? longLink;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longPath = text(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = text(data, 0, data.length);
      continue;
    }

    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const rawPath = longPath ?? (prefix ? `${prefix}/${name}` : name);
    const rawLink = longLink ?? text(header, 157, 100);
    longPath = null;
    longLink = null;

    if (type === "5") continue;
    const path = repositoryPath(rawPath);
    if (path === null) continue;
    if (type === "2") {
      entries.push({ path, kind: "symlink", target: rawLink });
    } else if (type === "0" || type === "\0") {
      const mode = octal(header, 100, 8, "file mode");
      entries.push({ path, kind: "file", executable: (mode & 0o111) !== 0, bytes: data });
    } else {
      throw new Error(`The snapshot holds an entry Studio cannot store: ${rawPath}`);
    }
  }
  return entries;
}
