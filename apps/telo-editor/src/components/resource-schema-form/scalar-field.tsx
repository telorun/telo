import { CodeField } from "./code-field";
import type { JsonSchemaProperty } from "./types";

interface ScalarFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  kind: string;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
}

/** Shared input chrome; `disabled:` variants render a server-enforced
 *  (`readOnly`) field as a muted, non-editable control. */
const INPUT_CLASS =
  "w-full rounded border border-zinc-300 bg-white px-3 py-1 text-sm outline-none focus:border-zinc-500 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500";

export function ScalarField({ prop, value, kind, onValueChange, onBlur }: ScalarFieldProps) {
  const readOnly = prop.readOnly === true;

  if (kind === "string" && prop["x-telo-widget"] === "code") {
    return (
      <CodeField prop={prop} value={value} onValueChange={onValueChange} onBlur={onBlur} />
    );
  }

  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const options = prop.enum.map((option) => String(option));
    const selected = value == null ? "" : String(value);
    return (
      <select
        value={selected}
        onChange={(e) => onValueChange(e.target.value || undefined)}
        onBlur={onBlur}
        disabled={readOnly}
        className={INPUT_CLASS}
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
          disabled={readOnly}
          className="accent-zinc-700 disabled:cursor-not-allowed dark:accent-zinc-300"
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
          // Cleared number → explicit YAML null. v1 canvas never emits
          // `undefined` for backspace-clears, per null-vs-missing-key
          // convention: cleared inputs should not silently delete the
          // key. Null is the nearest-empty representation for a
          // non-string field.
          if (raw === "") {
            onValueChange(null);
            return;
          }
          const parsed = Number(raw);
          onValueChange(Number.isFinite(parsed) ? parsed : null);
        }}
        onBlur={onBlur}
        disabled={readOnly}
        className={INPUT_CLASS}
      />
    );
  }

  return (
    <input
      type="text"
      value={typeof value === "string" ? value : value == null ? "" : String(value)}
      // Cleared text → "" (not undefined). Per the v1 null-vs-missing-key
      // convention, only the deferred "remove field" affordance should
      // produce a key deletion; a backspace-clear preserves the key as
      // an explicit empty string.
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={onBlur}
      disabled={readOnly}
      className={INPUT_CLASS}
    />
  );
}
