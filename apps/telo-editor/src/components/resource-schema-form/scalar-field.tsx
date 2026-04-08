import type { JsonSchemaProperty } from "./types";

interface ScalarFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  kind: string;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
}

export function ScalarField({ prop, value, kind, onValueChange, onBlur }: ScalarFieldProps) {
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const options = prop.enum.map((option) => String(option));
    const selected = value == null ? "" : String(value);
    return (
      <select
        value={selected}
        onChange={(e) => onValueChange(e.target.value || undefined)}
        onBlur={onBlur}
        className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
      >
        <option value="">(unset)</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
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
          onChange={(e) => onValueChange(e.target.checked)}
          onBlur={onBlur}
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
            onValueChange(undefined);
            return;
          }
          const parsed = Number(raw);
          onValueChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
        onBlur={onBlur}
        className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
      />
    );
  }

  return (
    <input
      type="text"
      value={typeof value === "string" ? value : value == null ? "" : String(value)}
      onChange={(e) => onValueChange(e.target.value === "" ? undefined : e.target.value)}
      onBlur={onBlur}
      className="w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400"
    />
  );
}
