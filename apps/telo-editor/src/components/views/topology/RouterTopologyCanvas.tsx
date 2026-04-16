import { useMemo } from "react";
import type { Selection, ParsedResource } from "../../../model";
import { Button } from "../../ui/button";

interface RouterTopologyCanvasProps {
  resource: ParsedResource;
  schema: Record<string, unknown>;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelect: (selection: Selection) => void;
  onBackgroundClick: () => void;
}

interface RouterSchemaInfo {
  entriesField: string | null;
  matcherField: string | null;
  handlerField: string | null;
  entriesSchema: Record<string, unknown> | null;
  matcherSchema: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTopologyRole(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value["x-telo-topology-role"] === "string"
    ? (value["x-telo-topology-role"] as string)
    : null;
}

function getRouterSchemaInfo(schema: Record<string, unknown>): RouterSchemaInfo {
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) {
    return {
      entriesField: null,
      matcherField: null,
      handlerField: null,
      entriesSchema: null,
      matcherSchema: null,
    };
  }

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (getTopologyRole(fieldSchema) !== "entries" || !isRecord(fieldSchema)) continue;

    const items = isRecord(fieldSchema.items) ? fieldSchema.items : null;
    const itemProperties = items && isRecord(items.properties) ? items.properties : null;
    if (!itemProperties) {
      return {
        entriesField: fieldName,
        matcherField: null,
        handlerField: null,
        entriesSchema: isRecord(fieldSchema) ? fieldSchema : null,
        matcherSchema: null,
      };
    }

    let matcherField: string | null = null;
    let handlerField: string | null = null;
    let matcherSchema: Record<string, unknown> | null = null;

    for (const [entryFieldName, entryFieldSchema] of Object.entries(itemProperties)) {
      const role = getTopologyRole(entryFieldSchema);
      if (role === "matcher") {
        matcherField = entryFieldName;
        matcherSchema = isRecord(entryFieldSchema) ? entryFieldSchema : null;
      }
      if (role === "handler") handlerField = entryFieldName;
    }

    return {
      entriesField: fieldName,
      matcherField,
      handlerField,
      entriesSchema: isRecord(fieldSchema) ? fieldSchema : null,
      matcherSchema,
    };
  }

  return {
    entriesField: null,
    matcherField: null,
    handlerField: null,
    entriesSchema: null,
    matcherSchema: null,
  };
}

function buildDefaultMatcher(schema: Record<string, unknown> | null): Record<string, unknown> {
  if (!schema || !isRecord(schema.properties)) return {};

  const result: Record<string, unknown> = {};
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const requiredSet = new Set(
    required.filter((value): value is string => typeof value === "string"),
  );

  for (const [field, descriptor] of Object.entries(schema.properties)) {
    if (!requiredSet.has(field)) continue;
    if (!isRecord(descriptor)) continue;

    if (descriptor.default !== undefined) {
      result[field] = descriptor.default;
      continue;
    }

    if (Array.isArray(descriptor.enum) && descriptor.enum.length > 0) {
      result[field] = descriptor.enum[0];
      continue;
    }

    if (descriptor.type === "string") {
      result[field] = field.toLowerCase().includes("path") ? "/" : "";
      continue;
    }

    if (descriptor.type === "boolean") {
      result[field] = false;
      continue;
    }

    if (descriptor.type === "number" || descriptor.type === "integer") {
      result[field] = 0;
      continue;
    }
  }

  return result;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "…";
}

function summarizeObject(value: Record<string, unknown>): string {
  const pairs = Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 4)
    .map(([key, item]) => `${key}: ${String(item)}`);

  if (pairs.length > 0) return pairs.join("  ·  ");

  const keys = Object.keys(value);
  if (keys.length === 0) return "Empty object";
  return `${keys.length} field${keys.length === 1 ? "" : "s"}`;
}

function summarizeMatcher(value: unknown): string {
  if (typeof value === "string") return value || "—";
  if (isRecord(value)) return summarizeObject(value);
  return formatScalar(value);
}

function summarizeHandler(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return formatScalar(value);

  const name = typeof value.name === "string" ? value.name : null;
  const kind = typeof value.kind === "string" ? value.kind : null;

  if (name && kind) return `${kind} · ${name}`;
  if (name) return name;
  if (kind) return kind;
  return summarizeObject(value);
}

