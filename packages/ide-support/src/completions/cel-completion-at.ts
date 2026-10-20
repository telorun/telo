import { buildCelSegments, type ManifestAnalysis } from "@telorun/analyzer";
import type { CompletionResult } from "../types.js";
import { celCompletions } from "./cel-completions.js";

/** A CEL value typed into a structured form field: not document text yet, so it
 *  is addressed by its resource and field rather than by a position. */
export interface CelFieldCompletionRequest {
  resource: { kind: string; name: string };
  /** Concrete path of the field within the resource. */
  path: string;
  /** The tag the value is written under, without its `!`. */
  tag: string;
  /** The value without its tag. */
  text: string;
  /** Cursor offset into `text`. */
  offset: number;
}

/**
 * Completion inside such a value: the tag's engine says where the CEL is — the
 * whole body of `!cel`, each hole of a tag with holes — and the cursor's
 * segment is completed against the scope the analysis resolves for the field.
 */
export function celCompletionAt(
  analysis: ManifestAnalysis,
  request: CelFieldCompletionRequest,
): CompletionResult[] {
  const { text, offset } = request;
  const segment = buildCelSegments(text, 0, `!${request.tag}`, text).find(
    (s) => offset >= s.range[0] && offset <= s.range[1],
  );
  if (!segment) return [];
  return celCompletions(text, segment, offset, request.path, request.resource, analysis.celScope);
}
