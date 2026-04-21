import { ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Selection, ParsedResource } from "../../../model";
import { summarizeResource } from "../../../diagnostics-aggregate";
import { getTopologyRole } from "../../../schema-utils";
import { isRecord } from "../../../lib/utils";
import { DiagnosticBadge } from "../../diagnostics/DiagnosticBadge";
import {
  useActiveFilePaths,
  useDiagnosticsState,
} from "../../diagnostics/DiagnosticsContext";
import { Button } from "../../ui/button";

interface RouterTopologyCanvasProps {
  resource: ParsedResource;
  schema: Record<string, unknown>;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelect: (selection: Selection) => void;
  onBackgroundClick: () => void;
}

interface OutcomeListField {
  fieldName: string;
  label: string;
  itemSchema: Record<string, unknown> | null;
}

interface RouterSchemaInfo {
  entriesField: string | null;
  matcherField: string | null;
  handlerField: string | null;
  entriesSchema: Record<string, unknown> | null;
  matcherSchema: Record<string, unknown> | null;
  entryItemSchema: Record<string, unknown> | null;
  outcomeLists: OutcomeListField[];
}

function getOutcomeListFields(
  entryItemSchema: Record<string, unknown> | null,
): OutcomeListField[] {
  if (!entryItemSchema || !isRecord(entryItemSchema.properties)) return [];
  const result: OutcomeListField[] = [];
  for (const [name, prop] of Object.entries(entryItemSchema.properties)) {
    if (!isRecord(prop)) continue;
    if (typeof prop["x-telo-outcome-list"] !== "string") continue;
    if (prop.type !== "array") continue;
    const items = isRecord(prop.items) ? prop.items : null;
    result.push({
      fieldName: name,
      label: typeof prop.title === "string" ? prop.title : name,
      itemSchema: items,
    });
  }
  return result;
}

function getRouterSchemaInfo(schema: Record<string, unknown>): RouterSchemaInfo {
  const empty: RouterSchemaInfo = {
    entriesField: null,
    matcherField: null,
    handlerField: null,
    entriesSchema: null,
    matcherSchema: null,
    entryItemSchema: null,
    outcomeLists: [],
  };
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return empty;

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (getTopologyRole(fieldSchema) !== "entries" || !isRecord(fieldSchema)) continue;

    const items = isRecord(fieldSchema.items) ? fieldSchema.items : null;
    const itemProperties = items && isRecord(items.properties) ? items.properties : null;
    if (!itemProperties) {
      return {
        ...empty,
        entriesField: fieldName,
        entriesSchema: isRecord(fieldSchema) ? fieldSchema : null,
        entryItemSchema: items,
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
      entryItemSchema: items,
      outcomeLists: getOutcomeListFields(items),
    };
  }

  return empty;
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

function summarizeOutcomeEntry(entry: unknown): string {
  if (!isRecord(entry)) return formatScalar(entry);
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
  const diagState = useDiagnosticsState();
  const filePaths = useActiveFilePaths();
  const routerSummary = summarizeResource(diagState, filePaths, resource.name);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  function toggleExpanded(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

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

  function handleDeleteRoute(index: number) {
    if (!schemaInfo.entriesField) return;

    const nextFields = { ...resource.fields };
    const existingEntries = nextFields[schemaInfo.entriesField];
    const current = Array.isArray(existingEntries) ? [...existingEntries] : [];
    current.splice(index, 1);
    nextFields[schemaInfo.entriesField] = current;
    onUpdateResource(resource.kind, resource.name, nextFields);
    setExpanded((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }

  function handleAddOutcome(routeIndex: number, outcome: OutcomeListField) {
    if (!schemaInfo.entriesField) return;

    const nextFields = { ...resource.fields };
    const existingEntries = nextFields[schemaInfo.entriesField];
    const routes = Array.isArray(existingEntries) ? [...existingEntries] : [];
    const route = isRecord(routes[routeIndex]) ? { ...routes[routeIndex] } : {};
    const currentList = Array.isArray(route[outcome.fieldName])
      ? [...(route[outcome.fieldName] as unknown[])]
      : [];
    currentList.push(buildDefaultMatcher(outcome.itemSchema));
    route[outcome.fieldName] = currentList;
    routes[routeIndex] = route;
    nextFields[schemaInfo.entriesField] = routes;
    onUpdateResource(resource.kind, resource.name, nextFields);
    setExpanded((prev) => new Set(prev).add(routeIndex));
  }

  function selectOutcome(routeIndex: number, outcome: OutcomeListField, itemIndex: number) {
    if (!schemaInfo.entriesField || !outcome.itemSchema) return;
    onSelect({
      resource: { kind: resource.kind, name: resource.name },
      pointer: `/${schemaInfo.entriesField}/${routeIndex}/${outcome.fieldName}/${itemIndex}`,
      schema: outcome.itemSchema,
    });
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">
              Router Topology
            </p>
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                {resource.name}
              </h2>
              <DiagnosticBadge summary={routerSummary} size="md" stopPropagation={false} />
            </div>
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
            <div className="grid grid-cols-[1.5rem_minmax(12rem,1.6fr)_minmax(12rem,1.2fr)_2rem] gap-4 border-b border-zinc-200 bg-zinc-100 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <span />
              <span>Matcher</span>
              <span>Handler</span>
              <span />
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
                const isExpanded = expanded.has(index);
                const hasOutcomes = schemaInfo.outcomeLists.length > 0;

                return (
                  <div key={index} onClick={(event) => event.stopPropagation()}>
                    <div className="grid grid-cols-[1.5rem_minmax(12rem,1.6fr)_minmax(12rem,1.2fr)_2rem] gap-4 px-4 py-3 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900/70">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={isExpanded ? "Collapse route" : "Expand route"}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(index);
                        }}
                        disabled={!hasOutcomes}
                        className="self-center text-zinc-400 hover:text-amber-700 dark:text-zinc-500 dark:hover:text-amber-300"
                      >
                        {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                      </Button>
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
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Delete route"
                        title="Delete route"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteRoute(index);
                        }}
                        className="self-center text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    {isExpanded && hasOutcomes && (
                      <div className="space-y-2 bg-zinc-50 px-10 py-3 dark:bg-zinc-900/40">
                        {schemaInfo.outcomeLists.map((outcome) => {
                          const list = record && Array.isArray(record[outcome.fieldName])
                            ? (record[outcome.fieldName] as unknown[])
                            : [];
                          return (
                            <div
                              key={outcome.fieldName}
                              className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
                            >
                              <div className="flex items-center justify-between px-3 py-1.5">
                                <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                  {outcome.label}
                                  <span className="ml-2 font-normal normal-case text-zinc-400 dark:text-zinc-500">
                                    {list.length} item{list.length === 1 ? "" : "s"}
                                  </span>
                                </span>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => handleAddOutcome(index, outcome)}
                                >
                                  + Add
                                </Button>
                              </div>
                              {list.length > 0 && (
                                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                                  {list.map((item, itemIndex) => (
                                    <li key={itemIndex}>
                                      <Button
                                        variant="ghost"
                                        className="h-auto w-full justify-start gap-3 rounded-none px-3 py-2 text-left text-sm font-normal"
                                        onClick={() => selectOutcome(index, outcome, itemIndex)}
                                      >
                                        <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                                          #{itemIndex + 1}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">
                                          {summarizeOutcomeEntry(item)}
                                        </span>
                                      </Button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
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
