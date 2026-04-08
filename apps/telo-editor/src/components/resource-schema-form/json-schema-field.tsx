import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";

interface JsonSchemaFieldProps {
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
}

const PROPERTY_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PropertyDef {
  name: string;
  schema: Record<string, unknown>;
}

function parseProperties(value: unknown): { properties: PropertyDef[]; required: Set<string> } {
  if (!isRecord(value)) return { properties: [], required: new Set() };

  const required = new Set<string>(
    Array.isArray(value.required)
      ? (value.required as unknown[]).filter((r): r is string => typeof r === "string")
      : [],
  );

  const props = isRecord(value.properties) ? value.properties : {};
  const properties: PropertyDef[] = Object.entries(props)
    .filter(([, def]) => isRecord(def))
    .map(([name, def]) => ({ name, schema: def as Record<string, unknown> }));

  return { properties, required };
}

function buildValue(
  properties: PropertyDef[],
  required: Set<string>,
  existingValue: unknown,
): Record<string, unknown> {
  const existing = isRecord(existingValue) ? existingValue : {};
  const result: Record<string, unknown> = { ...existing, type: "object" };

  const reqArray = properties.filter((p) => required.has(p.name)).map((p) => p.name);
  if (reqArray.length > 0) {
    result.required = reqArray;
  } else {
    delete result.required;
  }

  if (properties.length > 0) {
    const props: Record<string, unknown> = {};
    for (const p of properties) {
      props[p.name] = p.schema;
    }
    result.properties = props;
  } else {
    delete result.properties;
  }

  return result;
}

const inputBaseClass =
  "rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";
const inputClass = `w-full ${inputBaseClass}`;
const selectClass =
  "shrink-0 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400";
const labelClass = "text-xs text-zinc-500 dark:text-zinc-400";

interface FieldSetterProps {
  schema: Record<string, unknown>;
  setField: (key: string, value: unknown) => void;
  onBlur: () => void;
}

function DefaultValueInput({
  propType,
  value,
  onChange,
  onBlur,
}: {
  propType: string;
  value: unknown;
  onChange: (val: unknown) => void;
  onBlur: () => void;
}) {
  if (propType === "boolean") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className={labelClass}>default</span>
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : undefined)}
            onBlur={onBlur}
            className="accent-zinc-700 dark:accent-zinc-300"
          />
          true
        </label>
      </div>
    );
  }

  if (propType === "number" || propType === "integer") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className={labelClass}>default</span>
        <input
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) ? parsed : undefined);
          }}
          onBlur={onBlur}
          className={inputClass}
          placeholder="Default value"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <span className={labelClass}>default</span>
      <input
        type="text"
        value={typeof value === "string" ? value : value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        onBlur={onBlur}
        className={inputClass}
        placeholder="Default value"
      />
    </div>
  );
}

function StringValidation({ schema, setField, onBlur }: FieldSetterProps) {
  const enumValue = Array.isArray(schema.enum) ? schema.enum.map(String).join(", ") : "";

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className={labelClass}>enum (comma-separated)</span>
        <input
          type="text"
          value={enumValue}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw.trim() === "") {
              setField("enum", undefined);
            } else {
              setField(
                "enum",
                raw
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
            }
          }}
          onBlur={onBlur}
          className={inputClass}
          placeholder="value1, value2, value3"
        />
      </div>
      <div className="flex gap-2">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className={labelClass}>minLength</span>
          <input
            type="number"
            value={typeof schema.minLength === "number" ? String(schema.minLength) : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              setField("minLength", typeof v === "number" && Number.isFinite(v) ? v : undefined);
            }}
            onBlur={onBlur}
            className={inputClass}
          />
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className={labelClass}>maxLength</span>
          <input
            type="number"
            value={typeof schema.maxLength === "number" ? String(schema.maxLength) : ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              setField("maxLength", typeof v === "number" && Number.isFinite(v) ? v : undefined);
            }}
            onBlur={onBlur}
            className={inputClass}
          />
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className={labelClass}>pattern</span>
        <input
          type="text"
          value={typeof schema.pattern === "string" ? schema.pattern : ""}
          onChange={(e) => setField("pattern", e.target.value === "" ? undefined : e.target.value)}
          onBlur={onBlur}
          className={inputClass}
          placeholder="Regular expression"
        />
      </div>
    </>
  );
}

function NumberValidation({ schema, setField, onBlur }: FieldSetterProps) {
  return (
    <div className="flex gap-2">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className={labelClass}>minimum</span>
        <input
          type="number"
          value={typeof schema.minimum === "number" ? String(schema.minimum) : ""}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value);
            setField("minimum", typeof v === "number" && Number.isFinite(v) ? v : undefined);
          }}
          onBlur={onBlur}
          className={inputClass}
        />
      </div>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className={labelClass}>maximum</span>
        <input
          type="number"
          value={typeof schema.maximum === "number" ? String(schema.maximum) : ""}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value);
            setField("maximum", typeof v === "number" && Number.isFinite(v) ? v : undefined);
          }}
          onBlur={onBlur}
          className={inputClass}
        />
      </div>
    </div>
  );
}

