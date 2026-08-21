/**
 * **What a name means inside a CEL expression.**
 *
 * The TYPE half of CEL language support — completion's candidate list and
 * hover's tooltip are both this, read off the scope the analyzer resolved. It
 * is deliberately separate from the DECLARATION half (`definition/`), which
 * answers where a name was written: the two take different inputs and
 * legitimately disagree. `steps.encode.result` has a type and no manifest node
 * to jump to; a transport binding like `request` has a scope entry and no
 * declaration at all. Joining them is hover's job, not this module's.
 */
import type { CelScope } from "@telorun/analyzer";
import { navigateSchema } from "../completions/detect-context.js";

/** One name in scope, with whatever the scope knows about it. Both `type` and
 *  `schema` are optional and neither implies the other: a CEL environment
 *  variable carries a type and no schema, a context property carries a schema
 *  and gets its type from it. */
export interface CelSymbol {
  name: string;
  /** CEL type name (`int`, `string`, `map`), when the environment declares one. */
  type?: string;
  /** JSON Schema node, when the context declares the shape. */
  schema?: Record<string, any>;
  description?: string;
}

/**
 * One callable, with every overload the environment registered for it.
 *
 * Grouped rather than one entry per overload: the registry declares a signature
 * per accepted argument list — `double` has four — and offering each as its own
 * candidate turns a completion list into four identical labels the author
 * cannot choose between. What varies between them is the signature, so that is
 * what the grouped entry carries.
 */
export interface CelFunctionSymbol {
  name: string;
  /** Every registered overload's signature, in registration order. */
  signatures: string[];
  /** The type a receiver-style call is made ON (`string.startsWith`), or null
   *  for a global function. Part of the grouping key, since a global and a
   *  method sharing a name are genuinely two callables. */
  receiverType: string | null;
  /** The first description any overload carries — they describe the function,
   *  not the individual argument list. */
  description?: string;
}

/** The type a schema node declares, rendered for display. Unions are joined
 *  rather than collapsed — a slot admitting several shapes says so. */
export function schemaTypeName(schema: Record<string, any> | undefined): string | undefined {
  if (!schema) return undefined;
  const valueType = schema["x-telo-type"];
  if (typeof valueType === "string") return valueType;
  if (valueType && typeof valueType === "object" && typeof valueType.name === "string") {
    return valueType.name;
  }
  const t = schema.type;
  if (Array.isArray(t)) return t.join(" | ");
  if (typeof t === "string") return t;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const branches = (schema.anyOf ?? schema.oneOf) as Record<string, any>[];
    const names = branches.map((b) => schemaTypeName(b)).filter(Boolean);
    if (names.length > 0) return [...new Set(names)].join(" | ");
  }
  return undefined;
}

/** The context's property map, or an empty one when the site is typed by the
 *  environment alone. */
function contextProperties(scope: CelScope): Record<string, any> {
  const props = scope.contextSchema?.properties;
  return props && typeof props === "object" ? (props as Record<string, any>) : {};
}

/**
 * The names an expression may start with.
 *
 * Both sources, because neither is complete: the context schema carries the
 * scope's own bindings (`steps`, `error`, a kind's named bindings, a transport's
 * `request`), while the environment carries what was registered onto it
 * directly — which is where the kernel globals live when no context applied.
 * A name in both takes its schema from the context, which is the narrower.
 */
export function celRootSymbols(scope: CelScope): CelSymbol[] {
  const out = new Map<string, CelSymbol>();
  for (const variable of scope.env.getDefinitions().variables) {
    out.set(variable.name, {
      name: variable.name,
      type: variable.type,
      description: variable.description ?? undefined,
    });
  }
  for (const [name, schema] of Object.entries(contextProperties(scope))) {
    const node = schema as Record<string, any>;
    out.set(name, {
      name,
      type: schemaTypeName(node) ?? out.get(name)?.type,
      schema: node,
      description:
        typeof node.description === "string" ? node.description : out.get(name)?.description,
    });
  }
  return [...out.values()];
}

/** The schema at a dotted path from the scope root, or undefined when the path
 *  leaves what the context declares. Navigation is the shared schema walk, so a
 *  member reached through an array, a `$ref` or an `anyOf` branch resolves the
 *  same way it does for a structural field. */
function schemaAtPath(scope: CelScope, parts: string[]): Record<string, any> | undefined {
  if (parts.length === 0) return scope.contextSchema ?? undefined;
  const root = contextProperties(scope)[parts[0]] as Record<string, any> | undefined;
  if (!root) return undefined;
  if (parts.length === 1) return root;
  return navigateSchema(root, parts.slice(1));
}

/**
 * The members available after `prefix`.
 *
 * Empty when the prefix resolves to nothing OR to something whose shape the
 * scope does not declare — an open node, a live value, a permissive contract.
 * That is the honest answer: offering a guess here would be offering names the
 * checker has no opinion about, which is exactly what the shared scope rule
 * exists to prevent.
 */
export function celMemberSymbols(scope: CelScope, prefix: string[]): CelSymbol[] {
  if (prefix.length === 0) return celRootSymbols(scope);
  const node = schemaAtPath(scope, prefix);
  const props = node?.properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props as Record<string, any>).map(([name, raw]) => {
    const child = raw as Record<string, any>;
    return {
      name,
      type: schemaTypeName(child),
      schema: child,
      description: typeof child.description === "string" ? child.description : undefined,
    };
  });
}

/** What the chain `parts` resolves to — used for hover, where the cursor sits on
 *  one identifier of a complete chain and the symbol wanted is the one at that
 *  identifier, not at the chain's tail. */
export function celSymbolAt(scope: CelScope, parts: string[]): CelSymbol | undefined {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) {
    return celRootSymbols(scope).find((s) => s.name === parts[0]);
  }
  const schema = schemaAtPath(scope, parts);
  if (!schema) return undefined;
  return {
    name: parts[parts.length - 1],
    type: schemaTypeName(schema),
    schema,
    description: typeof schema.description === "string" ? schema.description : undefined,
  };
}

/**
 * The callables the environment declares, one entry per function.
 *
 * Read off `getDefinitions()` rather than a curated list, exactly as the call
 * classifier does — so a function the registry gained is offered without this
 * module being told, and one it never had is never offered. Overloads are
 * folded into their function; see {@link CelFunctionSymbol}.
 */
export function celFunctions(scope: CelScope): CelFunctionSymbol[] {
  const byKey = new Map<string, CelFunctionSymbol>();
  for (const fn of scope.env.getDefinitions().functions) {
    const key = `${fn.receiverType ?? ""}.${fn.name}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.signatures.includes(fn.signature)) existing.signatures.push(fn.signature);
      existing.description ??= fn.description ?? undefined;
      continue;
    }
    byKey.set(key, {
      name: fn.name,
      signatures: [fn.signature],
      receiverType: fn.receiverType,
      description: fn.description ?? undefined,
    });
  }
  return [...byKey.values()];
}
