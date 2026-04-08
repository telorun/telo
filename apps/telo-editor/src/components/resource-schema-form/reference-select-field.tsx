import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface ReferenceSelectFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
  resolvedResources: ResolvedResourceOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getRefValueMode(prop: JsonSchemaProperty): "string" | "object" {
  const candidates = [...(prop.oneOf ?? []), ...(prop.anyOf ?? [])];
  const types = candidates.map((candidate) => candidate.type);
  const hasString = types.includes("string");
  const hasObject = types.includes("object");
  if (hasObject && !hasString) return "object";
  return "string";
}

function toResourceRefString(kind: string, name: string): string {
  return `${kind}.${name}`;
}

function toSelectedRefString(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const kind = value.kind;
  const name = value.name;
  if (typeof kind !== "string" || typeof name !== "string") return "";
  return toResourceRefString(kind, name);
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

function collectRefTargets(prop: JsonSchemaProperty): string[] {
  if (typeof prop["x-telo-ref"] === "string") return [prop["x-telo-ref"]];
  const targets: string[] = [];
  for (const item of prop.anyOf ?? prop.oneOf ?? []) {
    if (typeof item === "object" && item !== null && typeof item["x-telo-ref"] === "string") {
      targets.push(item["x-telo-ref"]);
    }
  }
  return targets;
}

export function ReferenceSelectField({
  prop,
  value,
  onValueChange,
  onBlur,
  resolvedResources,
}: ReferenceSelectFieldProps) {
  const refTargets = collectRefTargets(prop);
  if (refTargets.length === 0) return null;

  const seen = new Set<string>();
  const options: ResolvedResourceOption[] = [];
  for (const refTarget of refTargets) {
    for (const resource of filterResolvedResourcesByRef(refTarget, resolvedResources)) {
      const key = `${resource.kind}/${resource.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        options.push(resource);
      }
    }
  }
  const selected = toSelectedRefString(value);
  const mode = getRefValueMode(prop);
  const hasOptions = options.length > 0;

  return (
    <div className="flex flex-col gap-1">
      <select
        value={selected}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) {
            onValueChange(undefined);
            return;
          }
          const option = options.find((item) => toResourceRefString(item.kind, item.name) === next);
          if (!option) return;
          if (mode === "object") {
            onValueChange({ kind: option.kind, name: option.name });
            return;
          }
          onValueChange(next);
        }}
        onBlur={onBlur}
        disabled={!hasOptions}
        className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:disabled:bg-zinc-800"
      >
        <option value="">{hasOptions ? "(select resource)" : "(no resolved resources)"}</option>
        {options.map((option) => {
          const refValue = toResourceRefString(option.kind, option.name);
          return (
            <option key={refValue} value={refValue}>
              {refValue}
            </option>
          );
        })}
      </select>
      {!hasOptions && (
        <span className="text-xs text-red-500">No resolved resources match {refTargets}.</span>
      )}
    </div>
  );
}
