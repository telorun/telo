import type { CelEvalMode } from "./cel-utils";
import { FieldControl, inferType } from "./field-control";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ArrayObjectFieldProps {
  rootFieldName: string;
  fieldPath: string;
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onFieldBlur?: (name: string) => void;
  resolvedResources: ResolvedResourceOption[];
  rootCelEval?: CelEvalMode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRefValueMode(prop: JsonSchemaProperty): "string" | "object" {
  const oneOfTypes = (prop.oneOf ?? []).map((candidate) => candidate.type);
  const hasString = oneOfTypes.includes("string");
  const hasObject = oneOfTypes.includes("object");
  if (hasObject && !hasString) return "object";
  return "string";
}

function toResourceRefString(kind: string, name: string): string {
  return `${kind}.${name}`;
}

function normalizeCapability(capability: string): string {
  return capability.trim().toLowerCase();
}

function parseRefTarget(refTarget: string): { scope: string; symbol: string } | null {
  const hashIndex = refTarget.indexOf("#");
  if (hashIndex < 1 || hashIndex === refTarget.length - 1) return null;
  return {
    scope: refTarget.slice(0, hashIndex).toLowerCase(),
    symbol: refTarget.slice(hashIndex + 1),
  };
}

function filterResolvedResourcesByRef(
  refTarget: string,
  resolvedResources: ResolvedResourceOption[],
): ResolvedResourceOption[] {
  const parsed = parseRefTarget(refTarget);
  if (!parsed) return [];

  if (parsed.scope === "kernel") {
    const capability = normalizeCapability(`Kernel.${parsed.symbol}`);
    return resolvedResources.filter((resource) =>
      resource.capability ? normalizeCapability(resource.capability) === capability : false,
    );
  }

  return resolvedResources.filter((resource) => resource.kind.endsWith(`.${parsed.symbol}`));
}

function buildDefaultValue(
  prop: JsonSchemaProperty,
  resolvedResources: ResolvedResourceOption[],
): unknown {
  if (prop.default !== undefined) return prop.default;

  const refTarget = prop["x-telo-ref"];
  if (typeof refTarget === "string") {
    const options = filterResolvedResourcesByRef(refTarget, resolvedResources);
    if (options.length === 0) return undefined;
    const mode = getRefValueMode(prop);
    const first = options[0];
    if (mode === "object") return { kind: first.kind, name: first.name };
    return toResourceRefString(first.kind, first.name);
  }

  const kind = inferType(prop);
  if (kind === "boolean") return false;
  if (kind === "integer" || kind === "number") return 0;
  if (kind === "array") return [];
  if (kind === "object") return {};
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  return "";
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
  resolvedResources,
  rootCelEval,
}: ArrayObjectFieldProps) {
  const itemSchema = prop.items as JsonSchemaProperty;
  const entries = Array.isArray(value) ? value : [];
  const itemProperties = itemSchema.properties ?? {};
  const itemRequired = new Set(itemSchema.required ?? []);

  const buildDefaultItem = (): Record<string, unknown> => {
    const next: Record<string, unknown> = {};
    for (const [itemName, itemProp] of Object.entries(itemProperties)) {
      if (!itemRequired.has(itemName) && itemProp.default === undefined) continue;
      const initial = buildDefaultValue(itemProp, resolvedResources);
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

                return (
                  <div key={`${fieldPath}.${index}.${itemName}`} className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      {itemName}
                      {itemRequired.has(itemName) ? (
                        <span className="ml-1 text-red-500">*</span>
                      ) : null}
                      <span className="ml-1 text-zinc-400 dark:text-zinc-600">({itemKind})</span>
                    </label>
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
                      resolvedResources={resolvedResources}
                      rootCelEval={rootCelEval}
                    />
                    {typeof itemProp.description === "string" && (
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        {itemProp.description}
                      </span>
                    )}
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
