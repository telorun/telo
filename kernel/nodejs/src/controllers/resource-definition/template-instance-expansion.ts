import type { CompiledValue, ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  createConsumerExpander,
  emittedInlineName,
  isResolvedReference,
  manifestModuleOf,
  pathText,
  resolvedReference,
  type ConsumerExpansionEnvironment,
  type ExpansionSite,
  type LoopInstance,
  type ReachSite,
  type TemplateBodyExpansion,
} from "@telorun/analyzer";
import { isTaggedSentinel } from "@telorun/templating";
import { celSelfView } from "../../evaluation-context.js";
import { declarationOfInstance, outermostDeclarationOf } from "../../instance-declaration.js";
import type { ModuleContext } from "../../module-context.js";
import { refuseExpansionConstructs } from "../../expansion-refusals.js";
import { crossedDeclaration, forwardedValue, type WrittenScope } from "./reference-crossing.js";

/**
 * A TEMPLATE BODY EXPANDED FOR ONE INSTANCE, at its `init()`.
 *
 * The expansion is the analyzer's (`createConsumerExpander`), the one `telo
 * check` runs for each consumer: this file supplies its seams and raises
 * what it refuses. A refusal is a consumer's value refused at creation, so it is
 * raised as `telo check` words it — one `ERR_MANIFEST_VALIDATION_FAILED`
 * carrying every refusal under its static code — and nothing here decides a
 * choice, reads a collection or fills a default.
 */

export interface InstanceExpansionInputs {
  /** The instance's resource, as it was declared. */
  readonly resource: ResourceManifest;
  /** The template definition the instance runs. */
  readonly definition: ResourceDefinition;
  /** The constructs of the body the position reader accepted. */
  readonly sites: ReadonlyMap<unknown, ExpansionSite>;
  readonly analysis: {
    readonly definitions: ConsumerExpansionEnvironment["registry"];
    readonly aliases: ConsumerExpansionEnvironment["aliases"];
    readonly aliasesByModule: ConsumerExpansionEnvironment["aliasesByModule"];
    readonly readDeclaration: ConsumerExpansionEnvironment["readDeclaration"];
  };
  /** The context that declares the kind: where the library's inputs are read. */
  readonly definingContext: ModuleContext;
  /** The context the instance is declared in. */
  readonly consumerContext: ModuleContext;
  /** Where a reference the instance's own manifest holds is resolved: the
   *  context that owns the instance. */
  readonly instanceScope: WrittenScope;
  readonly referenceSitesOf: (resource: ResourceManifest) => ReachSite[];
  /** The owner a body entry is stamped with. */
  readonly stampDeclaringModule: (entry: any) => any;
}

const bindingsOf = new WeakMap<object, () => Record<string, unknown>>();

/** The loop bindings a compiled expression was closed over, as a CEL scope. */
export function closedBindingsOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? bindingsOf.get(value)?.() : undefined;
}

/**
 * `value` with the loop bindings of `instance` bound into every evaluation, the
 * way `withSelfBound` binds `self`: the child that evaluates it later has no
 * `hook` of its own.
 */
