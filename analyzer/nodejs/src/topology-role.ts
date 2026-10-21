/**
 * The single reader of `x-telo-topology-role` — the annotation naming a field's
 * structural part in its kind: a step body and how its statements nest, an
 * ordered entry list and what identifies and dispatches each entry. The call
 * graph, the step walk, the module graph, the call-site check and every editor
 * surface recognise a role here and nowhere else, the one-accessor rule
 * `ref-slot.ts` established for `x-telo-ref`. Browser-safe: no Node built-ins.
 *
 * The vocabulary is CLOSED: a value outside {@link TOPOLOGY_ROLES} reads as no
 * role, and the strict half (`validate-topology-roles.ts`) warns about it, as
 * it warns about a `matcher` written where nothing reads one.
 */

import { propertySchemas, resolveLocalRef } from "./manifest-navigation.js";

const ROLE_KEY = "x-telo-topology-role";

/**
 * Every role a field may carry:
 *
 *  - `steps` — the array holding a kind's step body.
 *  - `invoke` / `inputs` — a step's dispatch target and its argument map.
 *  - `predicate` / `discriminator` — what a control-flow statement turns on.
 *  - `branch` / `case-map` / `branch-list` — how statements nest: an array of
 *    steps, a map of step arrays, a list of objects carrying further roles.
 *  - `entries` — an ordered list of dispatch entries (routes, mounts).
 *  - `matcher` — what identifies an entry, or every trigger slot at a kind's
 *    top level outside its entry lists.
 *  - `handler` — the reference an entry dispatches to.
 */
export const TOPOLOGY_ROLES = [
  "steps",
  "invoke",
  "inputs",
  "predicate",
  "discriminator",
  "branch",
  "case-map",
  "branch-list",
  "entries",
  "matcher",
  "handler",
] as const;

export type TopologyRole = (typeof TOPOLOGY_ROLES)[number];

const ROLES: ReadonlySet<string> = new Set(TOPOLOGY_ROLES);

/** The role a schema node declares, or undefined for none or a value outside
 *  the closed vocabulary. */
export function topologyRoleOf(schema: unknown): TopologyRole | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const role = (schema as Record<string, unknown>)[ROLE_KEY];
  return typeof role === "string" && ROLES.has(role) ? (role as TopologyRole) : undefined;
}

/** What a schema node writes as its role when that is outside the closed
 *  vocabulary — `{ value }`, so a written `null` is told from none — or
 *  undefined when it writes none or a role. */
export function unknownTopologyRole(schema: unknown): { value: unknown } | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(schema, ROLE_KEY)) return undefined;
  const value = (schema as Record<string, unknown>)[ROLE_KEY];
  return topologyRoleOf(schema) ? undefined : { value };
}

/** The node carrying a property's role: the property's own schema, else the
 *  local `$defs` entry it points at. */
function roleNode(
  propSchema: Record<string, any> | undefined,
  root: Record<string, any>,
): Record<string, any> | undefined {
  if (topologyRoleOf(propSchema)) return propSchema;
  const resolved = resolveLocalRef(propSchema, root);
  return resolved !== propSchema && topologyRoleOf(resolved) ? resolved : undefined;
}

/** A property of an object schema carrying a role, with the node the
 *  annotation is written on. */
export interface RoledProperty {
  name: string;
  role: TopologyRole;
  node: Record<string, any>;
}

/** Every property of `schema` — its own `properties` and each root variant's —
 *  carrying a role. */
export function roledProperties(
  schema: Record<string, any> | undefined,
  root: Record<string, any> = schema ?? {},
): RoledProperty[] {
  if (!schema) return [];
  const out: RoledProperty[] = [];
  for (const [name, propSchema] of propertySchemas(schema)) {
    const node = roleNode(propSchema, root);
    if (node) out.push({ name, role: topologyRoleOf(node)!, node });
  }
  return out;
}

/** One `entries` list a kind declares at its top level. */
export interface EntryListDeclaration {
  /** The top-level property holding the list. */
  field: string;
  /** The schema of one entry, local `$ref` resolved. */
  items: Record<string, any> | undefined;
  /** Entry properties identifying an entry to a reader. */
  matchers: string[];
  /** Entry properties holding what the entry dispatches to. */
  handlers: string[];
  /** The annotated nodes of {@link matchers}, in the same order. */
  matcherNodes: Record<string, any>[];
}

/** Every top-level property declaring `entries`, with the roles its items
 *  carry. No kind is named: a third-party router declaring the same tokens is
 *  read identically. */
export function entryListsOf(rootSchema: Record<string, any> | undefined): EntryListDeclaration[] {
  if (!rootSchema) return [];
  const out: EntryListDeclaration[] = [];
  for (const { name, role, node } of roledProperties(rootSchema)) {
    if (role !== "entries") continue;
    const items = resolveLocalRef(node.items as Record<string, any> | undefined, rootSchema);
    const matchers: string[] = [];
    const matcherNodes: Record<string, any>[] = [];
    const handlers: string[] = [];
    for (const entry of roledProperties(items, rootSchema)) {
      if (entry.role === "matcher") {
        matchers.push(entry.name);
        matcherNodes.push(entry.node);
      } else if (entry.role === "handler") handlers.push(entry.name);
    }
    out.push({ field: name, items, matchers, handlers, matcherNodes });
  }
  return out;
}

/** Top-level properties declaring `matcher` — what labels every trigger slot of
 *  the resource outside its entry lists. */
export function rootMatchersOf(rootSchema: Record<string, any> | undefined): RoledProperty[] {
  return roledProperties(rootSchema).filter((p) => p.role === "matcher");
}
