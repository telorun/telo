import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { isRecord } from "../../lib/utils";
import type { CelEvalMode } from "./cel-utils";
import { FieldControl, inferType, ownsLabel } from "./field-control";
import type { RefResolver } from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption, TypeKindOption } from "./types";

interface ObjectFieldProps {
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
  /** Fallback for the collapsible trigger title when the schema has no
   *  `title`. Passed in by the parent (the property name it would otherwise
   *  have rendered as a label). */
  label?: string;
  /** Whether this field is required by the parent schema. When false, the
   *  header exposes a Clear button that unsets the whole object. */
  required?: boolean;
  /** Render the fields inline in a horizontal wrapping row instead of behind a
   *  collapsible accordion. An editor layout choice, not a schema concern — set
   *  by the consumer (e.g. the module-root variables/secrets form). */
  flat?: boolean;
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

export function ObjectField({
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
  label,
  required,
  flat = false,
}: ObjectFieldProps) {
  const objectValue = isRecord(value) ? value : {};
  const objectRequired = new Set(prop.required ?? []);
  const properties = prop.properties ?? {};
  const propertyCount = Object.keys(properties).length;
  const triggerTitle =
    (typeof prop.title === "string" ? prop.title : undefined) ?? label ?? "object";
  const canClear = !required && value !== undefined && value !== null;
  const description = typeof prop.description === "string" ? prop.description : undefined;

  const fields = Object.entries(properties).map(([childName, childProp]) => {
    const childValue = objectValue[childName];
    const childKind = inferType(childProp);
    const childLabel = typeof childProp.title === "string" ? childProp.title : childName;
    const childOwnsLabel = ownsLabel(childProp);

    return (
      <div
        key={`${fieldPath}.${childName}`}
        className={flat ? "flex min-w-28 flex-1 flex-col gap-0.5" : "flex flex-col gap-1"}
      >
        {!childOwnsLabel && (
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {childLabel}
            {objectRequired.has(childName) ? <span className="ml-1 text-red-500">*</span> : null}
            <span className="ml-1 text-zinc-400 dark:text-zinc-600">({childKind})</span>
          </label>
        )}
        <FieldControl
          rootFieldName={rootFieldName}
          fieldPath={`${fieldPath}.${childName}`}
          prop={childProp}
          value={childValue}
          onValueChange={(next) => onValueChange(setObjectChild(objectValue, childName, next))}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
          typeKinds={typeKinds}
          registry={registry}
          label={childLabel}
          required={objectRequired.has(childName)}
        />
      </div>
    );
  });

  if (flat) {
    return <div className="flex flex-1 flex-wrap items-start gap-2">{fields}</div>;
  }

  return (
    <CollapsiblePrimitive.Root className="group rounded border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-stretch">
        <CollapsiblePrimitive.Trigger className="flex flex-1 items-center gap-2 px-2 py-1 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60">
          <span
            aria-hidden="true"
            className="w-3 text-zinc-500 group-data-[state=open]:hidden dark:text-zinc-500"
          >
            ▸
          </span>
          <span
            aria-hidden="true"
            className="hidden w-3 text-zinc-500 group-data-[state=open]:inline dark:text-zinc-500"
          >
            ▾
          </span>
          <span>{triggerTitle}</span>
          {description && (
            <span className="truncate text-xs font-normal text-zinc-400 dark:text-zinc-500">
              — {description}
            </span>
          )}
          <span className="ml-auto text-xs font-normal text-zinc-400 dark:text-zinc-500">
            {propertyCount} field{propertyCount === 1 ? "" : "s"}
          </span>
        </CollapsiblePrimitive.Trigger>
        {canClear && (
          <button
            type="button"
            onClick={() => onValueChange(undefined)}
            onBlur={() => onFieldBlur?.(rootFieldName)}
            className="px-2 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
            title="Clear this field"
          >
            Clear
          </button>
        )}
      </div>
      <CollapsiblePrimitive.Content className="flex flex-col gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
        {fields}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
