import { isRecord } from "../../lib/utils";
import type { CelEvalMode } from "./cel-utils";
import { buildEditorDefaultValue } from "./default-value";
import { FieldControl } from "./field-control";
import type { RefResolver } from "./ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption, TypeKindOption } from "./types";

interface OneOfVariantFieldProps {
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

interface Variant {
  keys: string[];
}

/** True when an object schema is a mutually-exclusive choice between named
 *  properties: `oneOf` branches that each just `require` a distinct property
 *  defined in `properties`. The user picks one branch; the others are cleared.
 *  Generic — no resource kind is hardcoded. */
export function isOneOfVariantSchema(prop: JsonSchemaProperty): boolean {
  if (!prop.properties) return false;
  const branches = prop.oneOf;
  if (!Array.isArray(branches) || branches.length < 2) return false;
  return branches.every(
    (b) =>
      Array.isArray(b.required) &&
      b.required.length > 0 &&
      b.required.every((k) => !!prop.properties?.[k]) &&
      b.type === undefined &&
      b.properties === undefined,
  );
}

function variantLabel(prop: JsonSchemaProperty, variant: Variant): string {
  const key = variant.keys[0];
  const title = prop.properties?.[key]?.title;
  return typeof title === "string" ? title : key;
}

export function OneOfVariantField({
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
}: OneOfVariantFieldProps) {
  const properties = prop.properties ?? {};
  const variants: Variant[] = (prop.oneOf ?? []).map((b) => ({
    keys: (b.required as string[] | undefined) ?? [],
  }));
  const record = isRecord(value) ? value : {};

  const activeIndex = (() => {
    const present = variants.findIndex((v) => v.keys.some((k) => k in record));
    return present === -1 ? 0 : present;
  })();

  function selectVariant(index: number) {
    if (index === activeIndex) return;
    const next: Record<string, unknown> = {};
    for (const key of variants[index].keys) {
      next[key] =
        record[key] ?? buildEditorDefaultValue(properties[key], resolvedResources, registry);
    }
    onValueChange(next);
  }

  const active = variants[activeIndex];

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit rounded border border-zinc-200 p-0.5 dark:border-zinc-700">
        {variants.map((variant, index) => (
          <button
            key={variant.keys.join(",")}
            type="button"
            onClick={() => selectVariant(index)}
            className={
              index === activeIndex
                ? "rounded bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100"
                : "rounded px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            }
          >
            {variantLabel(prop, variant)}
          </button>
        ))}
      </div>

      {active.keys.map((key) => (
        <FieldControl
          key={`${fieldPath}.${key}`}
          rootFieldName={rootFieldName}
          fieldPath={`${fieldPath}.${key}`}
          prop={properties[key]}
          value={record[key]}
          onValueChange={(next) => onValueChange({ ...record, [key]: next })}
          onFieldBlur={onFieldBlur}
          onErrorChange={onErrorChange}
          resolvedResources={resolvedResources}
          rootCelEval={rootCelEval}
          onSelectResource={onSelectResource}
          typeKinds={typeKinds}
          registry={registry}
        />
      ))}
    </div>
  );
}
