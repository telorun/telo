import { offeredValueTags as tagsOfferedAt, type ValueTag } from "@telorun/ide-support";
import { defaultRegistry, isTaggedSentinel } from "@telorun/templating";
import type { CelEvalMode } from "./cel-utils";
import type { JsonSchemaProperty } from "./types";

/**
 * A YAML tag the form may author, and the widget that writes it.
 *
 * A tag is not a mode of one editor: `!cel` takes an EXPRESSION, `!include-bytes`
 * takes a module-relative PATH to a file that ships with the module, and an
 * untagged field takes the value itself. So a tag selects the writer and the
 * widget together. WHICH tags a field takes is the shared rule every editor
 * host applies; only the widget is the form's.
 */
export interface ValueTagOption extends ValueTag {
  /** What the author types under this tag. */
  editor: "expression" | "path";
}

/** The tags offerable at one field, each with its widget. A ref slot never
 *  reaches here — it is dispatched to the reference picker first. */
export function offeredValueTags(
  prop: JsonSchemaProperty,
  evalMode: CelEvalMode | null,
): ValueTagOption[] {
  return tagsOfferedAt(prop as Record<string, unknown>, evalMode).map((tag) => ({
    ...tag,
    editor: tag.names ? "path" : "expression",
  }));
}

/** The tag a value currently carries, or null for an untagged one. A plain
 *  string holding `${{ }}` reads as untagged: it IS untagged in the manifest,
 *  a legacy spelling the analyzer reports and `telo migrate` rewrites — so the
 *  picker shows it for what it is. */
export function tagOf(value: unknown): string | null {
  return isTaggedSentinel(value) ? value.engine : null;
}

/** Whether a tag's scalar holds CEL, so it is edited with CEL's completions —
 *  asked of the engine, never of the tag's name. */
export function holdsCel(tag: string): boolean {
  return defaultRegistry().get(tag)?.expressionRegions !== undefined;
}

/** The source text under a tag, or "" for a value carrying none. */
export function tagSourceOf(value: unknown): string {
  if (isTaggedSentinel(value)) return value.source;
  return typeof value === "string" ? value : "";
}
