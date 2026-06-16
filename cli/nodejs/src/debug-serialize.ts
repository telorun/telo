import type { LruBlobStore } from "./blob-store.js";

/**
 * The Node producer's implementation of the Telo debug wire format (see
 * `@telorun/debug-wire` `wire.ts` / `wire-schema.json` for the language-neutral
 * contract). Both debug sinks — the JSONL file and the live SSE server — encode
 * through here, so a file line and a streamed frame are byte-identical.
 *
 * Event payloads carry live runtime values, not plain data, so a plain
 * `JSON.stringify` is unusable. We walk the value ourselves (rather than via a
 * `JSON.stringify` replacer) so binary is caught by `instanceof Uint8Array`
 * *before* `Buffer.prototype.toJSON` would expand it into a giant number array.
 *
 * Encoding rules (the wire contract):
 *  - a byte buffer (`Uint8Array`/`Buffer`) → offloaded to the blob store, emitted
 *    as a pointer `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }` (the
 *    object key it sits under is preserved; only the bytes leave the log). Without
 *    a store, a `"[Bytes <n>]"` marker.
 *  - a resolved `!ref` (a controller instance) → the `{ kind, name }` it stands for.
 *  - a value with `toJSON` (e.g. `Date`) → its `toJSON()` result.
 *  - a bigint → a plain number when it fits a JS safe integer (CEL models small
 *    integers as bigint, so `${{ size(x) }}` reads as `3`, not `[BigInt 3]`),
 *    otherwise its decimal digits as a string so no precision is lost.
 *  - any other live object (context, stream, client, Node handle) — and values
 *    JSON can't represent (functions) → a one-token `[Marker]`.
 *  - a reference cycle → `[Circular]`.
 *  - everything else → plain JSON.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function toWire(value: unknown, store: LruBlobStore | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") {
    return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT ? Number(value) : value.toString();
  }
  if (typeof value === "function") {
    return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
  }
  if (value === null || typeof value !== "object") return value;

  // Binary first — before the cycle check and before any toJSON. Buffer is a
  // Uint8Array subclass, so this catches both.
  if (value instanceof Uint8Array) {
    const mediaType = sniffMediaType(value);
    if (store) {
      const id = store.put(value, mediaType);
      return { $blob: `blobs/${id}`, mediaType, byteLength: value.byteLength };
    }
    return `[Bytes ${value.byteLength}]`;
  }

  // Path-scoped cycle detection: a value is "circular" only while it is an
  // ancestor on the current descent. Removing it on the way back up means a value
  // reachable by two sibling paths (a shared reference / DAG, not a cycle) still
  // serializes fully — only a true back-edge to an ancestor becomes "[Circular]".
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => toWire(v, store, seen));
    }

    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return toWire((toJSON as () => unknown).call(value), store, seen);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const ref = resourceRefOf(value);
      if (ref) return ref;
      return `[${(value as object).constructor?.name || "Object"}]`;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v, store, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * If `instance` is a controller instance built from a resource manifest, return
 * the `{ kind, name }` reference it stands for. Controllers don't name the
 * manifest field uniformly (`HttpServerApi` calls it `manifest`, `Run.Sequence`
 * calls it `resource`, …), so rather than hard-code field names we look for any
 * own field holding a manifest-shaped value (`{ kind: string, metadata.name:
 * string }`). Returns null when no field qualifies.
 */
function resourceRefOf(instance: object): { kind: string; name: string } | null {
  for (const v of Object.values(instance)) {
    const m = v as { kind?: unknown; metadata?: { name?: unknown } } | null;
    if (m && typeof m === "object" && typeof m.kind === "string" && typeof m.metadata?.name === "string") {
      return { kind: m.kind, name: m.metadata.name };
    }
  }
  return null;
}

/** Best-effort content sniff from magic bytes, for any file kind. Falls back to
 *  `application/octet-stream` so a value is still offloaded and downloadable. */
function sniffMediaType(b: Uint8Array): string {
  const at = (i: number, ...sig: number[]) => sig.every((v, k) => b[i + k] === v);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (b.length >= 4 && at(0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (b.length >= 2 && at(0, 0x1f, 0x8b)) return "application/gzip";
  if (b.length >= 4 && at(0, 0x50, 0x4b) && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return "application/zip";
  if (b.length >= 4 && at(0, 0x00, 0x61, 0x73, 0x6d)) return "application/wasm";
  if (b.length >= 4 && at(0, 0x49, 0x44, 0x33)) return "audio/mpeg"; // ID3 (mp3)
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4"; // ....ftyp
  return "application/octet-stream";
}

/**
 * Serialize one event to a single wire-format JSON line (no trailing newline).
 * When `blobStore` is given, byte buffers in the payload are offloaded to it and
 * replaced by pointers; otherwise they degrade to `[Bytes n]` markers.
 */
export function serializeEvent(
  event: string,
  payload?: unknown,
  metadata?: Record<string, unknown>,
  blobStore?: LruBlobStore,
): string {
  const entry: Record<string, unknown> = {
    kind: "event",
    timestamp: new Date().toISOString(),
    event,
  };
  if (payload !== undefined) entry.payload = payload;
  if (metadata && Object.keys(metadata).length > 0) entry.metadata = metadata;
  return JSON.stringify(toWire(entry, blobStore, new WeakSet<object>()));
}

/**
 * Serialize one stdout/stderr line to a wire-format `log` frame (no trailing
 * newline). Log lines are plain text, so unlike {@link serializeEvent} there is
 * no payload to reduce — the line travels verbatim, ANSI escapes intact.
 */
export function serializeLog(stream: "stdout" | "stderr", line: string): string {
  return JSON.stringify({
    kind: "log",
    timestamp: new Date().toISOString(),
    stream,
    line,
  });
}
