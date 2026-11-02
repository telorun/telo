import type { ResourceDefinition } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import {
  ancestorChain,
  controllerBearingAncestor,
  resolveParent,
  type DefResolver,
} from "./extends-resolution.js";
import { ITEMS, MAP_VALUES, reachOfSchema, type Pattern } from "./reference-reach.js";
import { readBaseMapping } from "./template-forward.js";

/**
 * The configuration a resource's controller receives, read statically — what a
 * walk asking what the resource DRIVES walks, since what it drives is what that
 * configuration names.
 *
 * A kind with its own controller, or inheriting one with no mapping, hands the
 * declaration on as written, under the kind's author schema. A kind whose chain
 * maps its configuration (`base:`) hands on what each mapping builds — every
 * verbatim `self.<path>` forward replaced by what the declaration holds there —
 * under the author schema of the kind the mapping builds for.
 */
export interface ControllerConfiguration {
  schema: Record<string, any> | undefined;
  data: unknown;
  /** True when an expression a mapping computes sits at or above a slot through
   *  which the resource drives another — what it names there is not known. */
  computedAboveSlot: boolean;
  /** The module that wrote a reference or step list a mapping holds, which a
   *  name in it resolves in; undefined for what the declaration wrote. */
  writerOf(value: unknown): string | undefined;
}

const COMPUTED: unique symbol = Symbol("telo.mapping.computed");

export function controllerConfiguration(
  manifest: unknown,
  definition: ResourceDefinition,
  resolveDef: DefResolver,
  authorSchemaOf: (definition: ResourceDefinition) => Record<string, any> | undefined,
): ControllerConfiguration {
  const writers = new WeakMap<object, string>();
  let def = definition;
  let data = manifest;
  const seen = new Set<ResourceDefinition>();
  let mapped = false;
  for (let mapper = mapperOf(def, resolveDef); mapper && !seen.has(mapper); mapper = mapperOf(def, resolveDef)) {
    seen.add(mapper);
    mapped = true;
    const parent = resolveParent(mapper, resolveDef);
    if (!parent) break;
    const writer = (mapper.metadata as { module?: string } | undefined)?.module;
    const from = data;
    data = readBaseMapping((mapper as { base?: unknown }).base, {
      forward: (path) => valueAt(from, path),
      opaque: (value) => {
        if (!isRefSentinel(value)) return COMPUTED;
        if (writer && value && typeof value === "object") writers.set(value, writer);
        return value;
      },
      hold: (container) => {
        if (writer) writers.set(container, writer);
      },
    });
    def = parent;
  }
  const schema = authorSchemaOf(def);
  return {
    schema,
    data,
    computedAboveSlot: mapped && schema !== undefined && computedPlaces(data).some((at) => drivesBelow(schema, at)),
    writerOf: (value) => (value && typeof value === "object" ? writers.get(value) : undefined),
  };
}

/** The definition whose `base:` maps the configuration `def`'s controller
 *  receives — the first along the chain, `def` first, before the ancestor whose
 *  controller creates the resource. */
function mapperOf(def: ResourceDefinition, resolveDef: DefResolver): ResourceDefinition | undefined {
  const controlling = controllerBearingAncestor(def, resolveDef);
  if (!controlling || (def as { extends?: unknown }).extends === undefined) return undefined;
  for (const d of [def, ...ancestorChain(def, resolveDef)]) {
    if (d === controlling) return undefined;
    if ((d as { base?: unknown }).base != null) return d;
  }
  return undefined;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function computedPlaces(data: unknown): (string | number)[][] {
  const out: (string | number)[][] = [];
  const walk = (value: unknown, at: (string | number)[]) => {
    if (value === COMPUTED) out.push(at);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...at, i]));
    else if (value && typeof value === "object" && !isRefSentinel(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, [...at, key]);
    }
  };
  walk(data, []);
  return out;
}

/** True when the schema declares a step or reference slot at `at` or below it. */
function drivesBelow(schema: Record<string, any>, at: readonly (string | number)[]): boolean {
  for (const place of reachOfSchema(schema).paths.values()) {
    if (place.steps.length === 0 && place.refs.length === 0) continue;
    if (startsWith(place.pattern, at)) return true;
  }
  return false;
}

function startsWith(pattern: Pattern, at: readonly (string | number)[]): boolean {
  if (at.length > pattern.length) return false;
  return at.every((key, i) => {
    const segment = pattern[i];
    if (segment === ITEMS) return typeof key === "number";
    if (segment === MAP_VALUES) return typeof key === "string";
    return segment === key;
  });
}