function closeOverBindings(value: CompiledValue, instance: LoopInstance): CompiledValue {
  let scope: Record<string, unknown> | undefined;
  const get = () => (scope ??= liveBindings(instance));
  const closed: CompiledValue = {
    ...value,
    call: (activation: Record<string, unknown>) => {
      const bound = get();
      const previous = new Map<string, PropertyDescriptor | undefined>();
      for (const [name, view] of Object.entries(bound)) {
        previous.set(name, Object.getOwnPropertyDescriptor(activation, name));
        Object.defineProperty(activation, name, {
          value: view,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      try {
        return value.call(activation);
      } finally {
        for (const [name, descriptor] of previous) {
          if (descriptor) Object.defineProperty(activation, name, descriptor);
          else delete activation[name];
        }
      }
    },
  };
  bindingsOf.set(closed, get);
  return closed;
}

/** The bindings of `instance` as an expression evaluated later reads them. */
function liveBindings(instance: LoopInstance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const frame of instance) {
    out[frame.binding.name] = {
      ...(frame.element.key !== undefined ? { key: frame.element.key } : {}),
      index: BigInt(frame.element.index),
      value: celSelfView({ value: frame.element.view ?? frame.element.value }).value,
    };
  }
  return out;
}

export function expandTemplateInstance(inputs: InstanceExpansionInputs): TemplateBodyExpansion {
  const { resource, definition, definingContext, consumerContext } = inputs;
  const expander = createConsumerExpander({
    registry: inputs.analysis.definitions,
    aliases: inputs.analysis.aliases,
    aliasesByModule: inputs.analysis.aliasesByModule,
    readDeclaration: inputs.analysis.readDeclaration,
    declarationAt: (value, at) => {
      if (isResolvedReference(value)) {
        const declaration = crossedDeclaration(value, at.holder, inputs.instanceScope);
        return { declaration, module: declaration ? manifestModuleOf(declaration) : undefined };
      }
      const declaration = outermostDeclarationOf(value) ?? declarationOfInstance(value);
      return declaration ? { declaration, module: manifestModuleOf(declaration) } : undefined;
    },
    emitted: (value, instance, forward) => {
      if (forward) {
        return forwardedValue(
          forward.holder,
          forward.keys,
          inputs.instanceScope,
          inputs.analysis.readDeclaration,
          forward.holder,
        );
      }
      return isCompiledValue(value) ? closeOverBindings(value, instance) : value;
    },
    decidedValue: (holder, source, node) => {
      if (holder === (definition as unknown as ResourceManifest)) {
        // The library's own inputs, `module.<field>` and needs.
        const [root, ...rest] = source.split(".");
        const scope = (definingContext as unknown as Record<string, unknown>)[root!];
        if (scope === undefined) return undefined;
        let cur: any = scope;
        for (const key of rest) cur = cur?.[key];
        return { value: cur === undefined ? null : cur };
      }
      return isCompiledValue(node) && !isTaggedSentinel(node)
        ? { value: consumerContext.expandWith(node, {}) }
        : undefined;
    },
    judgesTargets: () => true,
  });
  const result = expander.expand(resource, definition, inputs.sites);
  refuseExpansionConstructs(expander.records.diagnostics);
  return withExtractedInlines(result.expansion, inputs);
}

/** An inline declaration is not a reference. */
function isInline(value: unknown): value is Record<string, unknown> & { kind: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    !isResolvedReference(value) &&
    !isTaggedSentinel(value) &&
    !isCompiledValue(value)
  );
}

/** A copy of `value` the extraction may rewrite in place, sharing compiled
 *  expressions and live instances. */
function cloneForRewrite(value: unknown): unknown {
  if (value === null || typeof value !== "object" || isCompiledValue(value)) return value;
  if (Array.isArray(value)) return value.map(cloneForRewrite);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneForRewrite(v)]));
}

/**
 * An inline declaration an EMITTED item holds at a reference slot becomes a
 * `resources:` entry of its own, named by the place it is written and the
 * element it was emitted for (`emittedIdentity`, the name the analysis keys
 * it on), and the slot its reference. One written outside an emitted item was
 * extracted when the definition loaded.
 */
function withExtractedInlines(
  expansion: TemplateBodyExpansion,
  inputs: InstanceExpansionInputs,
): TemplateBodyExpansion {
  const resources = (expansion.definition as { resources?: unknown }).resources;
  if (!Array.isArray(resources) || expansion.emitted.length === 0) return expansion;
  const emittedEntries = new Set<number>();
  for (const item of expansion.emitted) {
    if (item.at[0] === "resources" && typeof item.at[1] === "number") emittedEntries.add(item.at[1]);
  }
  if (emittedEntries.size === 0) return expansion;

  const entries = [...resources];
  const queue = [...emittedEntries];
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q]!;
    const entry = inputs.stampDeclaringModule(cloneForRewrite(entries[at])) as ResourceManifest;
    let rewritten = false;
    for (const site of inputs.referenceSitesOf(entry)) {
      if (site.refs.length === 0 || !site.holder || site.key === undefined) continue;
      if (site.refs.some((ref) => ref.slot.uses.includes("schema"))) continue;
      if (!isInline(site.data)) continue;
      const name = emittedInlineName(expansion, ["resources", at, ...site.keys]);
      if (!name) continue;
      const inline = site.data;
      (site.holder as Record<string | number, unknown>)[site.key] = resolvedReference(inline.kind, name);
      entries.push(
        inputs.stampDeclaringModule({
          ...inline,
          metadata: {
            ...((inline.metadata as object | undefined) ?? {}),
            name,
            xTeloOrigin: {
              parentKind: entry.kind,
              parentName: (entry.metadata as { name?: string } | undefined)?.name,
              pathFromParent: pathText(site.keys),
              keysFromParent: site.keys,
            },
          },
        }),
      );
      queue.push(entries.length - 1);
      rewritten = true;
    }
    if (rewritten) entries[at] = entry;
  }
  if (entries.length === resources.length) return expansion;
  return {
    ...expansion,
    definition: { ...(expansion.definition as unknown as Record<string, unknown>), resources: entries } as unknown as ResourceManifest,
  };
}
