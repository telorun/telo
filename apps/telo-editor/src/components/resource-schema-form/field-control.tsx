import { ArrayObjectField } from "./array-object-field";
import { CelFieldWrapper } from "./cel-field-wrapper";
import { getCelEvalMode, type CelEvalMode } from "./cel-utils";
import { JsonSchemaField } from "./json-schema-field";
import { MapField } from "./map-field";
import { ObjectField } from "./object-field";
import { ReferenceSelectField } from "./reference-select-field";
import { ScalarField } from "./scalar-field";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";
import { UnsupportedField } from "./unsupported-field";

interface FieldControlProps {
  rootFieldName: string;
  fieldPath: string;
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onFieldBlur?: (name: string) => void;
  /**
   * Bubbles validation state up to `ResourceSchemaForm`'s aggregator, keyed by
   * `fieldPath`. Cleanup contract: any field that emits `(path, true)` MUST
   * also emit `(path, false)` when:
   *   1. its error state transitions back to clean,
   *   2. its `fieldPath` changes (emit `false` for the previous path),
   *   3. it unmounts (e.g. parent row removed, panel closed).
   * Stale paths in the aggregator latch `hasFormErrors=true` and silently
   * freeze saves, so this is correctness-critical, not optimization.
   */
  onErrorChange?: (fieldPath: string, hasError: boolean) => void;
  resolvedResources: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  /** Propagated to `ReferenceSelectField` so ref chips can open the peek panel. */
  onSelectResource?: (kind: string, name: string) => void;
  /** User-facing label for the field — used by `ObjectField`/`MapField` as the
   *  collapsible trigger title. Ignored by non-self-headed field types. */
  label?: string;
  /** Whether the parent schema marks this field as required. Used by
   *  `ObjectField`/`MapField` to decide whether to expose a Clear affordance. */
  required?: boolean;
}

export function inferType(prop: JsonSchemaProperty): string {
  if (prop.type) return prop.type;
  const oneOfTypes = (prop.oneOf ?? []).map((x) => x.type).filter(Boolean);
  if (oneOfTypes.length === 1) return oneOfTypes[0] as string;
  return "string";
}

const MAP_VALUE_QUALIFIERS = [
  "type",
  "oneOf",
  "anyOf",
  "properties",
  "x-telo-ref",
  "$ref",
  "const",
  "enum",
] as const;

/** True when `additionalProperties` is a real value schema (not `true`,
 *  `false`, or `{}`). The qualifying-keys list is deliberately schema-shape
 *  complete: anything missing here would silently misroute to `JsonSchemaField`,
 *  which is worse than rendering as the wrong widget. */
function isMapValueSchema(value: unknown): value is JsonSchemaProperty {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return MAP_VALUE_QUALIFIERS.some((key) => key in record);
}

/** True when the renderer draws its own field title. Callers should omit the
 *  parent label when this is true. */
export function ownsLabel(prop: JsonSchemaProperty): boolean {
  if (typeof prop["x-telo-ref"] === "string") return false;
  const hasNestedRef = (prop.anyOf ?? prop.oneOf ?? []).some(
    (item) => typeof item === "object" && item !== null && typeof item["x-telo-ref"] === "string",
  );
  if (hasNestedRef) return false;
  if (inferType(prop) !== "object") return false;
  if (prop.properties) return true;
  return isMapValueSchema(prop.additionalProperties);
}

/** True when the renderer draws `prop.description` itself. Callers should skip
 *  the bottom description row when this is true. */
export function ownsDescription(prop: JsonSchemaProperty): boolean {
  return ownsLabel(prop);
}

export function FieldControl({
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
  label,
  required,
}: FieldControlProps) {
  const kind = inferType(prop);
  const onBlur = () => onFieldBlur?.(rootFieldName);
  const evalMode = getCelEvalMode(prop, rootCelEval);

  function renderInner() {
    const hasDirectRef = typeof prop["x-telo-ref"] === "string";
    const hasNestedRef =
      !hasDirectRef &&
      (prop.anyOf ?? prop.oneOf ?? []).some(
        (item) =>
          typeof item === "object" && item !== null && typeof item["x-telo-ref"] === "string",
      );
    if (hasDirectRef || hasNestedRef) {
      return (
        <ReferenceSelectField
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onBlur={onBlur}
          resolvedResources={resolvedResources}
          onSelectResource={onSelectResource}
        />
      );
    }

    if (kind === "object" && prop.properties) {
      return (
        <ObjectField
          rootFieldName={rootFieldName}
          fieldPath={fieldPath}
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
          label={label}
          required={required}
        />
      );
    }

    if (kind === "array" && prop.items?.type === "object" && prop.items.properties) {
      return (
        <ArrayObjectField
          rootFieldName={rootFieldName}
          fieldPath={fieldPath}
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
        />
      );
    }

    if (kind === "object" && isMapValueSchema(prop.additionalProperties)) {
      return (
        <MapField
          rootFieldName={rootFieldName}
          fieldPath={fieldPath}
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
          label={label}
          required={required}
        />
      );
    }

    if (kind === "object") {
      return <JsonSchemaField value={value} onValueChange={onValueChange} onBlur={onBlur} />;
    }

    if (kind === "array") {
      return <UnsupportedField fieldPath={fieldPath} />;
    }

    return (
      <ScalarField
        prop={prop}
        value={value}
        kind={kind}
        onValueChange={onValueChange}
        onBlur={onBlur}
      />
    );
  }

  const inner = renderInner();
  const wrapped = evalMode ? (
    <CelFieldWrapper
      evalMode={evalMode}
      value={value}
      onValueChange={onValueChange}
      onBlur={onBlur}
    >
      {inner}
    </CelFieldWrapper>
  ) : (
    inner
  );

  // Self-headed fields render their own description inside the collapsible
  // trigger; everything else gets a description row below.
  if (ownsDescription(prop) || typeof prop.description !== "string") {
    return wrapped;
  }

  return (
    <div className="flex flex-col gap-1">
      {wrapped}
      <span className="text-xs text-zinc-400 dark:text-zinc-500">{prop.description}</span>
    </div>
  );
}
