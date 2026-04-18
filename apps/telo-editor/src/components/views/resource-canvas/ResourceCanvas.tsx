import { Fragment, useEffect, useMemo, useState } from "react";
import type { ParsedResource } from "../../../model";
import {
  FieldControl,
  inferType,
  willRenderAsObjectField,
} from "../../resource-schema-form/field-control";
import {
  inferRefMode,
  parseRefValue,
  resolveRefCandidates,
  toRefString,
  toRefValue,
} from "../../resource-schema-form/ref-candidates";
import type { JsonSchemaProperty, ResolvedResourceOption } from "../../resource-schema-form/types";
import { Button } from "../../ui/button";
import type { BindingDescriptor } from "./bindings";
import { discoverBindings } from "./bindings";

interface ResourceCanvasProps {
  resource: ParsedResource;
  schema: Record<string, unknown>;
  resolvedResources: ResolvedResourceOption[];
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
  onSelectResource: (kind: string, name: string) => void;
  onBackgroundClick: () => void;
  /** When true, skip the resource header row — the embedding container already
   *  shows the resource's identity (e.g. `DetailPanel` in peek mode). */
  hideHeader?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setByPath(
  root: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const next = { ...root };
    if (value === undefined || value === null || value === "") delete next[head];
    else next[head] = value;
    return next;
  }
  const child = isRecord(root[head]) ? (root[head] as Record<string, unknown>) : {};
  return { ...root, [head]: setByPath(child, rest, value) };
}

function getByPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const seg of path) {
    if (!isRecord(current)) return undefined;
    current = current[seg];
  }
  return current;
}

/** Walks the schema to find the property at the given path so we can infer its
 *  ref-mode (string vs object form). */
function propAtPath(
  schema: Record<string, unknown>,
  path: string[],
): JsonSchemaProperty | undefined {
  let properties = isRecord(schema.properties) ? schema.properties : null;
  let current: JsonSchemaProperty | undefined;
  for (const seg of path) {
    if (!properties) return undefined;
    const next = properties[seg];
    if (!isRecord(next)) return undefined;
    current = next as JsonSchemaProperty;
    properties = isRecord(next.properties) ? (next.properties as Record<string, unknown>) : null;
  }
  return current;
}

