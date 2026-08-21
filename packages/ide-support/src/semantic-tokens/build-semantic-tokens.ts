import {
  buildLineOffsets,
  offsetToPosition,
  parseToAst,
  type AnalysisRegistry,
  type AstDocument,
  type AstNode,
  type AstScalar,
  type CelScope,
  type ManifestAnalysis,
} from "@telorun/analyzer";
import type { SemanticToken } from "../types.js";
import { celSegmentTokens } from "../cel/tokens.js";
import { docIdentity } from "../doc-identity.js";
import { scalarString } from "../completions/resolve-node.js";
import { CAPABILITY_VALUES } from "../completions/valid-capabilities.js";

const CAPABILITIES = new Set<string>(CAPABILITY_VALUES);

/** Append one key segment to a concrete path (`routes[0]` + `handler`). */
function joinKey(concrete: string, key: string): string {
  return concrete ? `${concrete}.${key}` : key;
}

/** Registry-aware semantic tokens: a `kind:` value that resolves to a known
 *  definition is a `type`; a `capability:` value is an `interface`; a `!ref`
 *  target is a `variable`. Ref targets are colored here rather than in the
 *  grammar because a `!ref` after a `key:` is tokenized by the bundled YAML
 *  grammar before a Telo pattern can claim it — the AST sees it unambiguously.
 *  An unresolved kind gets no token, so a typo stays uncolored — a quiet signal
 *  that pairs with the analyzer's `UNDEFINED_KIND` diagnostic.
 *
 *  The inside of a `!cel` / `${{ }}` body is colored here too, and for the same
 *  reason one level down: a grammar can only know the roots someone hardcoded
 *  into it, while `scopeQuery` knows what is in scope at this exact site. With
 *  no query the names are colored syntactically instead — a CEL body must never
 *  read as a plain string, which is what the stock YAML grammar makes of it. */
export function buildSemanticTokens(
  text: string,
  registry: AnalysisRegistry | undefined,
  docs?: AstDocument[],
  analysis?: ManifestAnalysis,
): SemanticToken[] {
  const astDocs = docs ?? parseToAst(text);
  const lineOffsets = buildLineOffsets(text);

  const tokens: SemanticToken[] = [];
  const emitRange = (range: [number, number], type: SemanticToken["type"]): void => {
    const start = offsetToPosition(range[0], lineOffsets);
    const end = offsetToPosition(range[1], lineOffsets);
    // Kind / capability values and CEL identifiers never span lines; a clamped
    // single-line token.
    if (start.line !== end.line) return;
    tokens.push({
      line: start.line,
      character: start.character,
      length: end.character - start.character,
      type,
    });
  };
  const emit = (node: AstNode | undefined, type: SemanticToken["type"]): void => {
    if (node) emitRange(node.range, type);
  };

  for (const doc of astDocs) {
    if (!doc.root) continue;

    // The scope is resolved per SITE. `scopeAt` caches per (resource, path) for
    // the analysis's lifetime, which is what keeps a whole-file colourizer off
    // the per-keystroke cost of rebuilding a context-matched environment.
    const identity = docIdentity(doc);
    const scopeQuery = analysis?.celScope;
    const resource = scopeQuery?.resourceFor(identity.kind, identity.name);
    const scopeAt = (path: string): CelScope | undefined =>
      scopeQuery && resource ? scopeQuery.scopeAt(resource, path) : undefined;

    const celTokens = (node: AstScalar, path: string): void => {
      const segments = node.celSegments();
      if (segments.length === 0) return;
      const scope = scopeAt(path);
      for (const segment of segments) {
        for (const span of celSegmentTokens(text, segment, scope)) emitRange(span.range, span.type);
      }
    };

    const walk = (node: AstNode, concrete: string): void => {
      if (node.kind === "map") {
        for (const pair of node.entries) {
          const key = scalarString(pair.key);
          const value = scalarString(pair.value);
          if (key === "kind" && value && registry?.resolveDefinition(value)) {
            emit(pair.value, "type");
          } else if (key === "capability" && value && CAPABILITIES.has(value)) {
            emit(pair.value, "interface");
          }
          if (pair.value) walk(pair.value, key != null ? joinKey(concrete, key) : concrete);
        }
        return;
      }
      if (node.kind === "seq") {
        // Indices are kept: a CEL site's scope is addressed per item, so an
        // index-erased path resolves the wrong context or none.
        node.items.forEach((item, index) => walk(item, `${concrete}[${index}]`));
        return;
      }
      if (node.kind === "scalar") {
        if (node.tag === "!ref") {
          emit(node, "variable");
          return;
        }
        celTokens(node, concrete);
      }
    };

    walk(doc.root, "");
  }
  return tokens;
}
