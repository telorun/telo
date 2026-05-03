import { isRecord } from "../../lib/utils";
import type { CelEvalMode } from "./cel-utils";
import { buildEditorDefaultValue } from "./default-value";
import { FieldControl, inferType, ownsLabel } from "./field-control";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ArrayObjectFieldProps {
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
}

function setObjectChild(
  source: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> | undefined {
  const updated: Record<string, unknown> = { ...source };
  if (next === undefined || next === null || next === "") {
    delete updated[key];
  } else {
    updated[key] = next;
  }
  return Object.keys(updated).length > 0 ? updated : undefined;
}

export function ArrayObjectField({
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
}: ArrayObjectFieldProps) {
  const itemSchema = prop.items as JsonSchemaProperty;
  const entries = Array.isArray(value) ? value : [];
  const itemProperties = itemSchema.properties ?? {};
  const itemRequired = new Set(itemSchema.required ?? []);

  const buildDefaultItem = (): Record<string, unknown> => {
    const next: Record<string, unknown> = {};
    for (const [itemName, itemProp] of Object.entries(itemProperties)) {
      if (!itemRequired.has(itemName) && itemProp.default === undefined) continue;
      const initial = buildEditorDefaultValue(itemProp, resolvedResources);
      if (initial !== undefined) next[itemName] = initial;
    }
    return next;
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, index) => {
        const entryValue = isRecord(entry) ? entry : {};
        return (
          <div
            key={`${fieldPath}.${index}`}
            className="rounded border border-zinc-200 p-2 dark:border-zinc-700"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Item {index + 1}
              </span>
              <button
                type="button"
                onClick={() => onValueChange(entries.filter((_, rowIndex) => rowIndex !== index))}
                onBlur={() => onFieldBlur?.(rootFieldName)}
                className="rounded px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
              >
                Remove
              </button>
            </div>

            <div className="flex flex-col gap-2">
              {Object.entries(itemProperties).map(([itemName, itemProp]) => {
                const itemValue = entryValue[itemName];
                const itemKind = inferType(itemProp);
                const itemLabel =
                  typeof itemProp.title === "string" ? itemProp.title : itemName;
                const itemOwnsLabel = ownsLabel(itemProp);

                return (
                  <div key={`${fieldPath}.${index}.${itemName}`} className="flex flex-col gap-1">
                    {!itemOwnsLabel && (
                      <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {itemLabel}
                        {itemRequired.has(itemName) ? (
                          <span className="ml-1 text-red-500">*</span>
                        ) : null}
                        <span className="ml-1 text-zinc-400 dark:text-zinc-600">({itemKind})</span>
                      </label>
                    )}
                    <FieldControl
                      rootFieldName={rootFieldName}
                      fieldPath={`${fieldPath}.${index}.${itemName}`}
                      prop={itemProp}
                      value={itemValue}
                      onValueChange={(next) => {
                        const updated = [...entries];
                        const nextItem = setObjectChild(entryValue, itemName, next);
                        updated[index] = nextItem ?? {};
                        onValueChange(updated);
                      }}
                      onFieldBlur={onFieldBlur}
                      onErrorChange={onErrorChange}
                      resolvedResources={resolvedResources}
                      rootCelEval={rootCelEval}
                      onSelectResource={onSelectResource}
                      label={itemLabel}
                      required={itemRequired.has(itemName)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => onValueChange([...entries, buildDefaultItem()])}
        onBlur={() => onFieldBlur?.(rootFieldName)}
        className="self-start rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        + Add item
      </button>
    </div>
  );
}
