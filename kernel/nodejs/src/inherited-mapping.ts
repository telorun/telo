import type { CompiledValue, ResourceDefinition, ResourceInstance } from "@telorun/sdk";
import { isCelRecord, isCompiledValue, refSentinelTarget, RuntimeError } from "@telorun/sdk";
import {
  ancestorChain,
  controllerBearingAncestor,
  isResolvedReference,
  SELF_PATH,
  type DefResolver,
} from "@telorun/analyzer";
import { resolveReference } from "./dependency-injection.js";
import type { EvaluationContext } from "./evaluation-context.js";
import { isWithinSlot } from "./controllers/resource-definition/step-value-slots.js";

/**
 * The mappings an inheriting kind writes — `base:`, which builds the
 * configuration its inherited controller receives, and `inputs:` / `result:`,
 * which translate a replaced contract. Each runs in the scope of the module that
 * wrote it, never the scope of the resource being created.
 */

/**
 * The definition whose `base:` builds the configuration an inheriting kind's
 * controller receives: the first along the chain, the kind itself first, that
 * maps, before the ancestor whose controller creates the resource. Undefined for
 * a kind that does not inherit its controller, or whose chain maps nothing — its
 * resources are created by that controller as they are declared.
 */
export function inheritedMapper(
  definition: ResourceDefinition,
  resolveDef: DefResolver,
): ResourceDefinition | undefined {
  const controlling = controllerBearingAncestor(definition, resolveDef);
  if (!controlling || definition === controlling) return undefined;
  for (const def of [definition, ...ancestorChain(definition, resolveDef)]) {
    if (def === controlling) return undefined;
    if ((def as { base?: unknown }).base != null) return def;
  }
  return undefined;
}

/** One `inputs:` / `result:` mapping of an inheriting kind's chain, with the
 *  scope of the module that wrote it. */
export interface InheritedLayer {
  definition: ResourceDefinition;
  context: EvaluationContext;
  self: Record<string, unknown>;
  forward: SelfForward;
}

/** Write `value` at `keys` of `root`, copying every container on the way so
 *  nothing `root` shares with a declaration is changed. */
export function withValueAt(
  root: Record<string, unknown>,
  keys: readonly (string | number)[],
  value: unknown,
): void {
  let holder: Record<string | number, unknown> | unknown[] = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    const next: unknown = (holder as Record<string | number, unknown>)[key];
    const copy: Record<string, unknown> | unknown[] = Array.isArray(next) ? [...next] : { ...(next as Record<string, unknown>) };
    (holder as Record<string | number, unknown>)[key] = copy;
    holder = copy;
  }
  (holder as Record<string | number, unknown>)[keys[keys.length - 1]!] = value;
}

/** What a bare `self.<path>` in a mapping reads: the instance's declaration
 *  along that path, reference crossings included. */
export type SelfForward = (keys: readonly string[]) => unknown;

/** `GoogleAuth.GoogleClient (oci://…/telo.yaml)` — the definition a mapping was written in. */
export function mappingOwner(definition: ResourceDefinition): string {
  const source = (definition.metadata as { source?: unknown }).source;
  const kind = `${definition.metadata.module}.${definition.metadata.name}`;
  return typeof source === "string" ? `${kind} (${source})` : kind;
}

/** Where a mapping is evaluated and what it leaves compiled. */
export interface MappingScope {
  /** The context of the module that wrote the mapping. */
  context: EvaluationContext;
  /** The CEL scope beside that module's globals (`self`, `inputs`, `result`). */
  bindings: Record<string, unknown>;
  forward: SelfForward;
  /** `<field> of <definition>`, for a failing expression. */
  owner: string;
  /** Mapping paths whose expressions stay compiled (a step's `value:`), each
   *  bound to {@link context} and `self` wherever it is later evaluated. */
  kept?: readonly string[];
}