function ArrayItemsConfig({ schema, setField, onBlur }: FieldSetterProps) {
  const items = isRecord(schema.items) ? schema.items : {};
  const itemType = typeof items.type === "string" ? items.type : "string";

  return (
    <div className="flex flex-col gap-0.5">
      <span className={labelClass}>items type</span>
      <select
        value={itemType}
        onChange={(e) => setField("items", { type: e.target.value })}
        onBlur={onBlur}
        className={selectClass}
      >
        {PROPERTY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

export function JsonSchemaField({ value, onValueChange, onBlur }: JsonSchemaFieldProps) {
  const { properties, required } = parseProperties(value);
  const [expandedIndices, setExpandedIndices] = useState<Set<number>>(new Set());

  function emit(nextProps: PropertyDef[], nextRequired: Set<string>) {
    onValueChange(buildValue(nextProps, nextRequired, value));
  }

  function addProperty() {
    const existing = new Set(properties.map((p) => p.name));
    let name = "newProperty";
    let i = 1;
    while (existing.has(name)) name = `newProperty${i++}`;

    emit([...properties, { name, schema: { type: "string" } }], required);
    setExpandedIndices((prev) => new Set([...prev, properties.length]));
  }

  function removeProperty(index: number) {
    const removed = properties[index];
    const nextRequired = new Set(required);
    nextRequired.delete(removed.name);
    emit(
      properties.filter((_, i) => i !== index),
      nextRequired,
    );
    setExpandedIndices((prev) => {
      const next = new Set<number>();
      for (const i of prev) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }

  function updatePropertyName(index: number, newName: string) {
    const old = properties[index];
    const next = [...properties];
    next[index] = { ...old, name: newName };
    const nextRequired = new Set(required);
    if (nextRequired.has(old.name)) {
      nextRequired.delete(old.name);
      nextRequired.add(newName);
    }
    emit(next, nextRequired);
  }

  function setPropertySchema(index: number, schema: Record<string, unknown>) {
    const next = [...properties];
    next[index] = { ...next[index], schema };
    emit(next, required);
  }

  function makeFieldSetter(index: number) {
    return (key: string, fieldValue: unknown) => {
      const current = properties[index].schema;
      const next = { ...current };
      if (fieldValue === undefined || fieldValue === null) {
        delete next[key];
      } else {
        next[key] = fieldValue;
      }
      setPropertySchema(index, next);
    };
  }

  function changeType(index: number, newType: string) {
    const old = properties[index].schema;
    const schema: Record<string, unknown> = { type: newType };
    if (typeof old.description === "string") schema.description = old.description;
    setPropertySchema(index, schema);
  }

  function toggleRequired(name: string) {
    const nextRequired = new Set(required);
    if (nextRequired.has(name)) nextRequired.delete(name);
    else nextRequired.add(name);
    emit(properties, nextRequired);
  }

  function toggleExpanded(index: number) {
    setExpandedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {properties.map((prop, index) => {
        const isExpanded = expandedIndices.has(index);
        const propType = typeof prop.schema.type === "string" ? prop.schema.type : "string";
        const setField = makeFieldSetter(index);

        return (
          <div key={index} className="rounded border border-zinc-200 dark:border-zinc-700">
            <div className="flex items-center gap-1 p-2">
              <button
                type="button"
                onClick={() => toggleExpanded(index)}
                className="shrink-0 p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                {isExpanded ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
              </button>
              <input
                type="text"
                value={prop.name}
                onChange={(e) => updatePropertyName(index, e.target.value)}
                onBlur={onBlur}
                className={`min-w-0 flex-1 ${inputBaseClass}`}
              />
              <select
                value={propType}
                onChange={(e) => changeType(index, e.target.value)}
                onBlur={onBlur}
                className={selectClass}
              >
                {PROPERTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label className="inline-flex shrink-0 items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={required.has(prop.name)}
                  onChange={() => toggleRequired(prop.name)}
                  onBlur={onBlur}
                  className="accent-zinc-700 dark:accent-zinc-300"
                />
                req
              </label>
              <button
                type="button"
                onClick={() => removeProperty(index)}
                onBlur={onBlur}
                className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
              >
                <XIcon className="size-3" />
              </button>
            </div>

            {isExpanded && (
              <div className="flex flex-col gap-2 border-t border-zinc-100 p-2 dark:border-zinc-800">
                <div className="flex flex-col gap-0.5">
                  <span className={labelClass}>description</span>
                  <input
                    type="text"
                    value={
                      typeof prop.schema.description === "string" ? prop.schema.description : ""
                    }
                    onChange={(e) =>
                      setField("description", e.target.value === "" ? undefined : e.target.value)
                    }
                    onBlur={onBlur}
                    className={inputClass}
                    placeholder="Property description"
                  />
                </div>

                <DefaultValueInput
                  propType={propType}
                  value={prop.schema.default}
                  onChange={(val) => setField("default", val)}
                  onBlur={onBlur}
                />

                {propType === "string" && (
                  <StringValidation schema={prop.schema} setField={setField} onBlur={onBlur} />
                )}
                {(propType === "number" || propType === "integer") && (
                  <NumberValidation schema={prop.schema} setField={setField} onBlur={onBlur} />
                )}
                {propType === "array" && (
                  <ArrayItemsConfig schema={prop.schema} setField={setField} onBlur={onBlur} />
                )}
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={addProperty}
        onBlur={onBlur}
        className="self-start rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        + Add property
      </button>
    </div>
  );
}
