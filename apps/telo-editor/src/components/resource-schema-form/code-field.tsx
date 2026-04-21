import { CodeEditor } from "../code-editor";
import type { JsonSchemaProperty } from "./types";

interface CodeFieldProps {
  prop: JsonSchemaProperty;
  value: unknown;
  onValueChange: (next: unknown) => void;
  onBlur: () => void;
}

export function CodeField({ prop, value, onValueChange, onBlur }: CodeFieldProps) {
  const mimeType =
    typeof prop.contentMediaType === "string" ? prop.contentMediaType : undefined;
  const text = typeof value === "string" ? value : value == null ? "" : String(value);

  return (
    <CodeEditor
      value={text}
      mimeType={mimeType}
      // Cleared code → "" (not undefined). Matches ScalarField's
      // null-vs-missing-key convention: backspace-clear preserves the key
      // as an explicit empty string.
      onValueChange={(next) => onValueChange(next)}
      onBlur={onBlur}
    />
  );
}
