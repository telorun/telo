import { makeTaggedSentinel } from "@telorun/templating";
import { CodeEditor } from "../code-editor";
import { getTaggedSentinel } from "./cel-utils";
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

  // A `!literal` / `!cel`-tagged value (e.g. a `!literal |` SQL block) arrives
  // as a `{__tagged, engine, source}` sentinel. Edit its `source` text and
  // re-wrap with the same engine so the tag round-trips back to YAML; without
  // this the editor stringifies the object to "[object Object]".
  const tagged = getTaggedSentinel(value);
  const text = tagged
    ? tagged.source
    : typeof value === "string"
      ? value
      : value == null
        ? ""
        : String(value);

  return (
    <CodeEditor
      value={text}
      mimeType={mimeType}
      // Cleared code → "" (not undefined). Matches ScalarField's
      // null-vs-missing-key convention: backspace-clear preserves the key
      // as an explicit empty string.
      onValueChange={(next) =>
        onValueChange(tagged ? makeTaggedSentinel(tagged.engine, next) : next)
      }
      onBlur={onBlur}
    />
  );
}