function summarizeRoute(entry: unknown): string {
  if (!isRecord(entry)) return "Invalid route entry";
  return summarizeObject(entry);
}

export function RouterTopologyCanvas({
  resource,
  schema,
  onUpdateResource,
  onSelect,
  onBackgroundClick,
}: RouterTopologyCanvasProps) {
  const schemaInfo = useMemo(() => getRouterSchemaInfo(schema), [schema]);
  const entries = useMemo(() => {
    if (!schemaInfo.entriesField) return [];
    const value = resource.fields[schemaInfo.entriesField];
    return Array.isArray(value) ? value : [];
  }, [resource.fields, schemaInfo.entriesField]);

  function handleAddRoute() {
    if (!schemaInfo.entriesField) return;

    const nextFields = { ...resource.fields };
    const existingEntries = nextFields[schemaInfo.entriesField];
    const current = Array.isArray(existingEntries) ? [...existingEntries] : [];

    const nextEntry: Record<string, unknown> = {};
    if (schemaInfo.matcherField) {
      nextEntry[schemaInfo.matcherField] = buildDefaultMatcher(schemaInfo.matcherSchema);
    }

    current.push(nextEntry);
    nextFields[schemaInfo.entriesField] = current;
    onUpdateResource(resource.kind, resource.name, nextFields);
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">
              Router Topology
            </p>
            <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {resource.name}
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{resource.kind}</p>
          </div>
          <div className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
            {entries.length} route{entries.length === 1 ? "" : "s"}
          </div>
          {schemaInfo.entriesField && (
            <Button
              variant="outline"
              size="sm"
              className="border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200 dark:hover:bg-amber-900/60"
              onClick={handleAddRoute}
            >
              + Add route
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-5" onClick={onBackgroundClick}>
        {!schemaInfo.entriesField ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            Router schema is missing an entries field annotated with x-telo-topology-role: entries.
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            No routes defined yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="grid grid-cols-[minmax(12rem,1.6fr)_minmax(12rem,1.2fr)_7rem] gap-4 border-b border-zinc-200 bg-zinc-100 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <span>Matcher</span>
              <span>Handler</span>
              <span>Entry</span>
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {entries.map((entry, index) => {
                const record = isRecord(entry) ? entry : null;
                const matcher =
                  record && schemaInfo.matcherField ? record[schemaInfo.matcherField] : undefined;
                const handler =
                  record && schemaInfo.handlerField ? record[schemaInfo.handlerField] : undefined;
                const matcherDetails =
                  record && schemaInfo.matcherField && isRecord(record[schemaInfo.matcherField])
                    ? Object.keys(record[schemaInfo.matcherField] as Record<string, unknown>).join(
                        ", ",
                      )
                    : null;

                return (
                  <div
                    key={index}
                    className="grid grid-cols-[minmax(12rem,1.6fr)_minmax(12rem,1.2fr)_7rem] gap-4 px-4 py-3 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900/70"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="min-w-0">
                      {schemaInfo.matcherField && schemaInfo.matcherSchema ? (
                        <button
                          className="truncate font-medium text-zinc-900 underline decoration-dotted underline-offset-2 hover:text-amber-700 dark:text-zinc-100 dark:hover:text-amber-300"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              !schemaInfo.entriesField ||
                              !schemaInfo.matcherField ||
                              !schemaInfo.matcherSchema
                            ) {
                              return;
                            }

                            onSelect({
                              resource: { kind: resource.kind, name: resource.name },
                              pointer: `/${schemaInfo.entriesField}/${index}/${schemaInfo.matcherField}`,
                              schema: schemaInfo.matcherSchema,
                            });
                          }}
                        >
                          {summarizeMatcher(matcher)}
                        </button>
                      ) : (
                        <div className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                          {schemaInfo.matcherField
                            ? summarizeMatcher(matcher)
                            : summarizeRoute(entry)}
                        </div>
                      )}
                      {matcherDetails && (
                        <div className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {matcherDetails}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 truncate text-zinc-600 dark:text-zinc-300">
                      {schemaInfo.handlerField ? summarizeHandler(handler) : "—"}
                    </div>
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      #{index + 1}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
