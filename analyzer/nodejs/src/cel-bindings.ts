import { isCompiledValue } from "@telorun/sdk";
import { buildCelEnvironment, extractAccessChains } from "@telorun/templating";
import { extractContextsFromSchema } from "./validate-cel-context.js";

/** Annotation on an `x-telo-context` node naming the resource field that holds
 *  the kind's named CEL bindings. The field is read from the RESOURCE ROOT, not
 *  the per-scope manifest item: a bindings map belongs to the resource, while the
 *  contexts that see it may be anchored anywhere (a decision table annotates both
 *  `choices` and `default`). */
export const BINDINGS_ANNOTATION = "x-telo-bindings-from";

export interface BindingSites {
  /** Resource field holding the bindings map. */
  field: string;
  /** Every field named by an annotation on this kind. More than one is a
   *  kind-authoring mistake: which of them holds the bindings would be decided
   *  by schema walk order. */
  fields: string[];
  /** Variable names the annotated contexts declare — a binding may not shadow one. */
  scopeNames: Set<string>;
}

// CEL keywords live in `identifier-name.ts` — a binding named after one is
// unreachable for exactly the reason a resource or step named after one is, so
// the list belongs to the identifier vocabulary rather than to this file.

/** Locate a kind's bindings field and the scope names its annotated contexts
 *  declare. Returns undefined for a kind that declares no bindings region. */
export function findBindingSites(
  definitionSchema: Record<string, any> | undefined,
): BindingSites | undefined {
  if (!definitionSchema) return undefined;
  const fields: string[] = [];
  const scopeNames = new Set<string>();
  for (const { schema } of extractContextsFromSchema(definitionSchema)) {
    const declared = schema?.[BINDINGS_ANNOTATION];
    if (typeof declared !== "string" || declared.length === 0) continue;
    if (!fields.includes(declared)) fields.push(declared);
    for (const name of Object.keys(schema.properties ?? {})) scopeNames.add(name);
  }
  return fields.length > 0 ? { field: fields[0]!, fields, scopeNames } : undefined;
}

const TEMPLATE_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_RE = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/** Parser for expressions that reach here uncompiled. Built once; the base
 *  environment is stateless and shared with the runtime's own. */
let parseEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/**
 * Root identifiers an expression source reads — the first element of every
 * member-access chain, which is what a dependency edge is made of.
 *
 * Parsed, never lexed: `inputs.total` reads `inputs`, not `total`, and a name
 * inside a string literal reads nothing. A token scan would make two bindings
 * named after each other's *fields* look mutually recursive and reject a correct
 * manifest — the worst outcome a static check has. An expression that does not
 * parse contributes no edges; its syntax error is the engine pass's to report.
 */
function addRootIdentifiers(source: string, out: Set<string>): void {
  try {
    parseEnv ??= buildCelEnvironment();
    for (const chain of extractAccessChains(parseEnv.parse(source).ast)) {
      if (chain.length > 0) out.add(chain[0]!);
    }
  } catch {
    // Unparseable — see above.
  }
}

/** Root identifiers a binding's value reads. Walks the whole value so a
 *  structured binding (a map with `!cel` leaves) is covered, and reads both a
 *  compiled expression and a still-raw `${{ }}` string — the editor's
 *  round-trip view never compiles. An untagged plain string is a literal, not
 *  an expression, and contributes nothing. */
function collectRefs(value: unknown, out: Set<string>): void {
  if (isCompiledValue(value)) {
    const refs = (value as { refs?: readonly string[] }).refs;
    if (refs) for (const ref of refs) out.add(ref);
    else addRootIdentifiers((value as { source?: string }).source ?? "", out);
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE_RE)) addRootIdentifiers(match[1]!, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRefs(entry, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectRefs(entry, out);
  }
}

/** Each binding's dependencies, restricted to its siblings — an identifier that
 *  names something else in scope (`inputs`, `item`) is not an edge. */
export function bindingDependencies(
  bindings: Record<string, unknown>,
): Map<string, Set<string>> {
  const names = new Set(Object.keys(bindings));
  const deps = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(bindings)) {
    const refs = new Set<string>();
    collectRefs(value, refs);
    const own = new Set<string>();
    for (const ref of refs) if (names.has(ref)) own.add(ref);
    deps.set(name, own);
  }
  return deps;
}

/** Member-access chain for a binding whose value is one bare dotted identifier
 *  expression (`inputs.user.name`). Null for anything else — a literal, a call,
 *  a comprehension, a structured value — none of which reduces to a typed path. */
export function bindingPathChain(value: unknown): string[] | null {
  let source: string | undefined;
  if (isCompiledValue(value)) source = (value as { source?: string }).source;
  else if (typeof value === "string") source = value.match(EXACT_TEMPLATE_RE)?.[1];
  if (source === undefined) return null;
  const expr = source.trim();
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(expr)) return null;
  return expr.split(".");
}

/**
 * The context properties a bindings map contributes: each name typed from its
 * expression where that expression is a chain into an already-typed scope
 * variable, and left open otherwise.
 *
 * Gradual by design — the same stance `x-telo-context-element-from` takes. An
 * open schema costs a missed `CEL_UNKNOWN_FIELD` under that name; inventing a
 * type would cost a false one.
 */
export function bindingContextProperties(
  bindings: Record<string, unknown>,
  contextSchema: Record<string, any>,
): Record<string, any> {
  const props: Record<string, any> = {};
  for (const [name, value] of Object.entries(bindings)) {
    props[name] = schemaAtChain(bindingPathChain(value), contextSchema) ?? {};
  }
  return props;
}

/** Walk a member-access chain through a schema's `properties`, returning the
 *  terminal node or undefined once the path leaves typed schema. */
export function schemaAtChain(
  chain: string[] | null,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (!chain) return undefined;
  let current: Record<string, any> | undefined = root;
  for (const key of chain) {
    const props = current?.properties as Record<string, any> | undefined;
    if (!props || !(key in props)) return undefined;
    current = props[key] as Record<string, any>;
  }
  return current && typeof current === "object" ? current : undefined;
}

/**
 * Evaluation order derived from the reference graph, plus any cycles found.
 *
 * Order is what the editor and diagnostics show; the runtime does not need it,
 * since lazy evaluation reaches a binding's dependencies by construction. A
 * cycle is reported as the path that closes it (`a → b → a`).
 */
export function resolveBindingOrder(bindings: Record<string, unknown>): {
  order: string[];
  cycles: string[][];
} {
  const deps = bindingDependencies(bindings);
  const order: string[] = [];
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (name: string): void => {
    const seen = state.get(name);
    if (seen === "done") return;
    if (seen === "visiting") {
      cycles.push([...path.slice(path.indexOf(name)), name]);
      return;
    }
    state.set(name, "visiting");
    path.push(name);
    for (const dep of deps.get(name) ?? []) visit(dep);
    path.pop();
    state.set(name, "done");
    order.push(name);
  };

  for (const name of Object.keys(bindings)) visit(name);
  return { order, cycles };
}
