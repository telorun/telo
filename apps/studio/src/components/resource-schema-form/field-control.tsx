import { isSchemaFragment, manifestFragmentOf, readRefSlot } from "@telorun/analyzer";
import { pointerToConcretePath } from "../../lib/concrete-path";
import { fieldPointer } from "../../lib/json-pointer";
import { ArrayObjectField } from "./array-object-field";
import { cn } from "@/lib/utils";
import { severityFieldClass } from "../diagnostics/severity";
import {
  diagnosticsAt,
  diagnosticsUnder,
  FieldDiagnostics,
  worstUnder,
  type FieldDiagnostic,
} from "./field-diagnostics";
import { offeredValueTags } from "./value-tag";
import { ValueTagField } from "./value-tag-field";
import { getCelEvalMode, type CelEvalMode } from "./cel-utils";
import { JsonSchemaField } from "./json-schema-field";
import { MapField } from "./map-field";
import { ObjectField } from "./object-field";
import { isOneOfVariantSchema, OneOfVariantField } from "./oneof-variant-field";
import { ScalarArrayField } from "./scalar-array-field";
import type { RefResolver } from "./ref-candidates";
import { ReferenceSelectField } from "./reference-select-field";
import { ScalarField } from "./scalar-field";
import { TypeField } from "./type-field";
import { isValueOrReferenceSlot, ValueOrReferenceField } from "./value-or-reference-field";
import type {
  CelFieldTarget,
  JsonSchemaProperty,
  ResolvedResourceOption,
  TypeKindOption,
} from "./types";
import { UnsupportedField } from "./unsupported-field";

/** A slot the picker can actually offer candidates for. Gates on the accepted
 *  KINDS being non-empty — the same test the analyzer's field map applies — so
 *  a malformed structured annotation with no `kind` falls through to normal
 *  rendering instead of a picker with nothing behind it (the analyzer reports
 *  it as `X_TELO_REF_MISSING_KIND`). */
function isPickableRefSlot(prop: JsonSchemaProperty): boolean {
  return (readRefSlot(prop)?.kinds.length ?? 0) > 0;
}

