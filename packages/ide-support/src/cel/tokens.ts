/**
 * Semantic tokens for the inside of a CEL body.
 *
 * A `!cel "..."` scalar is not a string, and under a stock YAML grammar it is
 * painted as one. Colouring it through the SEMANTIC layer rather than a grammar
 * is what makes one implementation serve both hosts — VS Code and the editor's
 * Monaco already share `buildSemanticTokens`, while a Monarch tokenizer beside
 * the TextMate one would be a second CEL lexer to keep in agreement.
 *
 * It is also the only layer that can be right about NAMES. A grammar knows the
 * seven kernel roots someone hardcoded into it, which is why `request` and
 * `steps` go uncoloured today; the scope query knows what is actually in scope
 * at this exact site. So a name the scope confirms is coloured and a name it
 * cannot is left alone — the quiet signal an unresolved `kind:` already gives.
 */
import { CelParseError, type CelNode, type CelScope, type CelSegment } from "@telorun/analyzer";
import type { SemanticTokenType } from "../types.js";
import { flattenChain } from "../cel-chain.js";
import { celRootSymbols, celSymbolAt } from "./symbols.js";

/** A token before it is placed on a line — document offsets, resolved by the
 *  caller which owns the line table. */
export interface CelTokenSpan {
  range: [number, number];
  type: SemanticTokenType;
}

/** How a name is coloured when the scope has no opinion. With a scope, an
 *  unconfirmed name is deliberately left uncoloured; with none — a host that
 *  passed no query, or a buffer analysis has not reached — every identifier is
 *  coloured syntactically, so a CEL body still never reads as a plain string. */
type NameMode = "scoped" | "syntactic";

const LITERAL_TYPE = (value: unknown): SemanticTokenType | undefined => {
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean" || value === null) return "keyword";
  return undefined;
};

/**
 * Tokens for one CEL segment.
 *
 * A body that does not parse yields nothing: mid-typing is the normal case
 * here, and the analyzer reports the syntax error itself. Only that failure is
 * tolerated — a defect in the CEL wrapper propagates.
 */
export function celSegmentTokens(
  text: string,
  segment: CelSegment,
  scope: CelScope | undefined,
): CelTokenSpan[] {
  let ast: CelNode;
  try {
    ast = segment.ast();
  } catch (error) {
    if (!(error instanceof CelParseError)) throw error;
    return [];
  }
  const out: CelTokenSpan[] = [];
  const mode: NameMode = scope ? "scoped" : "syntactic";
  // Resolved once per SEGMENT, not once per name: the root set is a property of
  // the scope, and this runs over the whole document on every token request.
  const inScope = scope ? new Set(celRootSymbols(scope).map((s) => s.name)) : undefined;

  /** True when the scope confirms the chain `parts`. Callers walk a chain
   *  left-to-right and stop at the first unconfirmed hop, so each name is
   *  resolved once rather than the chain being re-walked from its root per hop. */
  const confirms = (parts: string[]): boolean => {
    if (mode === "syntactic") return true;
    if (parts.length === 1) return inScope!.has(parts[0]);
    return celSymbolAt(scope!, parts) !== undefined;
  };

  /** The span of `name` between two offsets, or undefined when it is not there
   *  (a receiver-style call written across an unexpected layout). Nothing is
   *  invented: a token placed on a guessed span would paint the wrong text. */
  const spanOf = (name: string, from: number, to: number): [number, number] | undefined => {
    const at = text.indexOf(name, from);
    return at >= 0 && at + name.length <= to ? [at, at + name.length] : undefined;
  };

  const visit = (node: CelNode): void => {
    switch (node.kind) {
      case "literal": {
        const type = LITERAL_TYPE(node.value);
        if (type) out.push({ range: node.range, type });
        return;
      }
      case "ident":
        // A root-position name is a scope the runtime injects, not data the
        // author declared — see `SemanticTokenType`.
        if (confirms([node.name])) out.push({ range: node.range, type: "namespace" });
        return;
      case "member": {
        // A plain chain is resolved as a whole, so each hop is judged against
        // what the one before it declared — `resources.db.url` colours `db` only
        // if `resources` really carries it. A chain rooted in something computed
        // (`f().x`) flattens to nothing, and the scope has no opinion about it.
        const parts = flattenChain(node);
        if (parts) {
          // A hop the scope cannot confirm makes every hop past it unresolvable
          // too, so the walk STOPS there rather than re-resolving the rest — the
          // chain is resolved once, not once per hop.
          for (let i = 0; i < parts.length; i++) {
            if (!confirms(parts.slice(0, i + 1).map((p) => p.name))) break;
            out.push({ range: parts[i].range, type: i === 0 ? "namespace" : "property" });
          }
          return;
        }
        visit(node.target);
        if (mode === "syntactic") out.push({ range: node.propertyRange, type: "property" });
        return;
      }
      case "index":
        visit(node.target);
        visit(node.index);
        return;
      case "call": {
        // `foo(...)` starts with its own name, so the head of the node IS the
        // callee's span.
        out.push({ range: [node.range[0], node.range[0] + node.name.length], type: "function" });
        for (const arg of node.args) visit(arg);
        return;
      }
      case "methodCall": {
        visit(node.receiver);
        const span = spanOf(node.name, node.receiver.range[1], node.range[1]);
        if (span) out.push({ range: span, type: "function" });
        for (const arg of node.args) visit(arg);
        return;
      }
      case "list":
        for (const item of node.items) visit(item);
        return;
      case "map":
        for (const entry of node.entries) {
          visit(entry.key);
          visit(entry.value);
        }
        return;
      case "ternary":
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        return;
      case "unary": {
        const span = spanOf(node.op, node.range[0], node.operand.range[0]);
        if (span) out.push({ range: span, type: "operator" });
        visit(node.operand);
        return;
      }
      case "binary": {
        visit(node.left);
        const span = spanOf(node.op, node.left.range[1], node.right.range[0]);
        if (span) out.push({ range: span, type: "operator" });
        visit(node.right);
        return;
      }
    }
    // Exhaustive by construction: a new `CelNode` variant fails the build here
    // rather than going silently uncoloured.
    const unhandled: never = node;
    throw new Error(`Unhandled CEL node: ${JSON.stringify(unhandled)}`);
  };

  visit(ast);
  return out;
}
