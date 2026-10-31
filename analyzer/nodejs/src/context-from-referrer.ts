/**
 * `x-telo-context-from-referrer: "<binding>"` — a binding of a referent kind's
 * `x-telo-context` typed by whoever references the resource: at each slot that
 * references it, the binding of that name in scope there. A field kind's
 * `values` is its form's record, an option source's `values` the record of the
 * form its field sits in, though neither kind knows the form.
 *
 * Legal only on a binding marked `x-telo-context-eval: accessor` alone: the
 * type is the referrer's, which an expression the resource itself evaluates
 * could not read. This file is the one reader of the value and its strict half;
 * the typing is the scope rule's (`CelScopeResolver.siteVariants`), since it
 * needs each referrer's scope at its slot.
 *
 * Browser-safe: no Node built-ins.
 */
import { CONTEXT_EVAL, contextEvalModes } from "./context-eval.js";
import { READS_SLOT_SCOPES, type ReadReporter } from "./read-place.js";

export const CONTEXT_FROM_REFERRER = "x-telo-context-from-referrer";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The referrer binding `binding` is typed from, or undefined. */
export function readFromReferrer(binding: unknown): string | undefined {
  if (!binding || typeof binding !== "object") return undefined;
  const value = (binding as Record<string, unknown>)[CONTEXT_FROM_REFERRER];
  return typeof value === "string" && NAME.test(value) ? value : undefined;
}

/** The other annotations that type a binding — one binding is typed one way. */
const TYPING_ANNOTATIONS = [
  "x-telo-context-from",
  "x-telo-context-from-root",
  "x-telo-context-from-ref-kind",
  "x-telo-context-ref-from",
  "x-telo-context-element-from",
  "x-telo-context-element-from-item",
  "x-telo-context-collection-from",
  "x-telo-context-parameters-from",
] as const;

export type FromReferrerProblem =
  | { readonly code: "SCHEMA_VIOLATION"; readonly message: string }
  | { readonly code: "CONTEXT_FROM_REFERRER_INVALID"; readonly message: string };

/**
 * Why the annotation on `node` is malformed or misplaced, or undefined. `where`
 * names it as the diagnostic does; `onBinding` says the node is a property of an
 * `x-telo-context`.
 */
export function fromReferrerProblem(
  node: Record<string, unknown>,
  where: string,
  onBinding: boolean,
): FromReferrerProblem | undefined {
  const value = node[CONTEXT_FROM_REFERRER];
  if (typeof value !== "string" || !NAME.test(value)) {
    return {
      code: "SCHEMA_VIOLATION",
      message: `'${where}' names the binding a referrer's scope types this one from, so it must be a binding name.`,
    };
  }
  if (!onBinding) {
    return {
      code: "CONTEXT_FROM_REFERRER_INVALID",
      message: `'${where}' is read only on a binding — a property of an 'x-telo-context' — so here it types nothing.`,
    };
  }
  const modes = contextEvalModes(node);
  if (!modes || modes.length !== 1 || modes[0] !== "accessor") {
    return {
      code: "CONTEXT_FROM_REFERRER_INVALID",
      message:
        `'${where}' types a binding from the resource that references this one, which only an ` +
        `accessor field can name: mark the binding '${CONTEXT_EVAL}: accessor' and nothing else.`,
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
