import { Box, FileInput, FileOutput } from "lucide-react";
import {
  CREATE_REF_OPTION_PREFIX,
  collectRefTargets,
  inlineResourceKind,
  parseRefValue,
  pendingRefCreate,
  resolveRefCandidates,
  toRefString,
  toRefValue,
  type RefResolver,
} from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ReferenceSelectFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  resolvedResources: ResolvedResourceOption[];
  /** Narrows candidates by kind satisfaction (abstract refs). Omit to fall back
   *  to the kind/capability heuristic. */
  registry?: RefResolver | null;
  /** Opens the target in the peek panel when the chip is clicked. Omit to
   *  render a plain chip without peek affordance. */
  onSelectResource?: (kind: string, name: string) => void;
  /** Opens a resource declared inline in this slot — it has no name, so it is
   *  addressed by where it is written and cannot go through
   *  `onSelectResource`. Omit to render its chip without the affordance. */
  onOpenInline?: (kind: string) => void;
  /**
   * Moves the declaration this slot holds across the named/inline boundary —
   * `"extract"` out to its own document, `"inline"` back in from the resource
   * the slot references.
   *
   * ONE prop for both directions, because they are one move: every component
   * between the form root and this field would otherwise thread two, and the
   * slot is the only place where either is meaningful. Reported rather than
   * applied — each direction is a create or a delete paired with a slot write,
   * which has to be one workspace mutation (see `onCreateAndLink`).
   */
  onMoveDeclaration?: (direction: "extract" | "inline") => void;
}

function confirmDiscard(kind: string): boolean {
  return window.confirm(
    `Replace the inline ${kind}? It is declared only in this slot, so its configuration is discarded. Extract it to a named resource first to keep it.`,
  );
}

export function ReferenceSelectField({
  prop,
  value,
  onValueChange,
  onBlur,
  resolvedResources,
  registry,
  onSelectResource,
  onOpenInline,
  onMoveDeclaration,
}: ReferenceSelectFieldProps) {
  const refTargets = collectRefTargets(prop);
  if (refTargets.length === 0) return null;

  const inlineKind = inlineResourceKind(value);

  const options = resolveRefCandidates(refTargets, resolvedResources, registry);
  // Kinds that could FILL this slot but have no instance yet. Without them a
  // module that declares none of them is a dead end: the select reads "(no
  // candidates)" and there is nowhere to go. Same source the canvas rail uses
  // for its create-and-link `+`.
  const createKinds = [
    ...new Set(refTargets.flatMap((ref) => registry?.userFacingKindsForRef?.(ref) ?? [])),
  ].sort();
  const selectedName = parseRefValue(value);
  const selected = selectedName
    ? (options.find((option) => option.name === selectedName) ?? {
        kind: "",
        name: selectedName,
      })
    : null;
  const selectedKey = selected ? toRefString(selected) : "";
  const hasOptions = options.length > 0;
  const canCreate = createKinds.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {inlineKind ? (
          <button
            type="button"
            onClick={() => onOpenInline?.(inlineKind)}
            disabled={!onOpenInline}
            title="Open this inline resource"
            className="flex items-center gap-1 rounded border border-dashed border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-800 enabled:hover:border-amber-300 enabled:hover:text-amber-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:enabled:hover:border-amber-700 dark:enabled:hover:text-amber-300"
          >
            <Box className="size-3" />
            {inlineKind}
            <span className="text-zinc-400 dark:text-zinc-500">inline</span>
          </button>
        ) : (
          selected &&
          (onSelectResource ? (
            <button
              type="button"
              onClick={() => onSelectResource(selected.kind, selected.name)}
              className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-amber-700 dark:hover:text-amber-300"
              title="Peek in side panel"
            >
              {selected.kind}:{selected.name}
            </button>
          ) : (
            <span className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100">
              {selected.kind}:{selected.name}
            </span>
          ))
        )}
        {/* Where a declaration lives is a property of the slot, so the move is
            offered here — beside what it moves — rather than only from inside
            the declaration, which costs a navigation to reach either way. */}
        {onMoveDeclaration && (inlineKind || selected) && (
          <button
            type="button"
            onClick={() => onMoveDeclaration(inlineKind ? "extract" : "inline")}
            title={
              inlineKind
                ? "Extract to its own resource and reference it here"
                : "Inline that resource's declaration into this slot"
            }
            className="flex shrink-0 items-center rounded border border-zinc-200 p-1 text-zinc-500 hover:border-amber-300 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-amber-700 dark:hover:text-amber-300"
          >
            {inlineKind ? (
              <FileOutput className="size-3" />
            ) : (
              <FileInput className="size-3" />
            )}
          </button>
        )}
        <select
          value={selectedKey}
          onChange={(e) => {
            const next = e.target.value;
            // Replacing an inline declaration discards it — the slot is the
            // only place it exists. Confirmed rather than refused, because
            // "clear it first" would mean deleting it to reach the same state.
            if (inlineKind && !confirmDiscard(inlineKind)) {
              e.target.value = selectedKey;
              return;
            }
            if (!next) {
              onValueChange(undefined);
              return;
            }
            if (next.startsWith(CREATE_REF_OPTION_PREFIX)) {
              // Reported as a marker, not applied here: creating the resource
              // and linking it has to be one workspace mutation (see
              // `pendingRefCreate`).
              onValueChange(pendingRefCreate(next.slice(CREATE_REF_OPTION_PREFIX.length)));
              return;
            }
            const option = options.find((item) => toRefString(item) === next);
            if (!option) return;
            onValueChange(toRefValue(option));
          }}
          onBlur={onBlur}
          disabled={!hasOptions && !canCreate}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:disabled:bg-zinc-800"
        >
          <option value="">
            {selected ? "(change)" : hasOptions || canCreate ? "Set…" : "(no candidates)"}
          </option>
          {options.map((option) => {
            const refValue = toRefString(option);
            return (
              <option key={refValue} value={refValue}>
                {option.kind}:{option.name}
              </option>
            );
          })}
          {canCreate && (
            <optgroup label="Create">
              {createKinds.map((kind) => (
                <option key={kind} value={`${CREATE_REF_OPTION_PREFIX}${kind}`}>
                  New {kind}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
      {!hasOptions && !canCreate && (
        <span className="text-xs text-red-500">No resolved resources match {refTargets}.</span>
      )}
    </div>
  );
}
