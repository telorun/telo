import { useEffect, useMemo } from "react";
import type { CelEvalMode } from "./cel-utils";
import { FieldControl, inferType, willRenderAsObjectField } from "./field-control";
import type { JsonSchema, JsonSchemaProperty, ResolvedResourceOption } from "./types";

export interface ResourceSchemaFormProps {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onFieldBlur?: (name: string) => void;
  onParseStateChange?: (hasErrors: boolean) => void;
  resolvedResources?: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  onSelectResource?: (kind: string, name: string) => void;
}

export type { ResolvedResourceOption } from "./types";

export function ResourceSchemaForm({
  schema,
  values,
  onChange,
  onFieldBlur,
  onParseStateChange,
  resolvedResources = [],
  rootCelEval,
  onSelectResource,
}: ResourceSchemaFormProps) {
  const typedSchema = schema as JsonSchema;
  const properties = useMemo(() => typedSchema.properties ?? {}, [typedSchema.properties]);
  const required = new Set(typedSchema.required ?? []);

  const fields = useMemo(
    () => Object.entries(properties).map(([name, prop]) => ({ name, prop, kind: inferType(prop) })),
    [properties],
  );

  useEffect(() => {
    onParseStateChange?.(false);
  }, [onParseStateChange]);

  function setField(name: string, value: unknown) {
    onChange({ ...values, [name]: value });
  }

  if (fields.length === 0) {
    return <p className="text-xs text-zinc-400 dark:text-zinc-600">No schema fields.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.map(({ name, prop, kind }) => {
        const labelText = typeof prop.title === "string" ? prop.title : name;
        const ownsLabel = willRenderAsObjectField(prop as JsonSchemaProperty);
        return (
          <div key={name} className="flex flex-col gap-1">
            {!ownsLabel && (
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {labelText}
                {required.has(name) ? <span className="ml-1 text-red-500">*</span> : null}
                <span className="ml-1 text-zinc-400 dark:text-zinc-600">({kind})</span>
              </label>
            )}
            <FieldControl
              rootFieldName={name}
              fieldPath={name}
              prop={prop as JsonSchemaProperty}
              value={values[name]}
              onValueChange={(next) => setField(name, next)}
              onFieldBlur={onFieldBlur}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
              label={labelText}
              required={required.has(name)}
            />
            {typeof prop.description === "string" && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{prop.description}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
