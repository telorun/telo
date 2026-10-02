/**
 * One CEL expression, read and resolved.
 *
 * This is the front end's whole answer: the source as written, the canonical tree,
 * the namespace set the tree was resolved under, and at most one syntax diagnostic.
 * **Every expression this module hands out is already resolved** — there is no way
 * to obtain an unresolved tree and then forget to resolve it, and `namespaces`
 * records what it was resolved under so a consumer checking it against a different
 * set can refuse rather than quietly answer the wrong question.
 *
 * Reading an expression never throws: a source it cannot read gives a tree for the
 * longest prefix it could, plus the diagnostic saying where it stopped.
 */

import {
  namespaceSetsEqual,
  normalizeNamespaces,
  resolveNamespaces,
} from "./namespace-resolution.js";
import type { ParseOptions } from "./parser.js";
import { parseSyntax } from "./parser.js";
import type { CelSyntaxDiagnostic } from "./syntax-diagnostic.js";
import type { CelNode } from "./syntax-tree.js";

export interface CelExpression {
  readonly source: string;
  readonly root: CelNode;
  /** The namespace set the tree was resolved under, in canonical order. */
  readonly namespaces: readonly string[];
  /** At most one entry; one exactly when the source could not be read whole. */
  readonly diagnostics: readonly CelSyntaxDiagnostic[];
}

export interface ParseExpressionOptions extends ParseOptions {
  /** The names that denote namespaces rather than values at this site. */
  readonly namespaces?: Iterable<string>;
}

export function parseExpression(source: string, options?: ParseExpressionOptions): CelExpression {
  const namespaces = normalizeNamespaces(options?.namespaces ?? []);
  const parsed = parseSyntax(source, options);
  return {
    source,
    root: resolveNamespaces(parsed.root, namespaces),
    namespaces,
    diagnostics: parsed.diagnostics,
  };
}

/** Whether the expression was resolved under exactly these namespaces. */
export function resolvedUnder(expression: CelExpression, namespaces: Iterable<string>): boolean {
  return namespaceSetsEqual(expression.namespaces, normalizeNamespaces(namespaces));
}
