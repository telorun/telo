import { checkSchemaCompatibility } from "@telorun/analyzer";
import { builtinEngines, isTaggedSentinel, producedTypeOf } from "@telorun/templating";
import type { CelEvalMode } from "./cel-utils";
import type { JsonSchemaProperty } from "./types";

/**
 * Which YAML tags may author the value at a field, and what widget writes each.
 *
 * A tag is not a mode of one editor: `!cel` takes an EXPRESSION, `!include-bytes`
 * takes a module-relative PATH to a file that ships with the module, and an
 * untagged field takes the value itself. So a tag selects the writer and the
 * widget together, which is why this is a vocabulary rather than a boolean.
 *
 * The split with `@telorun/templating` is deliberate. An engine declares what a
 * tag PRODUCES (`producedType()`) and what language it is (`language`); this
 * declares what AUTHORS it, which is editor knowledge no engine should carry.
 * Applicability is then derived from the engine's own declaration rather than
 * from a list of names here — so the table says how to edit a tag, never which
 * tags exist.
 *
 * An engine with no entry is simply not offered. That is the safe direction: a
 * tag this editor has no widget for degrades to absent rather than to a widget
 * that writes the wrong thing.
 */
export interface ValueTagOption {
  /** Engine name, which is the YAML tag without its `!`. */
  id: string;
  /** How the tag is written, for the picker. */
  label: string;
  /** What the author types under this tag. */
  editor: "expression" | "path";
  /** One line on what the tag does, shown beside the picker. */
  hint: string;
}

/**
 * The tags this editor knows how to author, by engine name.
 *
 * `!ref` is absent on purpose and not by omission: it names a RESOURCE rather
 * than producing a value, and a ref slot is dispatched to the reference picker
 * long before it reaches this field. `!sql` is absent until the field renderer
 * consumes `engine.language` and can give it Monaco — a plain text box for SQL
 * would be the wrong widget, which is the one thing an entry here must not be.
 */
const AUTHORABLE: Record<string, Omit<ValueTagOption, "id">> = {
  cel: {
    label: "!cel",
    editor: "expression",
    hint: "A CEL expression, evaluated against this field's scope.",
  },
  literal: {
    label: "!literal",
    editor: "expression",
    hint: "Opaque text. `${{ }}` inside it is not interpolated.",
  },
  "include-text": {
    label: "!include-text",
    editor: "path",
    hint: "Contents of a file shipped with this module, as text.",
  },
  "include-bytes": {
    label: "!include-bytes",
    editor: "path",
    hint: "Contents of a file shipped with this module, as raw bytes.",
  },
};

/**
 * The tags offerable at one field.
 *
 * Two rules, both read off the engine rather than off its name:
 *
 *  - A tag that declares a produced type is offered where that type satisfies
 *    the slot. This is what puts `!include-bytes` on a `Telo.Bytes` slot and
 *    keeps it off a string one — the property the produced-type seam exists to
 *    give, checked with the analyzer's own comparator so the editor and
 *    `telo check` agree about what fits.
 *  - A tag that declares none produces whatever the SLOT says, so it is offered
 *    exactly where the slot is CEL-eligible. Outside such a field the value
 *    would never be evaluated, which the analyzer reports as
 *    `CEL_IN_NON_EVAL_FIELD`.
 */
export function offeredValueTags(
  prop: JsonSchemaProperty,
  evalMode: CelEvalMode | null,
): ValueTagOption[] {
  const out: ValueTagOption[] = [];
  for (const engine of builtinEngines) {
    const entry = AUTHORABLE[engine.name];
    if (!entry) continue;
    const produced = producedTypeOf(engine.name);
    const offered = produced ? producedFits(produced, prop) : evalMode !== null;
    if (offered) out.push({ id: engine.name, ...entry });
  }
  return out;
}

/** Whether a tag's produced type satisfies the slot's declared one. An
 *  undeclared slot accepts anything — it constrains nothing, so nothing about
 *  the value can contradict it. */
function producedFits(produced: Record<string, unknown>, prop: JsonSchemaProperty): boolean {
  if (!prop.type && !prop["x-telo-type"]) return true;
  return checkSchemaCompatibility(produced, prop as Record<string, unknown>).compatible;
}

/** The tag a value currently carries, or null for an untagged one. A raw string
 *  holding `${{ }}` reads as untagged: it IS untagged in the manifest, which is
 *  the spelling the formatter rewrites and the round trip has been known to
 *  mangle — so the picker shows it for what it is rather than for what it
 *  means. */
export function tagOf(value: unknown): string | null {
  return isTaggedSentinel(value) ? value.engine : null;
}

/** The source text under a tag, or "" for a value carrying none. */
export function tagSourceOf(value: unknown): string {
  if (isTaggedSentinel(value)) return value.source;
  return typeof value === "string" ? value : "";
}
