import { checkName, DiagnosticSeverity } from "@telorun/analyzer";
import type { ParsedManifest, ParsedResource } from "../../../model";

/**
 * The module root's own declarations — what a module SAYS, as opposed to what it
 * runs.
 *
 * None of it is graph data: `imports`, `variables`, `secrets`, `ports` and
 * `exports` reference nothing and are referenced by nothing, so no edge carries
 * them and no node can hold them. `targets` is the single fact about a module
 * root that a canvas can draw, which is why the root reads as a half-node with
 * one slot and why adding an import had no affordance anywhere near the canvas.
 *
 * This module is the data half: what the bar lists, and the edits it applies to
 * the root's fields. Rendering and navigation live in `ModuleBar`.
 */

/** A name-keyed declaration block on the module root. */
export type BindingBlock = "variables" | "secrets" | "ports";

/** A Library's public surface, listed as two independent name lists. */
export type ExportGroup = "kinds" | "resources";

export interface DeclarationChip {
  name: string;
  /** Secondary line: the bound env var, or a re-export's declared origin. */
  detail?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Entries of one binding block, in declared order. The detail is the bound env
 *  var where there is one — a Library's `variables` bind nothing, so it stays
 *  empty rather than showing a placeholder. */
export function bindingChips(fields: Record<string, unknown>, block: BindingBlock): DeclarationChip[] {
  return Object.entries(asRecord(fields[block])).map(([name, entry]) => {
    const env = asRecord(entry).env;
    return { name, ...(typeof env === "string" && env ? { detail: env } : {}) };
  });
}

/** Entries of one export list. A `<Alias>.<Name>` entry is a re-export, so the
 *  importable name is the last segment and the whole entry is the detail — the
 *  origin alias is the part a reader would otherwise have to open the manifest
 *  to recover. */
export function exportChips(fields: Record<string, unknown>, group: ExportGroup): DeclarationChip[] {
  return asNames(asRecord(fields.exports)[group]).map((declared) => {
    const dot = declared.lastIndexOf(".");
    return dot > 0
      ? { name: declared.slice(dot + 1), detail: declared }
      : { name: declared };
  });
}

/** A name no entry of `block` uses yet. `base2`, `base3`, … rather than a
 *  random suffix, so a second entry added in a row reads as the second one. */
export function freshBindingName(fields: Record<string, unknown>, block: BindingBlock, base: string): string {
  const taken = asRecord(fields[block]);
  if (!(base in taken)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}${i}`;
    if (!(candidate in taken)) return candidate;
  }
}

/** Root fields with one binding entry added. The value is the minimum the entry
 *  schema requires and nothing more: a half-filled default would be written to
 *  the manifest as if the author had meant it. */
export function withBinding(
  fields: Record<string, unknown>,
  block: BindingBlock,
  name: string,
  isApplication: boolean,
): Record<string, unknown> {
  const entry: Record<string, unknown> =
    block === "ports"
      ? { env: "" }
      : isApplication
        ? { env: "", type: "string" }
        : { type: "string" };
  return { ...fields, [block]: { ...asRecord(fields[block]), [name]: entry } };
}

/**
 * Why `next` cannot be this entry's key, or undefined when it can.
 *
 * The grammar comes from the analyzer, not from a pattern restated here: a
 * binding name is read through a CEL scope, so `db-connection` parses as
 * subtraction and `in` is a keyword — exactly the failures `checkName` exists to
 * name, and a second copy of that rule would eventually disagree with the one
 * `telo check` runs. Only its ERRORS block; the camelCase tier is a warning
 * there, so it must not be a wall here either — a name is occasionally dictated
 * from outside.
 *
 * The collision check is local because a key is a map key: two entries of one
 * block cannot share a name, and silently overwriting the other one is the
 * failure mode of not checking.
 */
export function bindingNameError(
  fields: Record<string, unknown>,
  block: BindingBlock,
  current: string,
  next: string,
): string | undefined {
  if (next === current) return undefined;
  if (next === "") return "A name is required.";
  const violation = checkName(next, "value", block.replace(/s$/, ""));
  if (violation && violation.severity === DiagnosticSeverity.Error) return violation.message;
  if (next in asRecord(fields[block])) return `${block} already declares '${next}'.`;
  return undefined;
}

/**
 * Root fields with one binding entry removed, and the BLOCK removed with its
 * last entry.
 *
 * The opposite of `withoutExport` one function below, and deliberately: an
 * absent `exports.kinds` means ungated, so emptying that list must keep the key.
 * An empty `variables:` means nothing at all — and left behind, the diff deletes
 * only the last child, so the key survives with no value and reparses as `null`
 * rather than as an empty map.
 */
export function withoutBinding(
  fields: Record<string, unknown>,
  block: BindingBlock,
  name: string,
): Record<string, unknown> {
  const { [name]: _removed, ...rest } = asRecord(fields[block]);
  if (Object.keys(rest).length > 0) return { ...fields, [block]: rest };
  const { [block]: _emptied, ...withoutBlock } = fields;
  return withoutBlock;
}

/** Root fields with one name added to an export list, appended rather than
 *  sorted — the manifest's order is the author's. */
export function withExport(
  fields: Record<string, unknown>,
  group: ExportGroup,
  declared: string,
): Record<string, unknown> {
  const exports = asRecord(fields.exports);
  const current = asNames(exports[group]);
  if (current.includes(declared)) return fields;
  return { ...fields, exports: { ...exports, [group]: [...current, declared] } };
}

/** Root fields with one name removed from an export list. Removing the last
 *  entry leaves an empty list rather than dropping the key: an absent
 *  `exports.kinds` means UNGATED (every kind importable), so deleting the block
 *  would silently widen the module's public surface instead of narrowing it. */
export function withoutExport(
  fields: Record<string, unknown>,
  group: ExportGroup,
  declared: string,
): Record<string, unknown> {
  const exports = asRecord(fields.exports);
  return {
    ...fields,
    exports: { ...exports, [group]: asNames(exports[group]).filter((n) => n !== declared) },
  };
}

/**
 * The kernel's own DOCUMENT kinds — the docs that describe a module rather than
 * declare a resource in it.
 *
 * A closed set rather than the `Telo.` prefix test used elsewhere, because the
 * prefix is not the distinguishing fact: `Telo.JsonSchema` is a kernel-provided
 * resource KIND, so an instance of one is a perfectly exportable singleton, and
 * a prefix test silently refuses to offer it.
 */
const FRAMEWORK_DOC_KINDS: ReadonlySet<string> = new Set([
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
  "Telo.Definition",
  "Telo.Abstract",
]);

/**
 * Names this module could export but does not yet.
 *
 * Kinds come from the module's own `Telo.Definition` / `Telo.Abstract` docs;
 * instances from every doc that is not one of the kernel's own (see
 * {@link FRAMEWORK_DOC_KINDS}).
 *
 * Re-exports (`<Alias>.<Name>`) are deliberately not offered: naming one means
 * knowing what an imported library exports, which is the imports view's
 * knowledge, not a name this module declares.
 */
export function exportCandidates(
  manifest: ParsedManifest,
  fields: Record<string, unknown>,
  group: ExportGroup,
): string[] {
  const declared = new Set(asNames(asRecord(fields.exports)[group]));
  const owned = manifest.resources.filter((r: ParsedResource) =>
    group === "kinds"
      ? r.kind === "Telo.Definition" || r.kind === "Telo.Abstract"
      : !FRAMEWORK_DOC_KINDS.has(r.kind),
  );
  return owned.map((r) => r.name).filter((name) => !declared.has(name));
}
