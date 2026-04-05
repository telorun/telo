import { useEffect, useMemo, useState } from "react";
import type { MatcherSelection, ParsedManifest } from "../model";
import { ResourceSchemaForm } from "./ResourceSchemaForm";

interface DetailPanelProps {
  selectedResource: { kind: string; name: string } | null;
  matcherSelection: MatcherSelection | null;
  onClearMatcherSelection: () => void;
  activeManifest: ParsedManifest | null;
  schemaByKind: Record<string, Record<string, unknown>>;
  onUpdateResource: (kind: string, name: string, fields: Record<string, unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFields(values: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    next[key] = value;
  }
  return next;
}

export function DetailPanel({
  selectedResource,
  matcherSelection,
  onClearMatcherSelection,
  activeManifest,
  schemaByKind,
  onUpdateResource,
}: DetailPanelProps) {
  const resource = useMemo(() => {
    if (!selectedResource || !activeManifest) return null;
    return (
      activeManifest.resources.find(
        (r) => r.kind === selectedResource.kind && r.name === selectedResource.name,
      ) ?? null
    );
  }, [selectedResource, activeManifest]);

  const matcherContext = useMemo(() => {
    if (!resource || !matcherSelection) return null;
    if (
      matcherSelection.resource.kind !== resource.kind ||
      matcherSelection.resource.name !== resource.name
    ) {
      return null;
    }

    const entries = resource.fields[matcherSelection.entriesField];
    if (!Array.isArray(entries)) return null;

    const entry = entries[matcherSelection.entryIndex];
    if (!isRecord(entry)) return null;

    const matcher = entry[matcherSelection.matcherField];
    return {
      ...matcherSelection,
      values: isRecord(matcher) ? matcher : {},
    };
  }, [resource, matcherSelection]);

  const schema = matcherContext
    ? matcherContext.matcherSchema
    : resource
      ? schemaByKind[resource.kind]
      : undefined;
  const required = useMemo(
    () => new Set(((schema as { required?: string[] } | undefined)?.required ?? []) as string[]),
    [schema],
  );
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [hasParseErrors, setHasParseErrors] = useState(false);

  useEffect(() => {
    if (matcherContext) {
      setFields(matcherContext.values);
    } else {
      setFields(resource?.fields ?? {});
    }
    setError(null);
    setHasParseErrors(false);
  }, [resource, matcherContext]);

  function validate(values: Record<string, unknown>): string | null {
    for (const req of required) {
      const value = values[req];
      if (value === undefined || value === null || value === "") {
        return `Required field missing: ${req}`;
      }
    }
    return null;
  }

  function apply(values: Record<string, unknown>) {
    if (!resource) return;
    const validationError = validate(values);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (hasParseErrors) {
      setError("Fix invalid JSON before applying changes");
      return;
    }
    setError(null);

    if (matcherContext) {
      const existingEntries = resource.fields[matcherContext.entriesField];
      if (!Array.isArray(existingEntries)) return;

      const nextEntries = [...existingEntries];
      const currentEntry = nextEntries[matcherContext.entryIndex];
      if (!isRecord(currentEntry)) return;

      nextEntries[matcherContext.entryIndex] = {
        ...currentEntry,
        [matcherContext.matcherField]: sanitizeFields(values),
      };

      onUpdateResource(resource.kind, resource.name, {
        ...resource.fields,
        [matcherContext.entriesField]: nextEntries,
      });
      return;
    }

    onUpdateResource(resource.kind, resource.name, sanitizeFields(values));
  }

  function handleFieldBlur() {
    apply(fields);
  }

  function handleReset() {
    if (matcherContext) {
      setFields(matcherContext.values);
    } else {
      setFields(resource?.fields ?? {});
    }
    setError(null);
  }

  if (!resource) return null;

  return (
    <div className="flex h-full w-80 flex-col overflow-hidden border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-100 px-4 dark:border-zinc-800">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200">
            {matcherContext
              ? `${resource.name} • matcher #${matcherContext.entryIndex + 1}`
              : resource.name}
          </span>
          <span className="shrink-0 rounded bg-zinc-100 px-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {resource.kind}
          </span>
        </div>
        {matcherContext && (
          <button
            onClick={onClearMatcherSelection}
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Back
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!schema ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-600">
            No definition schema found for this resource kind.
          </p>
        ) : (
          <ResourceSchemaForm
            schema={schema}
            values={fields}
            onChange={(next) => {
              setFields(next);
              const validationError = validate(next);
              if (!validationError) setError(null);
            }}
            onFieldBlur={handleFieldBlur}
            onParseStateChange={setHasParseErrors}
          />
        )}
        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <button
          onClick={handleReset}
          className="rounded px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
