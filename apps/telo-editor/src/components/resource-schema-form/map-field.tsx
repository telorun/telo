import { useEffect, useMemo, useRef, useState } from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { TrashIcon } from "lucide-react";
import { isRecord, shallowEqualObject } from "../../lib/utils";
import type { CelEvalMode } from "./cel-utils";
import { buildEditorDefaultValue } from "./default-value";
import { FieldControl } from "./field-control";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

interface MapFieldProps {
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
  label?: string;
  required?: boolean;
}

interface Row {
  id: string;
  key: string;
  value: unknown;
}

type RowError = "empty" | "duplicate" | "pattern" | null;

function isPlainSchema(value: unknown): value is JsonSchemaProperty {
  return isRecord(value);
}

export function MapField({
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
}: MapFieldProps) {
  const valueSchema: JsonSchemaProperty = isPlainSchema(prop.additionalProperties)
    ? prop.additionalProperties
    : {};
  const keyPattern = prop.propertyNames?.pattern;
  const keyRegex = useMemo(() => {
    if (typeof keyPattern !== "string" || keyPattern.length === 0) return null;
    try {
      return new RegExp(keyPattern);
    } catch {
      return null;
    }
  }, [keyPattern]);

  const counterRef = useRef(0);
  const newId = (): string => `r${++counterRef.current}`;

  const deriveRows = (source: unknown): Row[] => {
    if (!isRecord(source)) return [];
    return Object.entries(source).map(([key, value]) => ({ id: newId(), key, value }));
  };

  const [rows, setRows] = useState<Row[]>(() => deriveRows(value));

  const lastEmittedRef = useRef<unknown>(value);
  useEffect(() => {
    if (!shallowEqualObject(value, lastEmittedRef.current)) {
      setRows(deriveRows(value));
      lastEmittedRef.current = value;
    }
    // newId / deriveRows are stable closures over counterRef; only `value`
    // identity matters for resync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const rowErrors = useMemo<Record<string, RowError>>(() => {
    const errors: Record<string, RowError> = {};
    const seenKey = new Map<string, string>();
    for (const row of rows) {
      if (row.key === "") {
        errors[row.id] = "empty";
        continue;
      }
      const firstId = seenKey.get(row.key);
      if (firstId !== undefined) {
        errors[row.id] = "duplicate";
        continue;
      }
      seenKey.set(row.key, row.id);
      if (keyRegex && !keyRegex.test(row.key)) {
        errors[row.id] = "pattern";
        continue;
      }
      errors[row.id] = null;
    }
    return errors;
  }, [rows, keyRegex]);

  const hasErrors = useMemo(
    () => Object.values(rowErrors).some((err) => err !== null),
    [rowErrors],
  );

  // Cleanup contract: every `true` reported via `onErrorChange` MUST be paired
  // with a `false` on transition, fieldPath change, and unmount. The aggregator
  // in `ResourceSchemaForm` is keyed by `fieldPath`; a leaked `true` latches
  // `hasFormErrors` and silently freezes saves.
  const lastReportedRef = useRef(false);
  const lastPathRef = useRef(fieldPath);
  useEffect(() => {
    if (lastPathRef.current !== fieldPath) {
      onErrorChange?.(lastPathRef.current, false);
      lastPathRef.current = fieldPath;
      lastReportedRef.current = false;
    }
    if (lastReportedRef.current !== hasErrors) {
      onErrorChange?.(fieldPath, hasErrors);
      lastReportedRef.current = hasErrors;
    }
  }, [fieldPath, hasErrors, onErrorChange]);

  useEffect(() => {
    return () => {
      if (lastReportedRef.current) {
        onErrorChange?.(lastPathRef.current, false);
      }
    };
    // Intentional: emit `false` on unmount only, with the latest path/state
    // captured via refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function emitFromRows(nextRows: Row[]) {
    const next: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const row of nextRows) {
      if (row.key === "") continue;
      if (seen.has(row.key)) continue;
      if (keyRegex && !keyRegex.test(row.key)) continue;
      next[row.key] = row.value;
      seen.add(row.key);
    }
    lastEmittedRef.current = next;
    onValueChange(next);
  }

  function handleAdd() {
    const nextRows: Row[] = [
      ...rows,
      { id: newId(), key: "", value: buildEditorDefaultValue(valueSchema, resolvedResources) },
    ];
    setRows(nextRows);
    // No emit — empty key is invalid, so the row exists in UI only until the
    // user types a committable key.
  }

  function handleRemove(id: string) {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    emitFromRows(nextRows);
  }

  function handleRename(id: string, nextKey: string) {
    const nextRows = rows.map((row) => (row.id === id ? { ...row, key: nextKey } : row));
    setRows(nextRows);
    emitFromRows(nextRows);
  }

  function handleValueChange(id: string, nextValue: unknown) {
    const nextRows = rows.map((row) => (row.id === id ? { ...row, value: nextValue } : row));
    setRows(nextRows);
    emitFromRows(nextRows);
  }

  function handleClear() {
    setRows([]);
    lastEmittedRef.current = undefined;
    onValueChange(undefined);
  }

  const triggerTitle =
    (typeof prop.title === "string" ? prop.title : undefined) ?? label ?? "map";
  const description = typeof prop.description === "string" ? prop.description : undefined;
  const canClear = !required && rows.length > 0;
  const entryCount = rows.length;

  return (
    <CollapsiblePrimitive.Root
      defaultOpen={entryCount === 0}
      className="group rounded border border-zinc-200 dark:border-zinc-800"
    >
      <div className="flex items-stretch">
        <CollapsiblePrimitive.Trigger className="flex flex-1 items-center gap-2 px-2 py-1 text-left text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60">
          <span
            aria-hidden="true"
            className="w-3 text-zinc-500 group-data-[state=open]:hidden dark:text-zinc-500"
          >
            ▸
          </span>
          <span
            aria-hidden="true"
            className="hidden w-3 text-zinc-500 group-data-[state=open]:inline dark:text-zinc-500"
          >
            ▾
          </span>
          <span>{triggerTitle}</span>
          {description && (
            <span className="truncate text-xs font-normal text-zinc-400 dark:text-zinc-500">
              — {description}
            </span>
          )}
          <span className="ml-auto text-xs font-normal text-zinc-400 dark:text-zinc-500">
            {entryCount} entr{entryCount === 1 ? "y" : "ies"}
          </span>
        </CollapsiblePrimitive.Trigger>
        {canClear && (
          <button
            type="button"
            onClick={handleClear}
            onBlur={() => onFieldBlur?.(rootFieldName)}
            className="px-2 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
            title="Clear all entries"
          >
            Clear
          </button>
        )}
      </div>
      <CollapsiblePrimitive.Content className="flex flex-col gap-2 border-t border-zinc-200 p-2 dark:border-zinc-800">
        {rows.map((row) => {
          const err = rowErrors[row.id] ?? null;
          const errorMessage =
            err === "empty"
              ? "Key cannot be empty"
              : err === "duplicate"
                ? "Duplicate key"
                : err === "pattern"
                  ? `Key must match pattern ${keyPattern}`
                  : undefined;
          const keyInputClass = `w-full rounded border bg-white px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 ${
            err
              ? "border-red-500 dark:border-red-500"
              : "border-zinc-300 dark:border-zinc-700"
          }`;
          const errorId = errorMessage ? `${fieldPath}-${row.id}-error` : undefined;
          return (
            <div
              key={row.id}
              className="flex items-start gap-2 rounded border border-zinc-100 p-2 dark:border-zinc-800/60"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => handleRename(row.id, e.target.value)}
                  onBlur={() => onFieldBlur?.(rootFieldName)}
                  className={keyInputClass}
                  placeholder="key"
                  title={errorMessage}
                  aria-invalid={err !== null}
                  aria-describedby={errorId}
                />
                {errorMessage && (
                  <p
                    id={errorId}
                    role="alert"
                    className="text-xs text-red-500 dark:text-red-400"
                  >
                    {errorMessage}
                  </p>
                )}
              </div>
              <div className="flex-[2] min-w-0">
                <FieldControl
                  rootFieldName={rootFieldName}
                  fieldPath={`${fieldPath}.${row.id}`}
                  prop={valueSchema}
                  value={row.value}
                  onValueChange={(next) => handleValueChange(row.id, next)}
                  onFieldBlur={onFieldBlur}
                  onErrorChange={onErrorChange}
                  resolvedResources={resolvedResources}
                  rootCelEval={rootCelEval}
                  onSelectResource={onSelectResource}
                />
              </div>
              <button
                type="button"
                onClick={() => handleRemove(row.id)}
                onBlur={() => onFieldBlur?.(rootFieldName)}
                className="shrink-0 rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                title="Remove entry"
                aria-label="Remove entry"
              >
                <TrashIcon className="size-3" />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleAdd}
          onBlur={() => onFieldBlur?.(rootFieldName)}
          className="self-start rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          + Add entry
        </button>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