export function ResourceCanvas({
  resource,
  schema,
  resolvedResources,
  onUpdateResource,
  onSelectResource,
  onBackgroundClick,
  hideHeader = false,
}: ResourceCanvasProps) {
  const [fields, setFields] = useState<Record<string, unknown>>(resource.fields);

  useEffect(() => {
    setFields(resource.fields);
  }, [resource]);

  const properties = useMemo(() => {
    const raw = isRecord(schema.properties) ? schema.properties : {};
    return Object.entries(raw).map(([name, prop]) => ({
      name,
      prop: prop as JsonSchemaProperty,
    }));
  }, [schema]);

  const required = useMemo(() => {
    const req = (schema as { required?: unknown }).required;
    return new Set(
      Array.isArray(req) ? req.filter((x): x is string => typeof x === "string") : [],
    );
  }, [schema]);

  const bindings = useMemo(() => discoverBindings(schema), [schema]);
  const bindingByTop = useMemo(() => {
    const map = new Map<string, BindingDescriptor>();
    for (const b of bindings) map.set(b.topFieldName, b);
    return map;
  }, [bindings]);

  function persist(next: Record<string, unknown>) {
    onUpdateResource(resource.kind, resource.name, next);
  }

  function handleFieldBlur() {
    persist(fields);
  }

  function setTopField(name: string, value: unknown) {
    setFields((prev) => ({ ...prev, [name]: value }));
  }

  function commitAt(path: string[], value: unknown) {
    const next = setByPath(fields, path, value);
    setFields(next);
    persist(next);
  }

  function renderArrayOfRefsBinding(descriptor: BindingDescriptor) {
    const candidates = resolveRefCandidates(descriptor.refCapabilities, resolvedResources);
    const current = getByPath(fields, descriptor.fieldPath);
    const entries = Array.isArray(current) ? current : [];
    // Items schema used for ref-mode inference
    const arrayProp = propAtPath(schema, descriptor.fieldPath);
    const itemProp = (arrayProp?.items as JsonSchemaProperty | undefined) ?? undefined;
    const mode = inferRefMode(itemProp);

    return (
      <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap gap-2">
          {entries.map((entry, index) => {
            const parsed = parseRefValue(entry);
            return (
              <div
                key={index}
                className="flex items-center gap-1 rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                {parsed ? (
                  <button
                    type="button"
                    className="text-zinc-800 hover:text-amber-700 dark:text-zinc-100 dark:hover:text-amber-300"
                    onClick={() => onSelectResource(parsed.kind, parsed.name)}
                  >
                    {parsed.kind}:{parsed.name}
                  </button>
                ) : (
                  <span className="text-zinc-500">(invalid)</span>
                )}
                <button
                  type="button"
                  className="ml-1 text-red-500 hover:text-red-700"
                  onClick={() => commitAt(descriptor.fieldPath, entries.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            );
          })}
          {entries.length === 0 && (
            <span className="text-xs text-zinc-400 dark:text-zinc-600">No entries.</span>
          )}
        </div>
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const option = candidates.find((c) => toRefString(c) === v);
            if (!option) return;
            commitAt(descriptor.fieldPath, [...entries, toRefValue(option, mode)]);
          }}
          disabled={candidates.length === 0}
          className="self-start rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:disabled:bg-zinc-800"
        >
          <option value="">{candidates.length === 0 ? "(no candidates)" : "+ Add…"}</option>
          {candidates.map((c) => (
            <option key={toRefString(c)} value={toRefString(c)}>
              {c.kind}:{c.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  function renderArrayOfObjectsBinding(descriptor: BindingDescriptor) {
    const refFieldName = descriptor.refFieldName;
    if (!refFieldName) return null;
    const candidates = resolveRefCandidates(descriptor.refCapabilities, resolvedResources);
    const current = getByPath(fields, descriptor.fieldPath);
    const entries = Array.isArray(current) ? current : [];
    const keyFieldName = descriptor.keyFieldName;

    const arrayProp = propAtPath(schema, descriptor.fieldPath);
    const itemProp = (arrayProp?.items as JsonSchemaProperty | undefined) ?? undefined;
    const refSubProp =
      itemProp && isRecord(itemProp.properties)
        ? ((itemProp.properties as Record<string, unknown>)[refFieldName] as
            | JsonSchemaProperty
            | undefined)
        : undefined;
    const mode = inferRefMode(refSubProp);

    function updateEntry(index: number, patch: Record<string, unknown>) {
      const next = entries.map((entry, i) => {
        if (i !== index) return entry;
        const obj = isRecord(entry) ? entry : {};
        const merged = { ...obj, ...patch };
        return merged;
      });
      commitAt(descriptor.fieldPath, next);
    }

    function removeEntry(index: number) {
      commitAt(
        descriptor.fieldPath,
        entries.filter((_, i) => i !== index),
      );
    }

    function addEntry() {
      const first = candidates[0];
      const entry: Record<string, unknown> = {};
      if (first) entry[refFieldName] = toRefValue(first, mode);
      commitAt(descriptor.fieldPath, [...entries, entry]);
    }

    return (
      <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        {entries.map((entry, index) => {
          const record = isRecord(entry) ? entry : {};
          const keyValue = keyFieldName ? record[keyFieldName] : undefined;
          const refValue = record[refFieldName];
          const parsed = parseRefValue(refValue);

          return (
            <div
              key={index}
              className="flex items-center gap-2 rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              {keyFieldName && (
                <input
                  type="text"
                  value={typeof keyValue === "string" ? keyValue : ""}
                  onChange={(e) => updateEntry(index, { [keyFieldName]: e.target.value })}
                  placeholder={keyFieldName}
                  className="w-28 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                />
              )}
              <select
                value={parsed ? toRefString(parsed) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    updateEntry(index, { [refFieldName]: undefined });
                    return;
                  }
                  const option = candidates.find((c) => toRefString(c) === v);
                  if (!option) return;
                  updateEntry(index, { [refFieldName]: toRefValue(option, mode) });
                }}
                disabled={candidates.length === 0}
                className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 dark:disabled:bg-zinc-800"
              >
                <option value="">
                  {candidates.length === 0 ? "(no candidates)" : "(select)"}
                </option>
                {candidates.map((c) => (
                  <option key={toRefString(c)} value={toRefString(c)}>
                    {c.kind}:{c.name}
                  </option>
                ))}
              </select>
              {parsed && (
                <button
                  type="button"
                  onClick={() => onSelectResource(parsed.kind, parsed.name)}
                  className="rounded px-1 text-zinc-500 hover:text-amber-700 dark:hover:text-amber-300"
                  title="Peek in side panel"
                >
                  ↗
                </button>
              )}
              <button
                type="button"
                onClick={() => removeEntry(index)}
                className="rounded px-1 text-red-500 hover:text-red-700"
              >
                ×
              </button>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={addEntry}
          disabled={candidates.length === 0}
        >
          {candidates.length === 0 ? "(no candidates)" : "+ Add"}
        </Button>
      </div>
    );
  }

  function renderBinding(descriptor: BindingDescriptor) {
    if (descriptor.shape === "array-of-refs") return renderArrayOfRefsBinding(descriptor);
    if (descriptor.shape === "array-of-objects") return renderArrayOfObjectsBinding(descriptor);
    return null;
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
      {!hideHeader && (
        <div className="border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
              Resource
            </p>
            <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {resource.name}
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{resource.kind}</p>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5" onClick={onBackgroundClick}>
        <div
          className={`grid items-start gap-x-6 gap-y-5 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 ${
            hideHeader
              ? "grid-cols-1"
              : "grid-cols-[minmax(18rem,1fr)_minmax(18rem,1fr)]"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {properties.length === 0 && (
            <div className="col-span-full text-xs text-zinc-400 dark:text-zinc-600">
              No schema fields.
            </div>
          )}
          {properties.map(({ name, prop }, index) => {
            const kind = inferType(prop);
            const binding = bindingByTop.get(name);
            const hideFormControl = !!binding?.complete;
            const nextBinding =
              index + 1 < properties.length
                ? bindingByTop.get(properties[index + 1].name)
                : undefined;
            const showTopDivider = !!binding;
            const showBottomDivider = !!binding && !nextBinding;
            const divider = (
              <div
                className="col-span-full border-t border-zinc-200 dark:border-zinc-800"
                aria-hidden="true"
              />
            );
            const labelText = typeof prop.title === "string" ? prop.title : name;
            const fieldOwnsLabel = willRenderAsObjectField(prop);
            const label =
              fieldOwnsLabel ? null : (
                <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {labelText}
                  {required.has(name) ? <span className="ml-1 text-red-500">*</span> : null}
                  <span className="ml-1 text-zinc-400 dark:text-zinc-600">({kind})</span>
                </label>
              );
            const description =
              typeof prop.description === "string" ? (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">{prop.description}</span>
              ) : null;

            const formControl = (
              <FieldControl
                rootFieldName={name}
                fieldPath={name}
                prop={prop}
                value={fields[name]}
                onValueChange={(next) => setTopField(name, next)}
                onFieldBlur={handleFieldBlur}
                resolvedResources={resolvedResources}
                onSelectResource={onSelectResource}
                label={labelText}
              />
            );

            if (fieldOwnsLabel) {
              // Object fields own their collapsible header — render full-width
              // in both full and peek layouts so the collapsible card spans
              // the whole grid row.
              return (
                <Fragment key={name}>
                  {showTopDivider && divider}
                  <div className="col-span-full flex flex-col gap-1">
                    {formControl}
                    {description}
                  </div>
                  {showBottomDivider && divider}
                </Fragment>
              );
            }

            if (hideHeader) {
              return (
                <Fragment key={name}>
                  {showTopDivider && divider}
                  <div className="flex flex-col gap-1">
                    {label}
                    {binding && renderBinding(binding)}
                    {!hideFormControl && formControl}
                    {description}
                  </div>
                  {showBottomDivider && divider}
                </Fragment>
              );
            }

            return (
              <Fragment key={name}>
                {showTopDivider && divider}
                <div className="flex flex-col gap-1">
                  {label}
                  {!hideFormControl && formControl}
                  {description}
                </div>
                <div className="flex min-h-8 flex-col gap-1">
                  {binding ? renderBinding(binding) : null}
                </div>
                {showBottomDivider && divider}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
