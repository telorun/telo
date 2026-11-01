import { formatManifestText, isManifestText } from "@telorun/analyzer";

export interface FormattingEdit {
  /** Zero-based offsets into the text the edit applies to. */
  start: number;
  end: number;
  newText: string;
}

/**
 * The edit that brings a manifest to the canonical layout, trimmed to the span that
 * differs so the cursor and folds elsewhere survive. No edits for YAML that is not a manifest, a document that does
 * not parse — its diagnostics already say why — and for one already formatted.
 */
export function buildFormatting(text: string): FormattingEdit[] {
  if (!isManifestText(text)) return [];
  const result = formatManifestText(text);
  if (!result.ok || !result.changed) return [];
  const formatted = result.text;

  let start = 0;
  const shortest = Math.min(text.length, formatted.length);
  while (start < shortest && text[start] === formatted[start]) start++;
  let end = text.length;
  let formattedEnd = formatted.length;
  while (end > start && formattedEnd > start && text[end - 1] === formatted[formattedEnd - 1]) {
    end--;
    formattedEnd--;
  }
  return [{ start, end, newText: formatted.slice(start, formattedEnd) }];
}
