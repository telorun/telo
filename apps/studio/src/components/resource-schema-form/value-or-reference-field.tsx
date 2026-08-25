import { readRefSlot } from "@telorun/analyzer";
import { useState } from "react";
import { isRecord } from "../../lib/utils";
import { isRefSentinel } from "@telorun/templating";
import { parseRefValue, resolveRefCandidates, type RefResolver } from "./ref-candidates";
import { ReferenceSelectField } from "./reference-select-field";
import { ScalarField } from "./scalar-field";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

/**
 * One control for a slot that holds **either a value or a reference** — a
 * declared column's `type:`, which is a storage class from the backend's closed
 * vocabulary or a `!ref` to a declared enum.
 *
 * Generic by construction: the renderer reads the slot's own branches, so
 * nothing here knows what an enum is and the same control serves any
 * value-or-reference slot. The dispatch rule follows from that — the existing
 * reference/inline toggle fires on "some branch is `type: object`", which a
 * reference branch satisfies, so this renderer is asked first, on the
 * discriminator that separates the two shapes.
 *
 * **The reference entry is a MODE, never a value.** The slot holds `text` or a
 * `!ref`, and which one is read back from the value, so nothing new is written
 * and there is no second field free to disagree with the first.
 *
 * A value branch is either **closed** (it declares `enum`, so its own values are
 * the mode entries) or **open** (a plain scalar type, which gets a `value` mode
 * entry and a scalar input). Gating on a closed branch alone would send every
 * open one to the inline-object editor — a JSON editor for what is a scalar, and
 * a dead end for visual editing.
 */

/** Marks a select entry as "switch to the reference picker for this kind"
 *  rather than a value. A JSON Schema `enum` entry is an author's own
 *  vocabulary, so the prefix is what keeps the two apart. */
const REF_MODE_PREFIX = "::ref:";
/** The same, for the value mode of an OPEN value branch. */
const VALUE_MODE = "::value";

const SCALAR_TYPES = ["string", "integer", "number", "boolean"];

/** What the slot's non-reference branches accept. */
type ValueShape =
  /** The branches declare their own vocabulary; those values are the entries. */
  | { readonly closed: true; readonly options: string[] }
  /** A plain scalar: one `value` entry plus an input. */
  | { readonly closed: false; readonly branch: JsonSchemaProperty };

function valueShapeOf(prop: JsonSchemaProperty): ValueShape | null {
  const branches = readRefSlot(prop as Record<string, unknown>)?.valueBranches ?? [];
  const options: string[] = [];
  for (const branch of branches) {
    const values = (branch as { enum?: unknown }).enum;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && !options.includes(value)) options.push(value);
    }
  }
  if (options.length > 0) return { closed: true, options };
  const scalar = branches.find((branch) =>
    SCALAR_TYPES.includes(String((branch as { type?: unknown }).type)),
  );
  return scalar ? { closed: false, branch: scalar as JsonSchemaProperty } : null;
}

/** True when the slot unions a reference branch with a value branch. */
export function isValueOrReferenceSlot(prop: JsonSchemaProperty): boolean {
  const slot = readRefSlot(prop as Record<string, unknown>);
  if (!slot || slot.kinds.length === 0) return false;
  return valueShapeOf(prop) !== null;
}

/** How a kind reads in the vocabulary it sits beside — `Self.Enum` next to
 *  `text` and `uuid` is offered as `enum`. Display only: the option's VALUE
 *  carries the kind. Two permitted kinds sharing a suffix would collapse to one
 *  label, so an ambiguous suffix falls back to the kind as written. */
function kindLabel(kind: string, kinds: readonly string[]): string {
  const suffix = (name: string) => name.slice(name.lastIndexOf(".") + 1);
  const own = suffix(kind);
  const ambiguous = kinds.filter((other) => suffix(other) === own).length > 1;
  return ambiguous ? kind : own.toLowerCase();
}

const selectClass =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";

interface ValueOrReferenceFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  resolvedResources: ResolvedResourceOption[];
  registry?: RefResolver | null;
  onSelectResource?: (kind: string, name: string) => void;
}

export function ValueOrReferenceField({
  prop,
  value,
  onValueChange,
  onBlur,
  resolvedResources,
  registry,
  onSelectResource,
}: ValueOrReferenceFieldProps) {
  const slot = readRefSlot(prop as Record<string, unknown>);
  const kinds = slot?.kinds ?? [];
  const shape = valueShapeOf(prop);

  // Which mode is showing while the slot is still empty. The value itself
  // carries the mode once one is written, so this only ever covers the gap
  // between picking an entry and filling it in.
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const isReference = isRefSentinel(value) || isRecord(value);

  // WHICH kind's picker, read off the reference itself rather than assumed to be
  // the first permitted one — a slot accepting two kinds would otherwise render
  // the wrong picker for a reference to the second. Resolved through the same
  // candidate rule the picker uses, so both agree about what fills a slot.
  const referencedName = isReference ? parseRefValue(value) : null;
  const referencedKind =
    kinds.find((kind) =>
      resolveRefCandidates([kind], resolvedResources, registry).some(
        (option) => option.name === referencedName,
      ),
    ) ??
    kinds[0] ??
    null;

  const activeMode = isReference
    ? `${REF_MODE_PREFIX}${referencedKind ?? ""}`
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? shape?.closed
        ? String(value)
        : VALUE_MODE
      : (pendingMode ?? "");

  const activeKind = activeMode.startsWith(REF_MODE_PREFIX)
    ? activeMode.slice(REF_MODE_PREFIX.length)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={activeMode}
        onChange={(e) => {
          const next = e.target.value;
          setPendingMode(next || null);
          if (next.startsWith(REF_MODE_PREFIX)) {
            // A value belongs to the mode being left; a reference already in
            // place is kept, so re-picking the same entry is not a clear.
            if (!isReference) onValueChange(undefined);
            return;
          }
          if (next === VALUE_MODE || next === "") {
            if (isReference) onValueChange(undefined);
            return;
          }
          onValueChange(next);
        }}
        onBlur={onBlur}
        className={selectClass}
      >
        <option value="">Set…</option>
        {shape?.closed
          ? shape.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))
          : shape && (
              <option key={VALUE_MODE} value={VALUE_MODE}>
                value
              </option>
            )}
        {kinds.map((kind) => (
          <option key={kind} value={`${REF_MODE_PREFIX}${kind}`}>
            {kindLabel(kind, kinds)}
          </option>
        ))}
      </select>
      {activeKind !== null && (
        <ReferenceSelectField
          prop={prop}
          value={isReference ? value : undefined}
          onValueChange={onValueChange}
          onBlur={onBlur}
          resolvedResources={resolvedResources}
          registry={registry}
          onSelectResource={onSelectResource}
        />
      )}
      {activeMode === VALUE_MODE && shape && !shape.closed && (
        <ScalarField
          prop={shape.branch}
          value={isReference ? undefined : value}
          kind={String((shape.branch as { type?: unknown }).type ?? "string")}
          onValueChange={onValueChange}
          onBlur={onBlur}
        />
      )}
    </div>
  );
}
