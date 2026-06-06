import { useState } from "react";
import { isRecord } from "../../lib/utils";
import type { CelEvalMode } from "./cel-utils";
import type { RefResolver } from "./ref-candidates";
import { ReferenceSelectField } from "./reference-select-field";
import { ResourceSchemaForm } from "./index";
import type { JsonSchemaProperty, ResolvedResourceOption, TypeKindOption } from "./types";

interface TypeFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  resolvedResources: ResolvedResourceOption[];
  onSelectResource?: (kind: string, name: string) => void;
  rootCelEval?: CelEvalMode | null;
  /** Imported `Telo.Type` kinds the user can instantiate inline. */
  typeKinds?: TypeKindOption[];
  registry?: RefResolver | null;
}

type Mode = "reference" | "inline";

const selectClass =
  "rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";

/** A field that accepts either a named type reference (`x-telo-ref`) or an inline
 *  type resource. Wraps the reference picker and an inline editor behind a mode
 *  toggle so an empty type list is never a dead end.
 *
 *  Inline editing is fully generic: the user first picks which imported
 *  `Telo.Type` kind to instantiate (JSON Schema, Cue, …), then edits that kind's
 *  body through its own schema form. The value is the inline resource shape
 *  `{ kind: <picked>, ...fields }`, which the analyzer normalizes into a
 *  synthesized type resource. No type system is hardcoded — only kinds the
 *  module imports appear. */
export function TypeField({
  prop,
  value,
  onValueChange,
  onBlur,
  resolvedResources,
  onSelectResource,
  rootCelEval,
  typeKinds = [],
  registry,
}: TypeFieldProps) {
  const [emptyMode, setEmptyMode] = useState<Mode>("reference");
  const isEmpty = value == null || value === "";
  const mode: Mode = isEmpty ? emptyMode : isRecord(value) ? "inline" : "reference";

  function switchTo(next: Mode) {
    setEmptyMode(next);
    // Clear a value that belongs to the mode we're leaving.
    if (next === "reference" && isRecord(value)) onValueChange(undefined);
    if (next === "inline" && typeof value === "string") onValueChange(undefined);
  }

  const selectedKind = isRecord(value) && typeof value.kind === "string" ? value.kind : undefined;
  const selectedSchema = typeKinds.find((k) => k.kind === selectedKind)?.schema;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="inline-flex w-fit overflow-hidden rounded border border-zinc-300 text-[10px] dark:border-zinc-700">
        {(["reference", "inline"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchTo(m)}
            className={`px-2 py-0.5 ${
              mode === m
                ? "bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900"
                : "bg-white text-zinc-500 hover:text-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {m === "reference" ? "Reference" : "Inline"}
          </button>
        ))}
      </div>
      {mode === "reference" ? (
        <ReferenceSelectField
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onBlur={onBlur}
          resolvedResources={resolvedResources}
          registry={registry}
          onSelectResource={onSelectResource}
        />
      ) : typeKinds.length === 0 ? (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          No type kinds imported. Import a type system (e.g. <code>std/type</code>) to define an
          inline type.
        </span>
      ) : (
        <div className="flex flex-col gap-2">
          <select
            value={selectedKind ?? ""}
            onChange={(e) => onValueChange(e.target.value ? { kind: e.target.value } : undefined)}
            onBlur={onBlur}
            className={selectClass}
          >
            <option value="">Select type kind…</option>
            {typeKinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind}
              </option>
            ))}
          </select>
          {selectedKind && selectedSchema && (
            <div className="rounded border border-zinc-200 p-2 dark:border-zinc-700">
              <ResourceSchemaForm
                schema={selectedSchema}
                values={isRecord(value) ? value : {}}
                onChange={onValueChange}
                resolvedResources={resolvedResources}
                rootCelEval={rootCelEval}
                onSelectResource={onSelectResource}
                typeKinds={typeKinds}
                registry={registry}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
