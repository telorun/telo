/**
 * The commit ids a git packfile holds (`gitformat-pack`). A first pass walks the
 * objects, inflating each only to find where the next begins and to hash every
 * whole commit; a second resolves the deltas in one sweep, from each whole base
 * down to every delta built on it, holding only the bases whose dependents are
 * still to be built. Used on a pack holding commits alone, so the set is the
 * history the pack's wants reach.
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export type ObjectFormat = "sha1" | "sha256";

/** The largest object, inflated or built from a delta, a pack may hold: a commit is a few KiB. */
export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;

/** The pack breaks a bound the reader keeps; distinct from a pack that is not one git writes. */
export class PackBoundError extends Error {}

const TYPE_NAMES: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const COMMIT = 1;
const OFS_DELTA = 6;
const REF_DELTA = 7;
const MIB = 1024 * 1024;

interface PackObject {
  readonly offset: number;
  readonly type: number;
  /** Where its zlib stream starts. */
  readonly dataAt: number;
  readonly size: number;
}

interface Base {
  readonly offset: number;
  readonly type: number;
  readonly id: string;
  readonly data: Uint8Array;
}

function objectId(format: ObjectFormat, type: number, data: Uint8Array): string {
  return createHash(format).update(`${TYPE_NAMES[type]} ${data.length}\0`).update(data).digest("hex");
}

function sizeBound(what: string, size: number): void {
  if (size > MAX_OBJECT_BYTES) {
    throw new PackBoundError(`${what} of ${size} bytes is above the ${MAX_OBJECT_BYTES / MIB} MiB limit on one object`);
  }
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    if (at >= bytes.length) throw new Error("a delta ends inside a size");
    if (shift > 49) throw new Error("a delta names a size that is not a number");
    byte = bytes[at++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, next: at };
}

/** `delta` applied to `base` (`gitformat-pack`, deltified representation). */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) throw new Error("a delta's base has another size than the delta names");
  const target = readVarint(delta, source.next);
  sizeBound("a delta's target", target.value);
  const out = new Uint8Array(target.value);
  let written = 0;
  let at = target.next;
  while (at < delta.length) {
    const command = delta[at++]!;
    if (command & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit++) if (command & (1 << bit)) offset += delta[at++]! * 2 ** (8 * bit);
      for (let bit = 0; bit < 3; bit++) if (command & (1 << (4 + bit))) size += delta[at++]! * 2 ** (8 * bit);
      if (at > delta.length) throw new Error("a delta ends inside an instruction");
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > out.length) throw new Error("a delta copies outside its base");
      out.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (command > 0) {
      if (at + command > delta.length || written + command > out.length) throw new Error("a delta inserts past its end");
      out.set(delta.subarray(at, at + command), written);
      written += command;
      at += command;
    } else {
      throw new Error("a delta holds the reserved instruction 0");
    }
  }
  if (written !== out.length) throw new Error("a delta builds another size than it names");
  return out;
}

