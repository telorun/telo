import { isWireBlob, type WireBlob } from "./wire.js";

export interface FoundBlob {
  /** Dotted path to the blob within the payload, e.g. `outputs.image`. */
  path: string;
  blob: WireBlob;
  /** The object the blob sits in — lets a consumer read sibling `width`/`height`. */
  parent: Record<string, unknown> | null;
}

/**
 * Walk a payload and collect every {@link WireBlob} with its path and parent.
 * Pure and cycle-safe (a debug payload shouldn't be cyclic, but a defensive
 * `seen` set keeps a malformed one from looping). Order is depth-first.
 */
export function collectBlobs(payload: unknown): FoundBlob[] {
  const found: FoundBlob[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string, parent: Record<string, unknown> | null): void => {
    if (isWireBlob(value)) {
      found.push({ path, blob: value, parent });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, parent));
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      walk(v, path ? `${path}.${k}` : k, obj);
    }
  };

  walk(payload, "", null);
  return found;
}

/** Sibling pixel dimensions of a blob, when the producer put them next to it. */
export function blobDimensions(parent: Record<string, unknown> | null): string | null {
  if (!parent) return null;
  const w = parent.width;
  const h = parent.height;
  return typeof w === "number" && typeof h === "number" ? `${w}×${h}` : null;
}

/** Human-readable byte size, e.g. `47 KB`, `2.1 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
