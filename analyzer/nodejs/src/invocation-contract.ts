import { isLiveSlot, type ResourceDefinition } from "@telorun/sdk";
import {
  type ContractDirection,
  contractDeclarer,
  type DefResolver,
  effectiveContractField,
} from "./extends-resolution.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

export type { ContractDirection };

/**
 * The one answer to "what is this target's input / output schema".
 *
 * Both halves of Telo consume it: `telo check` validates call sites against it,
 * and the kernel binds it to the instance at creation. It lives here rather than
 * in the kernel because it must be browser-safe and because a second
 * implementation would drift — the same split already used for
 * `buildEvalPaths` / `evalPathCovers` and the redaction path parser. Before this
 * there were three one-hop lookups (the analysis registry's editor helpers, the
 * template-body `inputs` typing, the step-context definition fallback) and a
 * runtime that consulted only an explicitly-passed type ref, so static analysis
 * and dispatch could disagree about the very contract they were both checking.
 */

/** Where a resolved contract was declared. Instance-level declarations let one
 *  call site narrow a kind's contract (`JS.Script` does this); kind-level ones
 *  are the kind's own signature. */
export type ContractOrigin = "instance" | "kind";

export interface ResolvedContract {
  /** The JSON Schema a value is validated against. */
  schema: Record<string, any>;
  origin: ContractOrigin;
  /** The definition that declared it, when `origin` is `"kind"` — the scope its
   *  named type references resolved in, and what a diagnostic should name. */
  declaredBy?: ResourceDefinition;
}

export interface ContractScope {
  /** Resolves a kind to its definition. Must be scoped to the module that
   *  DECLARED the definition being walked — `extends` aliases are lexical, so a
   *  chain crossing module boundaries re-scopes at each hop. */
  resolveDefinition: DefResolver;
  /**
   * Manifests a named `telo#Type` reference resolves against, given the
   * definition that DECLARED the type field.
   *
   * The parameter exists for a caller that keeps types per module. The analyzer
   * does not: it works from one flattened list where names are already unique
   * per module, so it ignores the argument and returns that list. A caller
   * holding several scopes uses it to avoid resolving a bare name against the
   * wrong module's type of the same name.
   */
  typeManifestsFor(def: ResourceDefinition | undefined): Record<string, any>[];
}

/** The fallback for a target that declares no contract: anything goes. Not
 *  `additionalProperties: false` — an undeclared contract is an absence of a
 *  claim, not a claim of emptiness. */
export const PERMISSIVE_CONTRACT: Record<string, any> = {
  type: "object",
  additionalProperties: true,
};

/**
 * Resolve a dispatch target's contract, layering:
 *   1. the **instance manifest's** own `inputType:` / `outputType:` — per-call-site
 *      narrowing, opted into simply by the kind declaring the property;
 *   2. the **kind's** contract, resolved to the nearest declaration along
 *      `extends` (see {@link effectiveContractField} — nearest wins, no merge);
 *   3. undefined — the caller decides whether that means permissive.
 *
 * Returns undefined rather than {@link PERMISSIVE_CONTRACT} so a caller can tell
 * "declared nothing" from "declared anything", which the wiring rule and the
 * `run()` guard both need.
 */
export function resolveContract(
  direction: ContractDirection,
  manifest: Record<string, any> | undefined,
  definition: ResourceDefinition | undefined,
  scope: ContractScope,
): ResolvedContract | undefined {
  const own = manifest?.[direction];
  if (own !== undefined && own !== null) {
    const schema = resolveTypeFieldToSchema(own, scope.typeManifestsFor(definition));
    if (schema) return { schema, origin: "instance" };
  }

  const declared = effectiveContractField(definition, scope.resolveDefinition, direction);
  if (declared === undefined || declared === null) return undefined;
  const declarer = contractDeclarer(definition, scope.resolveDefinition, direction);
  const schema = resolveTypeFieldToSchema(declared, scope.typeManifestsFor(declarer));
  if (!schema) return undefined;
  return { schema, origin: "kind", declaredBy: declarer };
}

/** {@link resolveContract}, falling back to {@link PERMISSIVE_CONTRACT}. For
 *  callers that need a schema unconditionally (CEL context typing), as opposed
 *  to needing to know whether one was declared. */
export function resolveContractSchema(
  direction: ContractDirection,
  manifest: Record<string, any> | undefined,
  definition: ResourceDefinition | undefined,
  scope: ContractScope,
): Record<string, any> {
  return resolveContract(direction, manifest, definition, scope)?.schema ?? PERMISSIVE_CONTRACT;
}

/**
 * A copy of `schema` with every `live`-typed node left unconstrained, for
 * validating a runtime value against.
 *
 * Live values travel in BOTH directions — `Codec.Encoder` declares a stream on
 * its `inputType` and lists it in `required`, and `Record.Stream`, `Ai`, `Tar`
 * and `Console` do the same — so a one-directional skip would walk a live
 * `Stream` with AJV on the hottest path in the runtime. That is the same defect
 * as `stripCompiledValues` walking a live `ResourceInstance` in a ref slot: a
 * live object in a declared slot is not data to be traversed.
 *
 * EXEMPTION IS A PROPERTY OF THE TYPE, not of a position. This used to neutralize
 * only a key it found in a `properties` map, so an array-OF-streams element was
 * reached and left constrained even though the walk descended into `items`.
 * Reading the exemption off the declared value type makes an item, a union branch
 * and a property the same case, and it is one rule instead of three.
 *
 * The exemption is from VALIDATION, never from TYPING: a live type's declared
 * arguments still travel through every schema-typing walk the analyzer performs.
 *
 * Structural (returns a new object, never mutates), and shared so the analyzer
 * and the kernel exempt the same set.
 */
