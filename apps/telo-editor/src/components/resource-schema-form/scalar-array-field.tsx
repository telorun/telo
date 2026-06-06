import { Trash2 as TrashIcon } from "lucide-react";
import type { CelEvalMode } from "./cel-utils";
import { buildEditorDefaultValue } from "./default-value";
import { FieldControl } from "./field-control";
import type { RefResolver } from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption, TypeKindOption } from "./types";

interface ScalarArrayFieldProps {
  rootFieldName: string;
  fieldPath: string;
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onFieldBlur?: (name: string) => void;
  onErrorChange?: (fieldPath: string, hasError: boolean) => void;
  resolvedResources: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  onSelectResource?: (kind: string, name: string) => void;
  typeKinds?: TypeKindOption[];
  registry?: RefResolver | null;
}

/** Renders an array of scalar items (string/number/boolean/enum). Each item is
 *  routed back through `FieldControl`, so per-item widgets — including
 *  `x-telo-widget: code` and CEL evaluation — work the same as a standalone
 *  scalar field. Generic: any scalar-item array opts in by virtue of its
 *  schema; not specific to any resource kind. */
export function ScalarArrayField({
  rootFieldName,
  fieldPath,
  prop,
  value,
  onValueChange,
  onFieldBlur,
  onErrorChange,
  resolvedResources,
  rootCelEval,
  onSelectResource,
  typeKinds,
  registry,
}: ScalarArrayFieldProps) {
  const itemSchema = (prop.items ?? { type: "string" }) as JsonSchemaProperty;
  const entries = Array.isArray(value) ? value : [];

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, index) => (
        <div key={`${fieldPath}.${index}`} className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <FieldControl
              rootFieldName={rootFieldName}
              fieldPath={`${fieldPath}.${index}`}
              prop={itemSchema}
              value={entry}
              onValueChange={(next) => {
                const updated = [...entries];
                updated[index] = next;
                onValueChange(updated);
              }}
              onFieldBlur={onFieldBlur}
              onErrorChange={onErrorChange}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
              typeKinds={typeKinds}
              registry={registry}
            />
          </div>
          <button
            type="button"
            onClick={() => onValueChange(entries.filter((_, rowIndex) => rowIndex !== index))}
            onBlur={() => onFieldBlur?.(rootFieldName)}
            className="mt-1 rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
            title="Remove item"
          >
            <TrashIcon className="size-3" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() =>
          onValueChange([
            ...entries,
            buildEditorDefaultValue(itemSchema, resolvedResources, registry),
          ])
        }
        onBlur={() => onFieldBlur?.(rootFieldName)}
        className="self-start rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        + Add item
      </button>
    </div>
  );
}
