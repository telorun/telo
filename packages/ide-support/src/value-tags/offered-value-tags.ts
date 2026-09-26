import { checkSchemaCompatibility } from "@telorun/analyzer";
import { builtinEngines, producedTypeOf } from "@telorun/templating";

/**
 * A YAML tag an author may write on a value, and what it means to write one.
 *
 * The split with `@telorun/templating` is deliberate. An engine declares what a
 * tag PRODUCES (`producedType()`) and where its CEL is (`expressionRegions`);
 * this declares how the tag is PRESENTED to an author, which is editor knowledge
 * no engine should carry. Applicability is derived from the engine's own
 * declaration rather than from a list of names here — so the table says how to
 * describe a tag, never which tags fit where.
 *
 * Shared by every editor host (VS Code completion, studio's source view and
 * schema form), so the hosts cannot disagree about which tags a field takes.
 */
export interface ValueTag {
  /** Engine name, which is the YAML tag without its `!`. */
  id: string;
  /** How the tag is written. */
  label: string;
  /** One line on what the tag does. */
  hint: string;
  /** Only meaningful where the slot is EVALUATED — the tag decides what
   *  evaluation does with the value (`!cel` supplies the expression, `!literal`
   *  opts out of interpolation), so outside such a field it says nothing the
   *  plain value does not. An embed is the other case: it supplies a value, and
   *  evaluation was never involved. */
  requiresEvalSlot?: boolean;
  /** Set when the scalar under the tag is a module-root-relative location of
   *  something that ships with the module, saying what it may name. */
  names?: "file" | "file-or-directory";
}

/**
 * The tags an author may write, by engine name.
 *
 * `!ref` is absent on purpose: it names a RESOURCE rather than producing a
 * value, so it belongs to a reference slot, never to a value one. `!sql` is
 * absent until a host can edit it as SQL — a plain text box would be the wrong
 * widget, and the hosts offer one set. An engine with no entry is simply not
 * offered, which is the safe direction.
 */
const AUTHORABLE: Record<string, Omit<ValueTag, "id">> = {
  cel: {
    label: "!cel",
    hint: "A CEL expression, evaluated against this field's scope.",
    requiresEvalSlot: true,
  },
  interpolate: {
    label: "!interpolate",
    hint: "Text with `${{ }}` holes, each a CEL expression; always a string.",
    requiresEvalSlot: true,
  },
  literal: {
    label: "!literal",
    hint: "Opaque text. `${{ }}` inside it is not interpolated.",
    requiresEvalSlot: true,
  },
  "include-text": {
    label: "!include-text",
    hint: "Contents of a file shipped with this module, as text.",
    names: "file",
  },
  "include-bytes": {
    label: "!include-bytes",
    hint: "Contents of a file shipped with this module, as raw bytes.",
    names: "file",
  },
  "module-path": {
    label: "!module-path",
    hint: "Location of a file or directory shipped with this module.",
    names: "file-or-directory",
  },
};

/** The authorable tag an engine name denotes, or undefined for a tag no host
 *  offers (`!ref`, `!sql`, an unknown one). */
export function valueTag(id: string): ValueTag | undefined {
  const entry = AUTHORABLE[id];
  return entry ? { id, ...entry } : undefined;
}

/**
 * The tags offerable at one field.
 *
 * Two rules, both read off the engine rather than off its name:
 *
 *  - CAN its value satisfy the slot? A tag that declares a produced type is
 *    offered only where that type fits. This is what puts `!include-bytes` on a
 *    `Telo.Bytes` slot and keeps it off a string one — and what keeps
 *    `!literal`, which is always text, off a boolean predicate. Checked with
 *    the analyzer's own comparator so the editor and `telo check` agree about
 *    what fits. A tag declaring no produced type (`!cel`) produces whatever the
 *    slot says and constrains nothing here.
 *  - Is it MEANINGFUL here? A tag that decides what evaluation does with the
 *    value needs a slot that is evaluated at all: outside one, `!cel` is a
 *    value the runtime never evaluates (`CEL_IN_NON_EVAL_FIELD`), and
 *    `!literal` suppresses an interpolation that was never going to happen.
 *
 * `prop` undefined is a field with no declared schema, which constrains
 * nothing. `evalMode` undefined means no rule decides whether the field is
 * evaluated, so the second question is not asked.
 */
export function offeredValueTags(
  prop: Record<string, unknown> | undefined,
  evalMode: "compile" | "runtime" | null | undefined,
): ValueTag[] {
  const out: ValueTag[] = [];
  for (const engine of builtinEngines) {
    const tag = valueTag(engine.name);
    if (!tag) continue;
    const produced = producedTypeOf(engine.name);
    const fitsSlot = produced && prop ? producedFits(produced, prop) : true;
    const meaningful = tag.requiresEvalSlot && evalMode !== undefined ? evalMode !== null : true;
    if (fitsSlot && meaningful) out.push(tag);
  }
  return out;
}

/** Whether a tag's produced type satisfies the slot's declared one. An
 *  undeclared slot accepts anything — it constrains nothing, so nothing about
 *  the value can contradict it. A union declares through its branches. */
function producedFits(produced: Record<string, unknown>, prop: Record<string, unknown>): boolean {
  if (!prop.type && !prop["x-telo-type"] && !prop.anyOf && !prop.oneOf) return true;
  return checkSchemaCompatibility(produced, prop).compatible;
}