export function withLiveValuesSkipped(
  schema: Record<string, any>,
  /** Resolves a `$ref` to the schema it names. Required to see through the
   *  reference form the runtime deliberately KEEPS intact for its validator: a
   *  contract written as `{ $ref: "telo:mod/Type" }` has none of its own
   *  properties, so a walk that cannot follow the reference exempts nothing and
   *  the live value is traversed after all. */
  resolveRef?: (ref: string) => Record<string, any> | undefined,
): Record<string, any> {
  return stripLive(schema, [], resolveRef);
}

function stripLive(
  node: unknown,
  // A PATH-scoped guard, not a global memo: a schema object reached twice from
  // different parents must be stripped twice (a global `seen` would hand the
  // second parent the unstripped original), while a cycle must still terminate.
  path: readonly object[],
  resolveRef?: (ref: string) => Record<string, any> | undefined,
): any {
  if (Array.isArray(node)) {
    let changed = false;
    const items = node.map((item) => {
      const next = stripLive(item, path, resolveRef);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : node;
  }
  if (!node || typeof node !== "object") return node;
  let schema = node as Record<string, any>;
  if (path.includes(schema)) return schema;

  // The one rule. An empty schema leaves the node DECLARED but unconstrained,
  // rather than deleted: deleting a property would force `additionalProperties:
  // false` open, and a closed contract would stop rejecting unknown keys the
  // moment it grew a stream — trading one exemption for a hole across the whole
  // shape. `required` is untouched for the same reason: a live value IS present,
  // it is only not walked.
  if (isLiveSlot(schema)) return {};

  // Follow a whole-document reference to SEE the annotations behind it, but
  // return the original node when nothing behind it was stripped. Substituting
  // the resolved target unconditionally would break schema identity — the
  // compiled-validator cache is keyed on it — and would move the target out of
  // the document whose `$defs` its own internal `$ref`s resolve against.
  if (resolveRef && typeof schema.$ref === "string") {
    const target = resolveRef(schema.$ref);
    if (target && !path.includes(target)) {
      const stripped = stripLive(target, [...path, schema], resolveRef);
      if (stripped === target) return node;
      const { $ref: _ref, ...siblings } = schema;
      return Object.keys(siblings).length > 0 ? { ...stripped, ...siblings } : stripped;
    }
  }
  const here = [...path, schema];

  // Recurse: a live value one level down (a property, an item, a branch, a
  // nested object) is as live as one at the root, and walking it with AJV is the
  // same defect. Each is neutralized by the single rule above when the walk
  // reaches it.
  //
  // `properties` and `$defs` are MAPS of schemas, not schemas — descending into
  // them as if they were would visit nothing, since a map has none of the
  // keywords this walk looks for.
  let changed = false;
  const result: Record<string, any> = { ...schema };
  for (const key of ["properties", "$defs"] as const) {
    const map = schema[key] as Record<string, any> | undefined;
    if (!map || typeof map !== "object") continue;
    let mapChanged = false;
    const next: Record<string, any> = {};
    for (const [name, child] of Object.entries(map)) {
      const stripped = stripLive(child, here, resolveRef);
      if (stripped !== child) mapChanged = true;
      next[name] = stripped;
    }
    if (mapChanged) {
      result[key] = next;
      changed = true;
    }
  }
  for (const key of ["items", "allOf", "anyOf", "oneOf"] as const) {
    const child = schema[key];
    if (child === undefined) continue;
    const next = stripLive(child, here, resolveRef);
    if (next !== child) {
      result[key] = next;
      changed = true;
    }
  }
  return changed ? result : schema;
}

/** Every property path in `schema` that can receive a `default:` — the paths a
 *  defaults pass may write to, and therefore exactly how far the caller's inputs
 *  must be copied before AJV's `useDefaults` runs. A flat shallow copy would not
 *  do: `useDefaults` writes at every level it finds a default, so a nested
 *  default would mutate the structure the caller still holds. Bounded by the
 *  schema's defaults rather than by the size of the payload. */
export function defaultBearingPaths(
  schema: Record<string, any>,
  /** See {@link withLiveValuesSkipped} — a contract kept in `$ref` form
   *  declares its defaults behind the reference, and a walk that cannot follow
   *  it would report none, leaving the caller's data shared where a fill lands. */
  resolveRef?: (ref: string) => Record<string, any> | undefined,
): string[][] {
  const out: string[][] = [];

  // Path-scoped, for the same reason as the stream walk: a shared subschema
  // reached from two parents contributes a path under each.
  const walk = (node: unknown, path: string[], chain: readonly object[]): void => {
    if (!node || typeof node !== "object") return;
    let s = node as Record<string, any>;
    if (chain.includes(s)) return;
    if (resolveRef && typeof s.$ref === "string") {
      const target = resolveRef(s.$ref);
      if (!target || chain.includes(target)) return;
      s = { ...target, ...s, $ref: undefined };
    }
    const here = [...chain, node as object];

    if ("default" in s && path.length > 0) out.push(path);

    const properties = s.properties as Record<string, any> | undefined;
    if (properties) {
      for (const [key, child] of Object.entries(properties)) walk(child, [...path, key], here);
    }
    for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
      const list = s[branch];
      if (Array.isArray(list)) for (const child of list) walk(child, path, here);
    }
    if (s.items) walk(s.items, [...path, "[]"], here);
  };

  walk(schema, [], []);
  return out;
}
