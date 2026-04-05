import { useEffect, useMemo, useState } from "react";

type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  oneOf?: Array<{ type?: string }>;
};

type JsonSchema = {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

interface ResourceSchemaFormProps {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  onFieldBlur?: (name: string) => void;
  onParseStateChange?: (hasErrors: boolean) => void;
}

function inferType(prop: JsonSchemaProperty): string {
  if (prop.type) return prop.type;
  const oneOfTypes = (prop.oneOf ?? []).map((x) => x.type).filter(Boolean);
  if (oneOfTypes.length === 1) return oneOfTypes[0] as string;
  return "string";
}

function toJsonText(value: unknown, fallback: unknown): string {
  const input = value ?? fallback;
  if (input === undefined) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "";
  }
}

export function ResourceSchemaForm({
  schema,
  values,
  onChange,
  onFieldBlur,
  onParseStateChange,
}: ResourceSchemaFormProps) {
  const typedSchema = schema as JsonSchema;
  const properties = useMemo(() => typedSchema.properties ?? {}, [typedSchema.properties]);
  const required = new Set(typedSchema.required ?? []);

  const fields = useMemo(
    () => Object.entries(properties).map(([name, prop]) => ({ name, prop, kind: inferType(prop) })),
    [properties],
  );

  const [jsonErrors, setJsonErrors] = useState<Record<string, string | null>>({});

  const hasJsonErrors = useMemo(
    () => Object.values(jsonErrors).some((value) => Boolean(value)),
    [jsonErrors],
  );

  useEffect(() => {
    onParseStateChange?.(hasJsonErrors);
  }, [hasJsonErrors, onParseStateChange]);

  function setField(name: string, value: unknown) {
    onChange({ ...values, [name]: value });
  }

  function renderControl(name: string, prop: JsonSchemaProperty, kind: string) {
    const value = values[name];

    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      const options = prop.enum.map((v) => String(v));
      const selected = value == null ? "" : String(value);
      return (
        <select
          value={selected}
          onChange={(e) => setField(name, e.target.value || undefined)}
          onBlur={() => onFieldBlur?.(name)}
          className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
        >
          <option value="">(unset)</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }

    if (kind === "boolean") {
      return (
        <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setField(name, e.target.checked)}
            onBlur={() => onFieldBlur?.(name)}
            className="accent-zinc-700 dark:accent-zinc-300"
          />
          Enabled
        </label>
      );
    }

    if (kind === "integer" || kind === "number") {
      return (
        <input
          type="number"
          value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              setField(name, undefined);
              return;
            }
            const parsed = Number(raw);
            setField(name, Number.isFinite(parsed) ? parsed : undefined);
          }}
          onBlur={() => onFieldBlur?.(name)}
          className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
        />
      );
    }

    if (kind === "object" || kind === "array") {
      const textValue = toJsonText(value, prop.default ?? (kind === "array" ? [] : {}));
      return (
        <div className="flex flex-col gap-1">
          <textarea
            value={textValue}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw.trim()) {
                setField(name, undefined);
                setJsonErrors((prev) => ({ ...prev, [name]: null }));
                return;
              }
              try {
                const parsed = JSON.parse(raw);
                setField(name, parsed);
                setJsonErrors((prev) => ({ ...prev, [name]: null }));
              } catch {
                setJsonErrors((prev) => ({ ...prev, [name]: "Invalid JSON" }));
              }
            }}
            onBlur={() => onFieldBlur?.(name)}
            placeholder={kind === "array" ? "[...]" : "{...}"}
            rows={4}
            className="w-full rounded border border-zinc-300 bg-white px-3 py-1 font-mono text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
          />
          {jsonErrors[name] && <span className="text-xs text-red-500">{jsonErrors[name]}</span>}
        </div>
      );
    }

    return (
      <input
        type="text"
        value={typeof value === "string" ? value : value == null ? "" : String(value)}
        onChange={(e) => setField(name, e.target.value === "" ? undefined : e.target.value)}
        onBlur={() => onFieldBlur?.(name)}
        className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
      />
    );
  }

  if (fields.length === 0) {
    return <p className="text-xs text-zinc-400 dark:text-zinc-600">No schema fields.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.map(({ name, prop, kind }) => (
        <div key={name} className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            {name}
            {required.has(name) ? <span className="ml-1 text-red-500">*</span> : null}
            <span className="ml-1 text-zinc-400 dark:text-zinc-600">({kind})</span>
          </label>
          {renderControl(name, prop, kind)}
          {prop.description && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{prop.description}</span>
          )}
        </div>
      ))}
    </div>
  );
}
