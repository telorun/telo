/**
 * `x-telo-context-from-referrer: "<binding>[/<member>…]"` — a node of a
 * referent kind's `x-telo-context`, a binding or a member beneath one, typed by
 * whoever references the resource: at each slot that references it, the node
 * the path names in the scope in force there, read at the site's own eval
 * mode. A field kind's `values` is its form's record, a route's
 * `request.principal` the principal its mounts type, though neither kind knows
 * its referrer.
 *
 * Each referrer's type REPLACES the node's own keywords; with no referrer, or
 * where a referrer's scope lacks the path at that mode, the node keeps them.
 * This file is the one reader of the value and its strict half; the typing is
 * the scope rule's (`CelScopeResolver.siteVariants`), since it needs each
 * referrer's scope at its slot.
 *
 * Browser-safe: no Node built-ins.
 */
import { READS_SLOT_SCOPES, type ReadReporter } from "./read-place.js";

export const CONTEXT_FROM_REFERRER = "x-telo-context-from-referrer";

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/** The path through the referrer's scope `node` is typed from — the binding,
 *  then each member beneath it — or undefined. */
export function readFromReferrer(node: unknown): readonly string[] | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = (node as Record<string, unknown>)[CONTEXT_FROM_REFERRER];
  return typeof value === "string" && PATH.test(value) ? value.split("/") : undefined;
}

/** The keywords a node typed from its referrers declares itself — what it is
 *  where no referrer types it. */
export function fromReferrerOwnKeywords(node: Record<string, any>): Record<string, any> {
  const { [CONTEXT_FROM_REFERRER]: _referrer, ...own } = node;
  return own;
}

/** The other annotations that type a context node — one node is typed one way. */
export const TYPING_ANNOTATIONS = [
  "x-telo-context-from",
  "x-telo-context-from-root",
  "x-telo-context-from-ref-kind",
  "x-telo-context-ref-from",
  "x-telo-context-element-from",
  "x-telo-context-element-from-item",
  "x-telo-context-collection-from",
  "x-telo-context-parameters-from",
  "x-telo-context-from-path-template",
] as const;

export type FromReferrerProblem =
  | { readonly code: "SCHEMA_VIOLATION"; readonly message: string }
  | { readonly code: "CONTEXT_FROM_REFERRER_INVALID"; readonly message: string };

/**
 * Why the annotation on `node` is malformed or misplaced, or undefined. `where`
 * names it as the diagnostic does; `inBinding` says the node is a binding — a
 * property of an `x-telo-context` — or a member reached from one through
 * `properties`.
 */
export function fromReferrerProblem(
  node: Record<string, unknown>,
  where: string,
  inBinding: boolean,
): FromReferrerProblem | undefined {
  const value = node[CONTEXT_FROM_REFERRER];
  if (typeof value !== "string" || !PATH.test(value)) {
    return {
      code: "SCHEMA_VIOLATION",
      message:
        `'${where}' names what a referrer's scope types this node from — a binding, then each member ` +
        `beneath it, joined by '/' ('values', 'request/principal').`,
    };
  }
  if (!inBinding) {
    return {
      code: "CONTEXT_FROM_REFERRER_INVALID",
      message:
        `'${where}' is read only on a binding — a property of an 'x-telo-context' — or a member beneath ` +
        `one, so here it types nothing.`,
    };
  }
  const beside = TYPING_ANNOTATIONS.find((key) => key in node);
  if (beside) {
    return {
      code: "CONTEXT_FROM_REFERRER_INVALID",
      message: `'${where}' types the binding from its referrer, and '${beside}' beside it types it too; keep one.`,
    };
  }
  return undefined;
}

/** What `x-telo-context-from-referrer` reads: every declaration referencing the
 *  resource, whose scope at each referencing slot types the binding. */
export const fromReferrerReads: ReadReporter = () => [{ kind: "referrers", reads: READS_SLOT_SCOPES }];