interface FieldControlProps {
  rootFieldName: string;
  /**
   * This field's render identity — the key errors are tracked under and rows
   * are reconciled by. NOT an address: a map's rows keep a stable id so that
   * renaming a key does not remount the row mid-keystroke.
   */
  fieldPath: string;
  /**
   * Where this field sits in the MANIFEST, which is a different question and
   * has a different answer inside a map. Everything pointing back at the
   * manifest uses it — which diagnostic belongs here, what a CEL body's scope
   * is resolved for, what a drill-in selects. Defaults to `fieldPath`, which is
   * correct everywhere the two coincide.
   */
  addressPath?: string;
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
  /** Opens a resource declared inline at a ref slot, addressed by the slot's
   *  field path — it has no name to be reached by. */
  onOpenInline?: (fieldPath: string, kind: string) => void;
  /** Moves the declaration at a ref slot across the named/inline boundary.
   *  Threaded beside `onOpenInline` — both address a slot by its field path. */
  onMoveDeclaration?: (fieldPath: string, direction: "extract" | "inline") => void;
  /** The site the FORM is rendering; this field's own address is composed from
   *  it and `fieldPath`. */
  celTarget?: CelFieldTarget;
  /** Every diagnostic in the form's scope, addressed by path. Passed down whole
   *  rather than narrowed per level: `fieldPath` already identifies the node,
   *  so each one matches on its own address. */
  fieldDiagnostics?: FieldDiagnostic[];
  /** Imported `Telo.Type` kinds offered for inline type fields. */
  typeKinds?: TypeKindOption[];
  /** Narrows `x-telo-ref` candidates by kind satisfaction (abstract refs). */
  registry?: RefResolver | null;
  /** User-facing label for the field — used by `ObjectField`/`MapField` as the
   *  collapsible trigger title. Ignored by non-self-headed field types. */
  label?: string;
  /** Whether the parent schema marks this field as required. Used by
   *  `ObjectField`/`MapField` to decide whether to expose a Clear affordance. */
  required?: boolean;
  /** Editor layout hint forwarded to `ObjectField`/`MapField` to render entries
   *  inline (horizontal) instead of behind an accordion. Set by the consumer. */
  flat?: boolean;
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

/** True when this slot holds author-written JSON Schema — a kind's `schema:`, a
 *  `status:` block, a `Telo.JsonSchema`'s own `schema`. The set of fragments
 *  that mean this belongs to the analyzer, which owns them; re-spelling it here
 *  is how the editor would keep rendering a text box for the next one. */
export function isSchemaFragmentSlot(prop: JsonSchemaProperty): boolean {
  return isSchemaFragment(manifestFragmentOf(prop));
}

/** True when the renderer draws its own field title. Callers should omit the
 *  parent label when this is true. */
export function ownsLabel(prop: JsonSchemaProperty): boolean {
  if (isPickableRefSlot(prop)) return false;
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
  addressPath,
  prop,
  value,
  onValueChange,
  onFieldBlur,
  onErrorChange,
  resolvedResources,
  rootCelEval,
  onSelectResource,
  onOpenInline,
  onMoveDeclaration,
  celTarget,
  fieldDiagnostics = [],
  typeKinds,
  registry,
  label,
  required,
  flat,
}: FieldControlProps) {
  const kind = inferType(prop);
  const address = addressPath ?? fieldPath;
  const onBlur = () => onFieldBlur?.(rootFieldName);
  const evalMode = getCelEvalMode(prop, rootCelEval);

  // Set by the branches that render child FieldControls of their own. Assigned
  // during render and read straight after, so it is a fact about this render
  // rather than state — which is what lets the branch decide it instead of a
  // second copy of the branch conditions below.
  let descends = false;

  function renderInner() {
    // A slot pointing at the shared JSON Schema fragment holds author-written
    // schema, and the schema editor is what draws one. Asked BEFORE anything
    // reads `type`: the slot carries a `$ref` and no type of its own, so
    // `inferType` would fall through to "string" and hand the author a
    // single-line text box for a nested structure. The stamp says which shape
    // the slot pointed at, which is the same question the retry-budget
    // consumers ask of `x-telo-fragment`.
    if (isSchemaFragmentSlot(prop)) {
      return <JsonSchemaField value={value} onValueChange={onValueChange} onBlur={onBlur} />;
    }

    if (isPickableRefSlot(prop)) {
      // A slot unioning a CLOSED value branch with a reference branch is one
      // control, and it is asked first: the reference/inline toggle below fires
      // on "some branch is `type: object`", which a reference branch satisfies,
      // so the two shapes are separated by the discriminator rather than by
      // ordering luck — a branch carrying `enum` beside one carrying
      // `x-telo-ref`.
      if (isValueOrReferenceSlot(prop)) {
        return (
          <ValueOrReferenceField
            prop={prop}
            value={value}
            onValueChange={onValueChange}
            onBlur={onBlur}
            resolvedResources={resolvedResources}
            registry={registry}
            onSelectResource={onSelectResource}
          />
        );
      }
      // A ref field that also permits an inline object (e.g. an invocable's
      // `inputType`/`outputType`) gets a Reference/Inline toggle so an empty
      // candidate list isn't a dead end.
      const allowsInlineObject = (prop.oneOf ?? prop.anyOf ?? []).some(
        (item) => typeof item === "object" && item !== null && item.type === "object",
      );
      if (allowsInlineObject) {
        return (
          <TypeField
            prop={prop}
            value={value}
            onValueChange={onValueChange}
            onBlur={onBlur}
            resolvedResources={resolvedResources}
            onSelectResource={onSelectResource}
            rootCelEval={evalMode}
            typeKinds={typeKinds}
            registry={registry}
          />
        );
      }
      return (
        <ReferenceSelectField
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onBlur={onBlur}
          resolvedResources={resolvedResources}
          registry={registry}
          onSelectResource={onSelectResource}
          // The slot's own path is what addresses a resource declared in it —
          // an inline declaration has no name to be reached by.
          onOpenInline={onOpenInline ? (kind) => onOpenInline(address, kind) : undefined}
          onMoveDeclaration={
            onMoveDeclaration ? (direction) => onMoveDeclaration(address, direction) : undefined
          }
        />
      );
    }

    if (kind === "object" && isOneOfVariantSchema(prop)) {
      descends = true;
      return (
        <OneOfVariantField
          rootFieldName={rootFieldName}
          fieldPath={fieldPath}
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={evalMode}
          onSelectResource={onSelectResource}
          onOpenInline={onOpenInline}
          onMoveDeclaration={onMoveDeclaration}
          celTarget={celTarget}
          fieldDiagnostics={fieldDiagnostics}
          addressPath={address}
          typeKinds={typeKinds}
          registry={registry}
        />
      );
    }

    if (kind === "object" && prop.properties) {
      descends = true;
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
          rootCelEval={evalMode}
          onSelectResource={onSelectResource}
          onOpenInline={onOpenInline}
          onMoveDeclaration={onMoveDeclaration}
          celTarget={celTarget}
          fieldDiagnostics={fieldDiagnostics}
          addressPath={address}
          typeKinds={typeKinds}
          registry={registry}
          label={label}
          required={required}
          flat={flat}
        />
      );
    }

    if (kind === "array" && prop.items?.type === "object" && prop.items.properties) {
      descends = true;
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
          rootCelEval={evalMode}
          onSelectResource={onSelectResource}
          onOpenInline={onOpenInline}
          onMoveDeclaration={onMoveDeclaration}
          celTarget={celTarget}
          fieldDiagnostics={fieldDiagnostics}
          addressPath={address}
          typeKinds={typeKinds}
          registry={registry}
        />
      );
    }

    if (kind === "object" && isMapValueSchema(prop.additionalProperties)) {
      descends = true;
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
          rootCelEval={evalMode}
          onSelectResource={onSelectResource}
          onOpenInline={onOpenInline}
          onMoveDeclaration={onMoveDeclaration}
          celTarget={celTarget}
          fieldDiagnostics={fieldDiagnostics}
          addressPath={address}
          typeKinds={typeKinds}
          registry={registry}
          label={label}
          required={required}
          flat={flat}
        />
      );
    }

    if (kind === "object") {
      return <JsonSchemaField value={value} onValueChange={onValueChange} onBlur={onBlur} />;
    }

    if (kind === "array" && prop.items && !["object", "array"].includes(inferType(prop.items))) {
      descends = true;
      return (
        <ScalarArrayField
          rootFieldName={rootFieldName}
          fieldPath={fieldPath}
          prop={prop}
          value={value}
          onValueChange={onValueChange}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={evalMode}
          onSelectResource={onSelectResource}
          onOpenInline={onOpenInline}
          onMoveDeclaration={onMoveDeclaration}
          celTarget={celTarget}
          fieldDiagnostics={fieldDiagnostics}
          addressPath={address}
          typeKinds={typeKinds}
          registry={registry}
        />
      );
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

  // A container's children carry their own messages, so it says only what names
  // it exactly; a leaf is where the path ends as far as this form renders, so it
  // claims everything below it — which is what keeps a diagnostic pointing into
  // a JSON blob or an un-rendered key visible instead of vanishing.
  const own = descends
    ? diagnosticsAt(fieldDiagnostics, address)
    : diagnosticsUnder(fieldDiagnostics, address);
  // Offered tags, not the eval mode, decide whether the field gets a picker: an
  // `!include-bytes` slot need not be CEL-eligible at all, and gating on eval
  // would leave a byte slot with no way to author it.
  const tagOptions = offeredValueTags(prop, evalMode);
  const wrapped = tagOptions.length > 0 ? (
    <ValueTagField
      options={tagOptions}
      evalMode={evalMode}
      value={value}
      onValueChange={onValueChange}
      onBlur={onBlur}
      // This field's own address: the form's scope plus where the field sits in
      // it. Composed here because `fieldPath` is this component's to know.
      celTarget={
        celTarget
          ? {
              ...celTarget,
              path: pointerToConcretePath(fieldPointer(celTarget.pointer, address)),
            }
          : undefined
      }
    >
      {inner}
    </ValueTagField>
  ) : (
    inner
  );

  // Self-headed fields render their own description inside the collapsible
  // trigger; everything else gets a description row below.
  const showDescription = !ownsDescription(prop) && typeof prop.description === "string";
  if (!showDescription && own.length === 0) return wrapped;

  // Colour the control itself, and only for a LEAF: a container's `own` holds
  // just what names it exactly, and a descendant selector there would paint
  // every input inside it.
  const worst = own.length ? worstUnder(own, address) : null;
  const tint = !descends && worst != null ? severityFieldClass(worst) : null;

  return (
    <div className={cn("flex flex-col gap-1", tint)}>
      {wrapped}
      {/* Before the description: what is WRONG with the value outranks what the
          field is for, and the help text is long enough to push a message out
          of sight. */}
      <FieldDiagnostics diagnostics={own} />
      {showDescription && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{prop.description}</span>
      )}
    </div>
  );
}