/**
 * Expand a mapping node. An expression resolves to its value now, in the
 * mapping's scope; a bare `self.<path>` hands on what the instance declares
 * there (a live instance stays one); an expression under a kept path stays
 * compiled but bound to the mapping's scope; and a reference the mapping writes
 * as a literal becomes the live instance it names in that scope — the
 * controller receiving the result resolves names in the consumer's scope, where
 * the mapping's own names mean nothing or something else.
 */
export function expandMapping(value: unknown, scope: MappingScope, path: string): unknown {
  if (isCompiledValue(value)) {
    if (scope.kept && isWithinSlot(scope.kept, path)) {
      return scope.context.boundExpression(
        value as CompiledValue,
        { self: scope.bindings.self },
        `${path} of ${scope.owner}`,
      );
    }
    const src = typeof value.source === "string" ? value.source.trim() : "";
    const m = src.match(SELF_PATH);
    if (m) return scope.forward(m[1].split(".").slice(1));
    try {
      return scope.context.expandWith(value, scope.bindings);
    } catch (error) {
      if (error instanceof Error) error.message = `in ${path} of ${scope.owner}: ${error.message}`;
      throw error;
    }
  }
  const reference = refSentinelTarget(value) ?? (isResolvedReference(value) ? value : undefined);
  if (reference) return referencedInstance(reference, scope, path);
  if (Array.isArray(value)) {
    return value.map((v, i) => expandMapping(v, scope, `${path}[${i}]`));
  }
  // Asked of the value DOMAIN, never of the prototype: a branded CEL value (an
  // instant, a duration, a uint) is a plain object, and rebuilding one from its
  // entries drops the symbol its brand lives under.
  if (value !== null && typeof value === "object" && isCelRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const expanded = expandMapping(v, scope, `${path}.${k}`);
      // An absent optional stays absent: a key holding `undefined` would read
      // as present to the next level's `has()` and hand CEL a non-value.
      if (expanded !== undefined) out[k] = expanded;
    }
    return out;
  }
  return value;
}

function referencedInstance(
  reference: { name: string; alias?: string },
  scope: MappingScope,
  path: string,
): ResourceInstance {
  const instance = resolveReference(
    reference,
    (name, alias) => scope.context.injectionInstance(name, alias),
    (name) => scope.context.injectionPending(name),
  );
  if (instance) return instance;
  const spelled = reference.alias ? `${reference.alias}.${reference.name}` : reference.name;
  throw new RuntimeError(
    "ERR_REF_UNRESOLVED",
    `in ${path} of ${scope.owner}: \`!ref ${spelled}\` names no resource of the module that wrote it.`,
  );
}

/**
 * Bind a definition's `inputs:` / `result:` mapping onto `instance`, which the
 * inherited controller produced: every dispatch maps the caller's inputs onto
 * the call the controller understands and its result back. Bound in place, so
 * the instance keeps its identity, its lifecycle and its prototype; every
 * argument after the inputs (the InvokeContext) reaches the controller untouched.
 */
export function bindDispatchMapping(
  instance: ResourceInstance,
  definition: ResourceDefinition,
  context: EvaluationContext,
  self: Record<string, unknown>,
  forward: SelfForward,
): void {
  const body = definition as unknown as { inputs?: unknown; result?: unknown };
  const inputsMapping = body.inputs;
  const resultMapping = body.result;
  if (inputsMapping == null && resultMapping == null) return;
  if (typeof instance.invoke !== "function") return;
  const owner = mappingOwner(definition);
  const original = instance.invoke.bind(instance) as (inputs: any, ...rest: unknown[]) => Promise<unknown>;
  instance.invoke = async (inputs: any, ...rest: unknown[]) => {
    const mappedInputs =
      inputsMapping != null
        ? expandMapping(inputsMapping, { context, bindings: { self, inputs }, forward, owner }, "inputs")
        : inputs;
    const result = await original(mappedInputs, ...rest);
    return resultMapping != null
      ? expandMapping(resultMapping, { context, bindings: { self, result }, forward, owner }, "result")
      : result;
  };
}
