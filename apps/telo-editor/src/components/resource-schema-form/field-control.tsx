import { ArrayObjectField } from "./array-object-field";
import { CelFieldWrapper } from "./cel-field-wrapper";
import { getCelEvalMode, type CelEvalMode } from "./cel-utils";
import { JsonSchemaField } from "./json-schema-field";
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
  resolvedResources: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
  /** Propagated to `ReferenceSelectField` so ref chips can open the peek panel. */
  onSelectResource?: (kind: string, name: string) => void;
  /** User-facing label for the field — used by `ObjectField` as the collapsible
   *  trigger title. Ignored by non-object field types. */
  label?: string;
}

export function inferType(prop: JsonSchemaProperty): string {
  if (prop.type) return prop.type;
  const oneOfTypes = (prop.oneOf ?? []).map((x) => x.type).filter(Boolean);
  if (oneOfTypes.length === 1) return oneOfTypes[0] as string;
  return "string";
}

/** True when `FieldControl` will delegate to `ObjectField` for this prop — i.e.
 *  the prop renders as a collapsible object card that owns its own header.
 *  Call sites use this to suppress their own label (the collapsible trigger
 *  displays the title instead). */
export function willRenderAsObjectField(prop: JsonSchemaProperty): boolean {
  if (typeof prop["x-telo-ref"] === "string") return false;
  const hasNestedRef = (prop.anyOf ?? prop.oneOf ?? []).some(
    (item) => typeof item === "object" && item !== null && typeof item["x-telo-ref"] === "string",
  );
  if (hasNestedRef) return false;
  return inferType(prop) === "object" && !!prop.properties;
}

export function FieldControl({
  rootFieldName,
  fieldPath,
  prop,
  value,
  onValueChange,
  onFieldBlur,
  resolvedResources,
  rootCelEval,
  onSelectResource,
  label,
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
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
          label={label}
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
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
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

  if (evalMode) {
    return (
      <CelFieldWrapper
        evalMode={evalMode}
        value={value}
        onValueChange={onValueChange}
        onBlur={onBlur}
      >
        {inner}
      </CelFieldWrapper>
    );
  }

  return inner;
}
