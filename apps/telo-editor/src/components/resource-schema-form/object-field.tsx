import type { CelEvalMode } from "./cel-utils";
import { FieldControl, inferType } from "./field-control";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ObjectFieldProps {
  rootFieldName: string;
  fieldPath: string;
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onFieldBlur?: (name: string) => void;
  resolvedResources: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  onSelectResource?: (kind: string, name: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  resolvedResources,
  rootCelEval,
  onSelectResource,
}: ObjectFieldProps) {
  const objectValue = isRecord(value) ? value : {};
  const objectRequired = new Set(prop.required ?? []);
  const properties = prop.properties ?? {};

  return (
    <div className="flex flex-col gap-2">
      {Object.entries(properties).map(([childName, childProp]) => {
        const childValue = objectValue[childName];
        const childKind = inferType(childProp);

        return (
          <div key={`${fieldPath}.${childName}`} className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
              {typeof childProp.title === "string" ? childProp.title : childName}
              {objectRequired.has(childName) ? <span className="ml-1 text-red-500">*</span> : null}
              <span className="ml-1 text-zinc-400 dark:text-zinc-600">({childKind})</span>
            </label>
            <FieldControl
              rootFieldName={rootFieldName}
              fieldPath={`${fieldPath}.${childName}`}
              prop={childProp}
              value={childValue}
              onValueChange={(next) => onValueChange(setObjectChild(objectValue, childName, next))}
              onFieldBlur={onFieldBlur}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
            />
            {typeof childProp.description === "string" && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {childProp.description}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
