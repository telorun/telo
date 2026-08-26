import { makeTaggedSentinel } from "@telorun/templating";
import { isRecord } from "./lib/utils";
import { readPointer, writePointer } from "./lib/json-pointer";
import {
  inlineResourceKind,
  parseRefValue,
} from "./components/resource-schema-form/ref-candidates";

export interface InlineExtraction {
  /** The kind the extracted document declares. */
  kind: string;
  /** That document's fields — `kind` becomes the document's own `kind:`, and
   *  `metadata` is dropped because the extraction names the resource. */
  config: Record<string, unknown>;
  /** The host's fields with the slot replaced by a reference to the new name. */
  hostFields: Record<string, unknown>;
}

/**
 * What moving an inline declaration out to its own resource changes.
 *
 * Split from the workspace mutation that applies it so the transform can be
 * checked on its own: the two halves — a new document, and a slot that now
 * points at it — must be derived from ONE reading of the inline value, or an
 * extraction can write a reference to a resource whose config it did not
 * actually take.
 *
 * Everything but `kind` and `metadata` travels verbatim, nested inline
 * declarations included: extracting one level does not flatten what is inside
 * it, and the extracted resource is free to have inline children of its own.
 */
export function planInlineExtraction(
  hostFields: Record<string, unknown>,
  pointer: string,
  name: string,
): InlineExtraction | null {
  const inline = readPointer(hostFields, pointer);
  const kind = inlineResourceKind(inline);
  if (!kind || !isRecord(inline)) return null;

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inline)) {
    if (key === "kind" || key === "metadata") continue;
    config[key] = value;
  }

  return {
    kind,
    config,
    hostFields: writePointer(hostFields, pointer, makeTaggedSentinel("ref", name)) as Record<
      string,
      unknown
    >,
  };
}

/**
 * What folding a referenced resource back into the slot that names it changes.
 *
 * The inverse of {@link planInlineExtraction}, and the same split for the same
 * reason: the two halves — a slot that now holds the declaration, and a
 * document that goes away — must be derived from ONE reading, or the editor can
 * delete a resource whose config it did not actually move.
 *
 * `kind` comes back as the declaration's own `kind:` and the name is dropped,
 * because the slot is where it lives now and an inline declaration has nothing
 * to be named by. Everything else travels verbatim.
 *
 * Refuses a slot that does not hold a reference to `target` — the caller found
 * the slot through the reference index, and a slot holding something else means
 * the two readings disagree.
 */
export function planReferenceInlining(
  hostFields: Record<string, unknown>,
  pointer: string,
  target: { kind: string; name: string; fields: Record<string, unknown> },
): { hostFields: Record<string, unknown> } | null {
  if (parseRefValue(readPointer(hostFields, pointer)) !== target.name) return null;

  return {
    hostFields: writePointer(hostFields, pointer, {
      kind: target.kind,
      ...target.fields,
    }) as Record<string, unknown>,
  };
}
