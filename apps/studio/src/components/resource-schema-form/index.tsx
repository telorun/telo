import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CelEvalMode } from "./cel-utils";
import { FieldControl, inferType, ownsLabel } from "./field-control";
import { SeverityDot, type FieldDiagnostic } from "./field-diagnostics";
import type { RefResolver } from "./ref-candidates";
import { resolveSiblingTypedProp } from "./sibling-typed-field";
import type {
  CelFieldTarget,
  JsonSchema,
  JsonSchemaProperty,
  ResolvedResourceOption,
  TypeKindOption,
} from "./types";

export interface ResourceSchemaFormProps {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onFieldBlur?: (name: string) => void;
  onParseStateChange?: (hasErrors: boolean) => void;
  resolvedResources?: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  onSelectResource?: (kind: string, name: string) => void;
  /** Opens a resource declared INLINE at a ref slot. Addressed by the slot's
   *  field path (dot-separated, numeric segments for array items) rather than
   *  by name, because an inline declaration has none. */
  onOpenInline?: (fieldPath: string, kind: string) => void;
  /** Moves the declaration at a ref slot across the named/inline boundary.
   *  Threaded beside `onOpenInline` — both address a slot by its field path. */
  onMoveDeclaration?: (fieldPath: string, direction: "extract" | "inline") => void;
  /** The site this form is rendering — the resource and the pointer it is
   *  scoped to. Supplies `!cel` fields the scope the analyzer resolved for
   *  their exact address; omit it and an expression is edited as plain text. */
  celTarget?: CelFieldTarget;
  /** Imported `Telo.Type` kinds offered for inline type fields. */
  typeKinds?: TypeKindOption[];
  /** Narrows `x-telo-ref` candidates by kind satisfaction (abstract refs). */
  registry?: RefResolver | null;
  /** Render object/map entries inline (horizontal) instead of behind an
   *  accordion. An editor layout choice set by the consuming view. */
  flat?: boolean;
  /** Analyzer diagnostics scoped to this form (paths relative to the form's
   *  pointer). Each top-level field surfaces the ones whose path falls under
   *  it; the consumer (DetailPanel) strips the pointer prefix before passing. */
  fieldDiagnostics?: FieldDiagnostic[];
}

export type { ResolvedResourceOption, TypeKindOption } from "./types";

export function ResourceSchemaForm({
  schema,
  values,
  onChange,
  onFieldBlur,
  onParseStateChange,
  resolvedResources = [],
  rootCelEval,
  onSelectResource,
  onOpenInline,
  onMoveDeclaration,
  celTarget,
  typeKinds,
  registry,
  flat,
  fieldDiagnostics = [],
}: ResourceSchemaFormProps) {
  const typedSchema = schema as JsonSchema;
  const properties = useMemo(() => typedSchema.properties ?? {}, [typedSchema.properties]);
  const required = new Set(typedSchema.required ?? []);

  // A field whose type is declared by a sibling is resolved against the CURRENT
  // values, so changing that sibling changes the widget immediately; one the
  // form cannot honestly render for the declared type drops out entirely.
  const fields = useMemo(
    () =>
      Object.entries(properties).flatMap(([name, rawProp]) => {
        const prop = resolveSiblingTypedProp(rawProp, values);
        return prop ? [{ name, prop, kind: inferType(prop) }] : [];
      }),
    [properties, values],
  );

  const errorPathsRef = useRef<Set<string>>(new Set());

  // Schema-keyed reset: clear the aggregator and re-emit `false` whenever the
  // form rebinds to a different schema. Prevents latched error state from
  // surviving resource navigation. Within a single schema, transitions are
  // driven entirely by `onErrorChange` calls below.
  useEffect(() => {
    errorPathsRef.current.clear();
    onParseStateChange?.(false);
  }, [schema, onParseStateChange]);

  const onErrorChange = useCallback(
    (path: string, hasError: boolean) => {
      const prev = errorPathsRef.current.size > 0;
      if (hasError) errorPathsRef.current.add(path);
      else errorPathsRef.current.delete(path);
      const next = errorPathsRef.current.size > 0;
      if (prev !== next) onParseStateChange?.(next);
    },
    [onParseStateChange],
  );

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
        const fieldOwnsLabel = ownsLabel(prop);
        return (
          <div key={name} className="flex flex-col gap-1">
            {!fieldOwnsLabel && (
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                {labelText}
                {required.has(name) ? <span className="ml-1 text-red-500">*</span> : null}
                <span className="ml-1 text-zinc-400 dark:text-zinc-600">({kind})</span>
                {/* The label marks that something below is wrong; the MESSAGE
                    now sits at the field it is about, which for a nested one is
                    somewhere inside this field rather than under it. */}
                <SeverityDot diagnostics={fieldDiagnostics} fieldPath={name} />
              </label>
            )}
            <FieldControl
              rootFieldName={name}
              fieldPath={name}
              prop={prop}
              value={values[name]}
              onValueChange={(next) => setField(name, next)}
              onFieldBlur={onFieldBlur}
              onErrorChange={onErrorChange}
              resolvedResources={resolvedResources}
              rootCelEval={rootCelEval}
              onSelectResource={onSelectResource}
              onOpenInline={onOpenInline}
              onMoveDeclaration={onMoveDeclaration}
              celTarget={celTarget}
              fieldDiagnostics={fieldDiagnostics}
              typeKinds={typeKinds}
              registry={registry}
              label={labelText}
              required={required.has(name)}
              flat={flat}
            />
          </div>
        );
      })}
    </div>
  );
}
