/**
 * Where a named SHAPE can be referenced from a declaration's contract or
 * signature — the fields a `!ref <Shape>` there resolves through, and the walk
 * that finds each one.
 *
 * One reader for three consumers that must agree about which references these
 * are: flatten (which shapes a forwarded kind needs carried across the import
 * boundary), `resolveRefSentinels` (which resolves them in the DECLARING module's
 * scope) and the strict half (which reports one that resolved to nothing).
 *
 * Browser-safe.
 */
import { isRefSentinel, isTaggedSentinel, type TaggedSentinel } from "@telorun/templating";

/** A kind document's contract and signature — each holds a shape at its root or
 *  at any depth. */
export const KIND_SHAPE_FIELDS = ["inputType", "outputType", "params", "returns"] as const;

/** An instance's signature. Its `inputType` / `outputType` are declared
 *  reference slots, resolved and reported with every other slot. */
export const INSTANCE_SHAPE_FIELDS = ["params", "returns"] as const;

/** The fields of `manifest` whose shape references travel with it across an
 *  import boundary — an instance's contract as well as its signature, since a
 *  consumer checks a call against both. */
export function forwardedShapeFieldsOf(manifest: { kind?: unknown }): readonly string[] {
  return manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract"
    ? KIND_SHAPE_FIELDS
    : [...INSTANCE_SHAPE_FIELDS, "inputType", "outputType"];
}

/** The fields of `manifest` a shape reference may sit in. */
export function shapeFieldsOf(manifest: { kind?: unknown }): readonly string[] {
  return manifest.kind === "Telo.Definition" || manifest.kind === "Telo.Abstract"
    ? KIND_SHAPE_FIELDS
    : INSTANCE_SHAPE_FIELDS;
}

/** Every `!ref` sentinel under `value`, with its dotted path relative to it.
 *  Other tagged values are opaque and not descended into. */
export function refSentinelsIn(
  value: unknown,
  path: string,
): Array<{ sentinel: TaggedSentinel; path: string }> {
  const out: Array<{ sentinel: TaggedSentinel; path: string }> = [];
  const walk = (node: unknown, at: string): void => {
    if (isRefSentinel(node)) {
      out.push({ sentinel: node, path: at });
      return;
    }
    if (!node || typeof node !== "object" || isTaggedSentinel(node)) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, `${at}.${key}`);
    }
  };
  walk(value, path);
  return out;
}
