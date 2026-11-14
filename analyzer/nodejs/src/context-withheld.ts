/**
 * `x-telo-context-withheld: "<reason>"` — a node of an `x-telo-context`, a
 * binding or a member beneath one, that is NAMED at the site but holds no value
 * there. Any expression reading it is refused — a null test, `has()` and an
 * accessor chain included: a withheld binding is `CEL_UNKNOWN_IDENTIFIER`, a
 * withheld member `CEL_UNKNOWN_FIELD`, each saying why.
 *
 * It travels through `x-telo-context-from-referrer` like any other typing: the
 * referrer's node replaces the annotated node's keywords, mark included, so a
 * pane placed in a composite's region inherits the composite's refusal of
 * `request`, and the message names the referrer that withholds it.
 *
 * Written on a binding beside `x-telo-context-eval`, `title` and `description`
 * only, or in a `$defs` entry a binding names by `$ref` — read as if written
 * on the binding (the context reader follows that `$ref`). This file is the
 * one reader of the value and its strict half.
 *
 * Browser-safe: no Node built-ins.
 */
import { CONTEXT_EVAL } from "./context-eval.js";
import { schemaReferenceParts } from "./schema-reference.js";

export const CONTEXT_WITHHELD = "x-telo-context-withheld";

type Schema = Record<string, any>;

const isSchema = (node: unknown): node is Schema =>
  !!node && typeof node === "object" && !Array.isArray(node);

/** The keys a withheld node may carry beside the mark. */
const BESIDE: ReadonlySet<string> = new Set([CONTEXT_WITHHELD, CONTEXT_EVAL, "title", "description"]);

/** Why `node` is withheld, or undefined. A node `withNull` wrapped
 *  (`{ anyOf: [node, { type: null }] }`) is still the node it wraps. */
export function withheldReason(node: unknown): string | undefined {
  if (!isSchema(node)) return undefined;
  const value = node[CONTEXT_WITHHELD];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) {
      const reason = withheldReason(branch);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

/** One withheld node of a context: its location — the binding, then each
 *  member through `properties` — and why. */
export interface WithheldNode {
  readonly location: readonly string[];
  readonly reason: string;
}

/** Every withheld node of a resolved context, outermost first; nothing beneath
 *  a withheld node is read. `names`, when given, are the only bindings read —
 *  the ones the site's regions declare, so the kernel globals merged beside
 *  them, which no region marks, are not walked at every site. */
export function withheldNodes(
  context: Schema | null | undefined,
  names?: Iterable<string>,
): WithheldNode[] {
  const out: WithheldNode[] = [];
  const visit = (node: unknown, location: readonly string[]): void => {
    if (!isSchema(node)) return;
    const reason = withheldReason(node);
    if (reason !== undefined) {
      out.push({ location, reason });
      return;
    }
    if (!isSchema(node.properties)) return;
    for (const [key, child] of Object.entries(node.properties as Schema)) visit(child, [...location, key]);
  };
  const properties = context?.properties;
  if (!isSchema(properties)) return out;
  for (const name of names ?? Object.keys(properties)) {
    if (Object.prototype.hasOwnProperty.call(properties, name)) visit(properties[name], [name]);
  }
  return out;
}

/** The withheld node a chain of member names reads — the first of `chain`'s
 *  prefixes that is one — or undefined. */
export function withheldOnChain(
  withheld: readonly WithheldNode[],
  chain: readonly string[],
): WithheldNode | undefined {
  return withheld.find(
    (node) => node.location.length <= chain.length && node.location.every((step, i) => chain[i] === step),
  );
}

/**
 * The refusal of a read of `node`: `'<name>' is not available here — <holder>
 * withholds it: <reason>` where the mark reached the site through a referrer,
 * `'<name>' is not available here: <reason>` where the site's own region
 * declares it.
 */
export function withheldMessage(node: WithheldNode, holder: string | undefined): string {
  const name = node.location.join(".");
  return holder === undefined
    ? `'${name}' is not available here: ${node.reason}`
    : `'${name}' is not available here — ${holder} withholds it: ${node.reason}`;
}

/**
 * `context` — an `x-telo-context` as written — with each binding or member
 * whose `$ref` names a withheld node read as that node, the binding's own keys
 * kept over it, so the mark is in the context wherever it is read. `resolve`
 * follows a `$ref` from the document the context is written in. Copied only on
 * the way to a rewritten node; `context` itself where none is.
 */
export function withWithheldReferencesRead(
  context: Schema,
  resolve: (ref: string) => unknown,
): Schema {
  const read = (node: unknown): unknown => {
    if (!isSchema(node)) return node;
    if (typeof node.$ref === "string" && namesDefinitionsEntry(node.$ref)) {
      const target = resolve(node.$ref);
      if (withheldReason(target) !== undefined && isSchema(target)) {
        const { $ref: _ref, ...own } = node;
        return { ...target, ...own };
      }
    }
    if (!isSchema(node.properties)) return node;
    let properties: Schema | undefined;
    for (const [key, child] of Object.entries(node.properties as Schema)) {
      const next = read(child);
      if (next !== child) (properties ??= { ...(node.properties as Schema) })[key] = next;
    }
    return properties ? { ...node, properties } : node;
  };
  if (!isSchema(context.properties)) return context;
  let properties: Schema | undefined;
  for (const [name, binding] of Object.entries(context.properties as Schema)) {
    const next = read(binding);
    if (next !== binding) (properties ??= { ...(context.properties as Schema) })[name] = next;
  }
  return properties ? { ...context, properties } : context;
}

/** Whether `ref` points at an entry of a document's `$defs` / `definitions` —
 *  the one place outside a binding the mark may be written — so a reference
 *  naming a whole shape, which is a type, is never read for one. */
function namesDefinitionsEntry(ref: string): boolean {
  return /^#\/(\$defs|definitions)\/[^/]+$/.test(schemaReferenceParts(ref).pointer);
}

export type WithheldProblem =
  | { readonly code: "SCHEMA_VIOLATION"; readonly message: string }
  | { readonly code: "CONTEXT_WITHHELD_INVALID"; readonly message: string };

/**
 * Why the mark on `node` is malformed or misplaced, or undefined. `where` names
 * it as the diagnostic does; `placed` says the node is a binding, a member
 * beneath one, or a `$defs` entry a binding may name.
 */
export function withheldProblem(node: Schema, where: string, placed: boolean): WithheldProblem | undefined {
  const value = node[CONTEXT_WITHHELD];
  if (typeof value !== "string" || value.trim() === "") {
    return {
      code: "SCHEMA_VIOLATION",
      message: `'${where}' says why the binding holds no value here, as a sentence; it must be a non-empty string.`,
    };
  }
  if (!placed) {
    return {
      code: "CONTEXT_WITHHELD_INVALID",
      message:
        `'${where}' is read only on a binding — a property of an 'x-telo-context' — or a member beneath ` +
        `one, so here it withholds nothing.`,
    };
  }
  const beside = Object.keys(node).find((key) => !BESIDE.has(key));
  if (beside !== undefined) {
    return {
      code: "CONTEXT_WITHHELD_INVALID",
      message:
        `'${where}' says the node holds no value here, so '${beside}' beside it types nothing; keep only ` +
        `'${CONTEXT_EVAL}', 'title' and 'description' beside it.`,
    };
  }
  return undefined;
}
