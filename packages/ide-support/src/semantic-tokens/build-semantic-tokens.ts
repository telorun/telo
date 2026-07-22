import {
  buildLineOffsets,
  offsetToPosition,
  parseToAst,
  type AnalysisRegistry,
  type AstDocument,
  type AstNode,
} from "@telorun/analyzer";
import type { SemanticToken } from "../types.js";
import { scalarString } from "../completions/resolve-node.js";
import { CAPABILITY_VALUES } from "../completions/valid-capabilities.js";

const CAPABILITIES = new Set<string>(CAPABILITY_VALUES);

/** Registry-aware semantic tokens: a `kind:` value that resolves to a known
 *  definition is a `type`; a `capability:` value is an `interface`; a `!ref`
 *  target is a `variable`. Everything else (structure, CEL, tags) is left to the
 *  TextMate grammar. Ref targets are colored here rather than in the grammar
 *  because a `!ref` after a `key:` is tokenized by the bundled YAML grammar
 *  before a Telo pattern can claim it — the AST sees it unambiguously. An
 *  unresolved kind gets no token, so a typo stays uncolored — a quiet signal
 *  that pairs with the analyzer's `UNDEFINED_KIND` diagnostic. */
export function buildSemanticTokens(
  text: string,
  registry: AnalysisRegistry | undefined,
  docs?: AstDocument[],
): SemanticToken[] {
  const astDocs = docs ?? parseToAst(text);
  const lineOffsets = buildLineOffsets(text);

  const tokens: SemanticToken[] = [];
  const emit = (node: AstNode | undefined, type: SemanticToken["type"]): void => {
    if (!node) return;
    const start = offsetToPosition(node.range[0], lineOffsets);
    const end = offsetToPosition(node.range[1], lineOffsets);
    // Kind / capability values never span lines; a clamped single-line token.
    if (start.line !== end.line) return;
    tokens.push({ line: start.line, character: start.character, length: end.character - start.character, type });
  };

  const walk = (node: AstNode): void => {
    if (node.kind === "map") {
      for (const pair of node.entries) {
        const key = scalarString(pair.key);
        const value = scalarString(pair.value);
        if (key === "kind" && value && registry?.resolveDefinition(value)) {
          emit(pair.value, "type");
        } else if (key === "capability" && value && CAPABILITIES.has(value)) {
          emit(pair.value, "interface");
        }
        if (pair.value) walk(pair.value);
      }
    } else if (node.kind === "seq") {
      for (const item of node.items) walk(item);
    } else if (node.kind === "scalar" && node.tag === "!ref") {
      emit(node, "variable");
    }
  };

  for (const doc of astDocs) {
    if (doc.root) walk(doc.root);
  }
  return tokens;
}
