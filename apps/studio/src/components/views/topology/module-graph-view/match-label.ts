import { readWrittenValue, type WrittenValue } from "@telorun/analyzer";

/**
 * A row's `match` as the reader wrote it: each value in order, a tagged one as
 * its tag and source (`!ref site`, `!cel variables.base`), a list in brackets,
 * a mapping as `{k: v}`. Empty values are left out, so an unset flag does not
 * read as a word.
 */
export function matchLabel(match: Record<string, WrittenValue>): string {
  return joinTexts(Object.values(match), " ");
}

function joinTexts(values: readonly WrittenValue[], separator: string): string {
  return values.map(valueText).filter(Boolean).join(separator);
}

function valueText(value: WrittenValue): string {
  const reading = readWrittenValue(value);
  switch (reading.form) {
    case "scalar":
      return reading.value ? String(reading.value) : "";
    case "list":
      return `[${joinTexts(reading.items, ", ")}]`;
    case "tagged":
      return `!${reading.tag} ${reading.source}`;
    case "map": {
      const entries = reading.entries.flatMap(([key, entry]) => {
        const text = valueText(entry);
        return text ? [`${key}: ${text}`] : [];
      });
      return `{${entries.join(", ")}}`;
    }
  }
}