/** The object whose zlib stream starts at `at`, inflated to no more than its header's `size`. */
function inflateAt(pack: Uint8Array, at: number, size: number): { data: Uint8Array; next: number } {
  let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    inflated = inflateSync(pack.subarray(at), { info: true, maxOutputLength: Math.max(size, 1) }) as unknown as typeof inflated;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new PackBoundError(`an object inflates past the ${size} bytes its header names`);
    }
    throw new Error(`an object at byte ${at} does not inflate: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { buffer, engine } = inflated;
  if (buffer.length !== size) throw new Error(`an object inflates to ${buffer.length} bytes, its header says ${size}`);
  return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length), next: at + engine.bytesWritten };
}

function append<K>(map: Map<K, PackObject[]>, key: K, object: PackObject): void {
  const list = map.get(key);
  if (list) list.push(object);
  else map.set(key, [object]);
}

/** The ids of the commits in `pack`. Throws a `PackBoundError` past a bound, and
 *  an `Error` when the pack is not one git writes. */
export function packCommitIds(pack: Uint8Array, format: ObjectFormat): Set<string> {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (pack.length < 12 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") throw new Error("the pack does not start with PACK");
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not one git writes`);
  const count = view.getUint32(8);
  const idLength = format === "sha1" ? 20 : 32;

  const commits = new Set<string>();
  const wholes: Array<{ object: PackObject; id: string }> = [];
  const byBaseOffset = new Map<number, PackObject[]>();
  const byBaseId = new Map<string, PackObject[]>();
  const starts = new Set<number>();
  let deltas = 0;
  let at = 12;
  for (let index = 0; index < count; index++) {
    const offset = at;
    const byte = (): number => {
      if (at >= pack.length) throw new Error(`the pack ends inside object ${index} of its ${count}`);
      return pack[at++]!;
    };
    if (at >= pack.length) throw new Error(`the pack ends after ${index} of its ${count} objects`);
    let next = byte();
    const type = (next >> 4) & 7;
    let size = next & 0x0f;
    let shift = 4;
    while (next & 0x80) {
      if (shift > 49) throw new Error(`object ${index} names a size that is not a number`);
      next = byte();
      size += (next & 0x7f) * 2 ** shift;
      shift += 7;
    }
    sizeBound(`object ${index}`, size);
    starts.add(offset);
    if (type === OFS_DELTA) {
      next = byte();
      let distance = next & 0x7f;
      while (next & 0x80) {
        next = byte();
        distance = (distance + 1) * 128 + (next & 0x7f);
      }
      if (distance <= 0 || distance > offset - 12) throw new Error(`object ${index} names a base outside the pack`);
      const dataAt = at;
      at = inflateAt(pack, at, size).next;
      append(byBaseOffset, offset - distance, { offset, type, dataAt, size });
      deltas++;
    } else if (type === REF_DELTA) {
      if (at + idLength > pack.length) throw new Error(`the pack ends inside object ${index} of its ${count}`);
      const baseId = Buffer.from(pack.subarray(at, at + idLength)).toString("hex");
      at += idLength;
      const dataAt = at;
      at = inflateAt(pack, at, size).next;
      append(byBaseId, baseId, { offset, type, dataAt, size });
      deltas++;
    } else if (TYPE_NAMES[type]) {
      const dataAt = at;
      const inflated = inflateAt(pack, at, size);
      at = inflated.next;
      const id = objectId(format, type, inflated.data);
      if (type === COMMIT) commits.add(id);
      wholes.push({ object: { offset, type, dataAt, size }, id });
    } else {
      throw new Error(`object ${index} has the unknown type ${type}`);
    }
  }
  for (const base of byBaseOffset.keys()) {
    if (!starts.has(base)) throw new Error("a delta names a base offset where no object starts");
  }

  // Every delta is built once, from its base, which is dropped once its dependents are.
  const dependentsOf = (base: Base): PackObject[] => [
    ...(byBaseOffset.get(base.offset) ?? []),
    ...(byBaseId.get(base.id) ?? []),
  ];
  const work: Base[] = [];
  for (const { object, id } of wholes) {
    if (!byBaseOffset.has(object.offset) && !byBaseId.has(id)) continue;
    work.push({ offset: object.offset, type: object.type, id, data: inflateAt(pack, object.dataAt, object.size).data });
  }
  let built = 0;
  for (let base = work.pop(); base !== undefined; base = work.pop()) {
    const dependents = dependentsOf(base);
    byBaseOffset.delete(base.offset);
    byBaseId.delete(base.id);
    for (const delta of dependents) {
      const data = applyDelta(base.data, inflateAt(pack, delta.dataAt, delta.size).data);
      const id = objectId(format, base.type, data);
      built++;
      if (base.type === COMMIT) commits.add(id);
      if (byBaseOffset.has(delta.offset) || byBaseId.has(id)) work.push({ offset: delta.offset, type: base.type, id, data });
    }
  }
  if (built !== deltas) throw new Error(`${deltas - built} deltas name a base the pack does not hold`);
  return commits;
}
