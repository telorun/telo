/**
 * **What is in scope for CEL at one expression site.**
 *
 * A CEL expression is typed against an environment and a resolved context
 * schema that depend on WHERE it sits: the kind's step body contributes
 * `steps.<name>.result`, an error-bearing branch contributes `error`, a
 * `x-telo-bindings-from` field contributes its named bindings, an
 * `x-telo-context` region contributes its own scope resolved against the
 * enclosing array item, and the kernel globals are merged in per declaring
 * module. That assembly used to live inline in the analysis pass, built for one
 * `engine.analyze` call and discarded — so nothing outside the pass could ask
 * what a cursor sees.
 *
 * It is a QUERY here, and the pass is one of its callers. The other is the IDE:
 * completion, hover and signature help must offer exactly the names
 * `telo check` accepts, and two implementations of an open, growing scope rule
 * cannot be held in agreement by tests.
 *
 * Nothing here reports a diagnostic. The pass keeps every check it ever had;
 * what moved is the answer both halves need first.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { CelEnvironment } from "@telorun/cel";
import { AliasResolver, type ModuleScopes } from "./alias-resolver.js";
import {
  bindingContextProperties,
  bindingPathChain,
  BINDINGS_ANNOTATION,
  schemaAtChain,
} from "./cel-bindings.js";
import {
  buildImportInputCelEnvironment,
  buildParameterCelEnvironment,
  buildTypedCelEnvironment,
  registerModuleNamespaces,
} from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { celEvalModeAt, celEvalSites, type CelEvalMode, type CelEvalSites, kindCelEvalSites } from "./eval-paths.js";
import { ELEMENT_FROM_ITEM, itemTargetPath, readRelativePointer } from "./element-from-item.js";
import { CEL_ENGINE, isTaggedSentinel } from "@telorun/templating";
import { bindingExistsAt, bindingsAbsentAt } from "./context-eval.js";
import { readFromReferrer } from "./context-from-referrer.js";
import { capabilityExtendsExecutable } from "./executable-capability.js";
import {
  type ContractDirection,
  type DefResolver,
  effectiveAuthorSchema,
  inheritedCapability,
} from "./extends-resolution.js";
import {
  analyzerContractScope,
  PERMISSIVE_CONTRACT,
  resolveContract,
} from "./invocation-contract.js";
import {
  mergeKernelGlobalsIntoContext,
  type KernelGlobalsIndex,
} from "./kernel-globals.js";
import { moduleCallNamesOf } from "./module-call-names.js";
import { inlineNamedShapes } from "./schema-compat.js";
import type { ModuleFunctionIndex, ResolvedFunction } from "./module-function-index.js";
import type { CallableFlags, CallableFlagsIndex } from "./callable-flags.js";
import { declaredDocument, navigateDeclaredChain } from "./referenced-shape.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import { withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { valueDerivedContract } from "./value-derived-contract.js";
import {
  inferredResultSchema,
  isForwardableResult,
  sameNamedResult,
  stepContextAt,
  stepContextOf,
  type StepResultAlternative,
} from "./step-result-inference.js";
import { bodyForPath, templateBodies } from "./template-body.js";
import {
  contextChainAt,
  elementOfCollection,
  extractContextsFromSchema,
  getContextHolder,
  getManifestItem,
  navigateConcretePath,
  isParameterScope,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
  type MatchedContext,
} from "./validate-cel-context.js";

/** Build a closed JSON Schema for the `self` CEL variable available inside a
 *  `Telo.Definition` template body. Mirrors the runtime template controller's
 *  `const self = { ...resource, name: resource.metadata.name };` — every
 *  property the user declared in `schema:` plus synthetic `name` / `kind` and
 *  the metadata sub-object (kept open since metadata legitimately carries
 *  arbitrary user-added fields). */
function buildSelfSchema(
  definition: Record<string, any>,
  defs?: DefinitionRegistry,
  aliases?: AliasResolver,
): Record<string, any> {
  // The author-facing schema resolves inheritance: with `base:` the child's own
  // schema (the parent's config is internal); without it, `merge(parent, own)`.
  const userSchema = (
    defs
      ? effectiveAuthorSchema(definition as unknown as ResourceDefinition, (k) =>
          defs.resolve(aliases?.resolveKind(k) ?? k) ?? defs.resolve(k),
        )
      : (definition.schema ?? {})
  ) as Record<string, any>;
  const userProps = (userSchema.properties ?? {}) as Record<string, any>;
  const userRequired = Array.isArray(userSchema.required) ? userSchema.required : [];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...userProps,
      name: { type: "string" },
      kind: { type: "string" },
      metadata: {
        type: "object",
        additionalProperties: true,
        properties: { name: { type: "string" } },
      },
    },
    required: [...userRequired, "name", "kind"],
  };
}

/** Build the JSON Schema for the `inputs` CEL variable available inside an
 *  invocable template body — the shared contract resolver applied to the
 *  definition itself, so a body is typed against the exact signature callers are
 *  checked against and dispatch enforces. Walks the whole `extends` chain rather
 *  than one hop, so a definition two levels below the declaration still gets
 *  typed inputs. Undefined when nothing in the chain declares a contract —
 *  the caller signals opaque `map<string, dyn>` upstream. */
function lookupTemplateInputsSchema(
  definition: Record<string, any>,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  allManifests: Record<string, any>[],
  scopes: ModuleScopes,
): Record<string, any> | undefined {
  return resolveContract(
    "inputType",
    undefined,
    definition as unknown as ResourceDefinition,
    analyzerContractScope(defs, aliases, scopes, allManifests),
  )?.schema;
}

/** Returns a "resolver-facing" view of the manifest where the fields used as
 *  navigation roots by Telo.Definition's `x-telo-context-from-root` annotations
 *  have been pre-augmented:
 *    - `schema`     → augmented `self` schema (synthetic `name`/`kind`/metadata).
 *    - `inputType`  → resolved through the shared contract resolver, so
 *                     `x-telo-context-from-root: inputType` substitutes the
 *                     real signature. Without it the annotation would replace
 *                     the node verbatim with the inline `{kind, schema}` wrapper
 *                     the standard library writes everywhere, typing `inputs` as
 *                     `{kind, schema}` instead of the declared properties.
 *
 *  For non-definition manifests the original object is returned. */
export function manifestRootForResolver(
  m: Record<string, any>,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  allManifests: Record<string, any>[],
  scopes: ModuleScopes,
): Record<string, any> {
  if (m.kind !== "Telo.Definition") return m;
  const inputs = lookupTemplateInputsSchema(m, defs, aliases, allManifests, scopes);
  return {
    ...m,
    schema: buildSelfSchema(m, defs, aliases),
    ...(inputs ? { inputType: inputs } : {}),
  };
}

/**
 * Build a `steps` context schema for a kind's step body.
 * Walks each step in the manifest array, resolves the invoked resource's output
 * contract, and builds `steps.<name>.result` context entries.
 *
 * Resolution is the shared {@link resolveContract} — the invoked resource
 * manifest's own declaration, then the kind's, resolved to the nearest
 * declaration along `extends`, then permissive. Sharing it with the kernel is
 * what stops `telo check` from typing `steps.X.result` against one contract
 * while dispatch validates against another.
 *
 * The kind layer is what makes `x-telo-stream` properties on definitions
 * actually govern step-result chain validation — without it, the validator falls
 * back to permissive and the stream-opacity rule never fires.
 *
 * Recursion into nested step arrays is annotation-driven via
 * `x-telo-topology-role`. The analyzer recognises three role values:
 *   - `branch`     — value is an array of steps (e.g. then / else / do / catch).
 *   - `branch-list`— value is an array of objects each carrying further roled
 *                    sub-properties (e.g. elseif: [{ if, then }]).
 *   - `case-map`   — value is an object whose values are step arrays (e.g. cases).
 * No specific Run.Sequence field name is hardcoded; any kind that uses
 * a step body and tags its branch fields with these roles works.
 *
 * The context exists whenever the manifest holds a step body, and is an empty
 * closed map when no step in it produces a result; undefined only when there
 * is no step body at all.
 */
export function buildStepContextSchema(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  allManifests: Record<string, any>[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: ModuleScopes,
): Record<string, any> | undefined {
  const props = defSchema.properties as Record<string, any> | undefined;
  if (!props) return undefined;

  const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;
  let hasStepBody = false;

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = readStepSlot(fieldSchema);
    if (!stepCtx) continue;

    const invokeField = stepCtx.invoke;
    const outputTypeField = stepCtx.outputType;
    // Optional: the field a step uses to produce a result without dispatching.
    // Only a kind that declares one has pure steps at all.
    const valueField = stepCtx.value;

    const steps = manifest[fieldName];
    if (!Array.isArray(steps)) continue;
    hasStepBody = true;

    const stepItemSchema = resolveLocalRef(
      fieldSchema.items as Record<string, any> | undefined,
      defSchema,
    );

    // The instance's own input contract, for typing a pure step that just
    // forwards one of its values.
    const ownInputs = resolveTypeFieldToSchema(
      (manifest as Record<string, any>).inputType,
      allManifests,
    );

    // Every step producing a result, by name: a name may be carried by several
    // (a branch pair, a loop's seed and the step advancing it), and it is typed
    // only by what all of them produce.
    const producers = new Map<string, StepProducer[]>();
    const produce = (name: string, producer: StepProducer): void => {
      const named = producers.get(name);
      if (named) named.push(producer);
      else producers.set(name, [producer]);
    };

    /** The step node of `name` as `reader` sees it — its own name is what the
     *  other steps carrying it produce. Undefined where nothing else does. */
    const stepNode = (name: string, reader: StepProducer): Record<string, any> | undefined => {
      const alternatives = (producers.get(name) ?? [])
        .filter((producer) => producer !== reader)
        .map(alternativeOf);
      return alternatives.length > 0
        ? { type: "object", properties: { result: sameNamedResult(alternatives) } }
        : undefined;
    };

    const alternativeOf = (producer: StepProducer): StepResultAlternative => ({
      result: resultOf(producer),
      ...(producer.at === undefined ? {} : { at: producer.at }),
    });

    // A pure step dispatches nothing, so there is no contract to resolve. Where
    // its expression is a plain chain into something already typed — another
    // step's result, or the kind's own inputs — that type carries through;
    // anything else (arithmetic, a call, a comprehension) is typed by the CEL
    // type its expression checks to, recorded when `steps` is registered with
    // the environment, and a literal by its own shape
    // (`step-result-inference.ts`).
    const resultOf = (producer: StepProducer): Record<string, any> => {
      if (producer.result) return producer.result;
      const inferred = inferredResultSchema(producer.value) ?? PERMISSIVE_CONTRACT;
      // Two steps forwarding each other: the one read while it is still being
      // resolved is its own expression.
      if (producer.resolving) return inferred;
      producer.resolving = true;
      const chain = bindingPathChain(producer.value);
      const read = chain?.[0] === "steps" && chain[1] !== undefined ? stepNode(chain[1], producer) : undefined;
      const chained = schemaAtChain(chain, {
        properties: {
          steps: { type: "object", properties: read ? { [chain![1]!]: read } : {} },
          ...(ownInputs ? { inputs: ownInputs } : {}),
        },
      });
      producer.resolving = false;
      return (producer.result = chained && isForwardableResult(chained) ? chained : inferred);
    };

    walkStepArray(steps, stepItemSchema, defSchema, fieldName, (s, stepPath) => {
      const name = s.name;
      const invoke = s[invokeField] as Record<string, any> | undefined;
      // Only invoke steps register a `steps.<name>.result` entry — control-flow
      // wrappers (try/if/while/switch/throw) don't produce a result and must
      // not shadow real entries with a permissive `additionalProperties: true`,
      // or unknown step references slip through chain validation.
      if (typeof name !== "string") return;
      if (!invoke || typeof invoke !== "object") {
        if (valueField && valueField in s) {
          produce(name, { value: s[valueField], at: `${stepPath}.${valueField}` });
        }
        return;
      }
      const invokedKind = invoke.kind as string | undefined;
      const invokedName = invoke.name as string | undefined;
      // A named `!ref` carries the target's own manifest (which may narrow the
      // contract for this one instance); an inline `{ kind, ... }` step IS the
      // manifest. Either way the kind layer resolves through `extends`.
      const invokedManifest = invokedName
        ? (allManifests.find(
            (m) =>
              (m.metadata as any)?.name === invokedName && (!invokedKind || m.kind === invokedKind),
          ) as Record<string, any> | undefined)
        : (invoke as Record<string, any>);
      const invokedDef = invokedKind
        ? contractScope.resolveIn(invokedKind, readingModule)
        : undefined;
      // Without an output-type field the composer allows no per-instance
      // narrowing, so only the invoked kind's contract types the result.
      const outputSchema = resolveContract(
        (outputTypeField ?? "outputType") as ContractDirection,
        outputTypeField ? invokedManifest : undefined,
        invokedDef,
        contractScope,
      )?.schema;
      const derived =
        outputSchema || !outputTypeField
          ? undefined
          : valueDerivedContract(
              invokedManifest,
              defs.effectiveSchemaOf(invokedDef) as Record<string, any> | undefined,
              outputTypeField,
            );
      // The target's contract is embedded whole: a document of its own.
      const contract = outputSchema && declaredDocument(outputSchema);
      produce(name, { result: contract ?? derived ?? PERMISSIVE_CONTRACT });
    });

    if (producers.size > 0) {
      const stepProperties: Record<string, any> = {};
      for (const [name, named] of producers) {
        stepProperties[name] = {
          type: "object",
          properties: { result: sameNamedResult(named.map(alternativeOf)) },
        };
      }
      return stepContextOf(stepProperties);
    }
  }

  return hasStepBody ? { type: "object", properties: {} } : undefined;
}

/** One step producing `steps.<name>.result`: a dispatch's contract, or a pure
 *  step's value, resolved when first read. */
interface StepProducer {
  result?: Record<string, any>;
  value?: unknown;
  /** Where a pure step's value is written. */
  at?: string;
  resolving?: boolean;
}

/** Where a resource of this kind receives call arguments: undefined unless its
 *  effective capability is in the `Telo.Executable` lineage; otherwise its eval
 *  sites, since a compile-eval field is resolved before any call exists. */
function callArgumentSites(
  definition: ResourceDefinition | undefined,
  defs: DefinitionRegistry,
  resolveDef: DefResolver,
): CelEvalSites | undefined {
  if (!definition) return undefined;
  const capability = inheritedCapability(definition, resolveDef);
  if (capability === undefined || !capabilityExtendsExecutable(capability, defs)) return undefined;
  return kindCelEvalSites(definition, resolveDef, defs.shapeLookup);
}

export function collectErrorContextScopes(
  defSchema: Record<string, any> | undefined,
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  if (!defSchema || typeof defSchema !== "object") return out;
  const seen = new Set<Record<string, any>>();

  const walk = (schema: Record<string, any> | undefined): void => {
    if (!schema || typeof schema !== "object" || seen.has(schema)) return;
    seen.add(schema);

    const props = schema.properties as Record<string, any> | undefined;
    if (props) {
      for (const [fieldName, fieldSchema] of Object.entries(props)) {
        if (fieldSchema && typeof fieldSchema === "object") {
          const errCtx = (fieldSchema as Record<string, any>)["x-telo-error-context"];
          if (errCtx && typeof errCtx === "object" && !out.has(fieldName)) {
            out.set(fieldName, errCtx as Record<string, any>);
          }
        }
        walk(resolveLocalRef(fieldSchema as Record<string, any>, defSchema));
      }
    }
    if (schema.items) walk(resolveLocalRef(schema.items as Record<string, any>, defSchema));
    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
      const arr = schema[key];
      if (Array.isArray(arr)) for (const sub of arr) walk(resolveLocalRef(sub, defSchema));
    }
    if (schema.$defs && typeof schema.$defs === "object") {
      for (const sub of Object.values(schema.$defs as Record<string, any>)) {
        walk(sub as Record<string, any>);
      }
    }
  };

  walk(defSchema);
  return out;
}

/**
 * Return the error-context schema for a CEL `path` when the path lies within
 * (any depth under) one of the error-bearing fields, else undefined. A path is
 * "within" field `f` when it contains a segment `f[<index>]`. When multiple
 * error-bearing fields match (e.g. a `finally` nested inside a `catch`), the
 * deepest — the one whose segment appears latest in the path — wins, so the
 * innermost branch's schema governs.
 */
export function errorContextForPath(
  path: string,
  scopes: Map<string, Record<string, any>>,
): Record<string, any> | undefined {
  let best: { index: number; schema: Record<string, any> } | undefined;
  for (const [fieldName, schema] of scopes) {
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of path.matchAll(new RegExp(`(^|\\.)${escaped}\\[\\d+\\]`, "g"))) {
      if (best === undefined || match.index > best.index) {
        best = { index: match.index, schema };
      }
    }
  }
  return best?.schema;
}

/** Add a kind's named bindings to a resolved context, when the context declares
 *  a bindings region. They go UNDER the context's own properties: a scope
 *  variable wins over a same-named binding at runtime, so static typing has to
 *  agree (the collision itself is `BINDING_NAME_RESERVED`). */
export function withBindingNames(
  contextSchema: Record<string, any>,
  resource: Record<string, any>,
): Record<string, any> {
  const field = contextSchema[BINDINGS_ANNOTATION];
  if (typeof field !== "string") return contextSchema;
  const bindings = resource[field];
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    return contextSchema;
  }
  return {
    ...contextSchema,
    properties: {
      ...bindingContextProperties(bindings as Record<string, unknown>, contextSchema),
      ...(contextSchema.properties ?? {}),
    },
  };
}

/**
 * What one CEL expression is typed against.
 *
 * Both halves, never a flattened name list: the environment answers "what
 * names exist and what type does this expression have", the context schema
 * answers "what shape does that name carry" — which is what a hover tooltip and
 * a member completion are made of, and what a name list throws away.
 */
export interface CelScope {
  /** The environment typed for this expression's path. */
  env: CelEnvironment;
  /** The resolved `x-telo-context` schema merged with the kernel globals, or
   *  null when no context applied (the environment alone types the site). */
  contextSchema: Record<string, any> | null;
  /** The names a call's receiver may be for the call to resolve as a MODULE
   *  call, in the scope of the module that DECLARED this expression.
   *
   *  Part of the scope rather than of the environment because it is not a name
   *  a value can be read under: a module name types nothing, is in no context
   *  schema, and answers only "is this call the catalog's or another module's".
   *  It belongs here for the reason everything else does — the editor and the
   *  checker must read one expression the same way. */
  moduleNames: ReadonlySet<string>;
  /** The CEL type a module call at this site yields — its callee's declared
   *  `returns` — or undefined where the callee is not known. */
  moduleCallType: (qualified: string) => string | undefined;
  /** The schema a module call's result carries, for member access on it. */
  moduleCallResult: (qualified: string) => Record<string, any> | undefined;
  /** The derived flags of the function a module call reaches. */
  moduleCallFlags: (qualified: string) => CallableFlags | undefined;
  /** What a module call at this site resolves to — the callable resource, its
   *  parameters and result — or undefined where it resolves to no callable. */
  moduleFunction: (qualified: string) => ResolvedFunction | undefined;
  /** The functions a call through `receiver` (`Self`, the module's own name, an
   *  import alias) may name here, in declaration order: what `<receiver>.` offers
   *  and every one of them resolves. */
  moduleFunctionsOf: (receiver: string) => ReadonlyArray<{ name: string; function: ResolvedFunction }>;
  /** The site's names as a schema — the context, or the kernel globals where no
   *  context applied — for explaining a rejection the checker already made. */
  explainSchema: () => Record<string, any> | null;
  /** Set where the site is an accessor field's value: the names a chain there
   *  may start at. Such a value is named and never evaluated, so nothing else
   *  the scope types — a function, a kernel global, a module call — may be
   *  written there (`ACCESSOR_NOT_PLAIN_CHAIN`). */
  accessorBindings?: readonly string[];
}

/** The analyzer state a scope is resolved against — everything a manifest set
 *  contributes, gathered once per analysis. */
export interface CelScopeInputs {
  /** The base (untyped) CEL environment. */
  celEnv: CelEnvironment;
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  scopes: ModuleScopes;
  allManifests: ResourceManifest[];
  kernelGlobals: KernelGlobalsIndex;
  /** The module doc carrying the Application-only `ports` namespace. */
  moduleManifest?: ResourceManifest;
  /** CEL call names per declaring module (`moduleCallNamesByModule`). Optional
   *  so a caller that never analyzes a module call (a scope query over a single
   *  detached manifest) need not build one; absent leaves every call the
   *  catalog's. */
  moduleCallNames?: ReadonlyMap<string, ReadonlySet<string>>;
  /** What a module call resolves to (`module-function-index.ts`). Optional for
   *  the same reason; absent leaves every module call `dyn`. */
  moduleFunctions?: ModuleFunctionIndex;
  /** Each function's derived determinism and host-backedness
   *  (`callable-flags.ts`). Optional for the same reason; absent leaves a module
   *  call carrying no flag. */
  callableFlags?: CallableFlagsIndex;
  /** The observed-state-only context, used where no `x-telo-context` matched. */
  observedStateContext: Record<string, any> | null;
  /** Every slot referencing a resource: the referrer and the concrete path of
   *  the slot. Absent, a binding typed from its referrer is what it declares
   *  itself. */
  referrersOf?: (m: ResourceManifest) => ReadonlyArray<{ manifest: ResourceManifest; path: string }>;
  /** A referrer's kind, resolved in the scope of the module declaring it. */
  definitionOf?: (m: ResourceManifest) => ResourceDefinition | undefined;
}

/**
 * One way the bindings typed from a resource's referrers (`x-telo-context-from-
 * referrer`) are typed at a site: each such binding's type, and the referrers
 * that give it. A site whose referrers all agree has one.
 */
export interface ReferrerVariant {
  readonly bindings: Readonly<Record<string, Record<string, any>>>;
  /** Who gives this typing: `label` the resource whose scope declares it (the
   *  outermost of a chain), `manifest` / `path` the slot referencing the
   *  resource directly. */
  readonly referrers: ReadonlyArray<{ manifest: ResourceManifest; path: string; label: string }>;
}

/** What the resolvers of one analysis share: the types each resource's
 *  referrers give a binding, and which are being computed. */
interface ReferrerTypeIndex {
  readonly types: WeakMap<ResourceManifest, Map<string, ReferrerVariant[]>>;
  readonly inProgress: Set<string>;
  readonly ids: WeakMap<ResourceManifest, number>;
  next: number;
}

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );

/** One CEL site, as the manifest visitor reports it. Structural on purpose —
 *  the resolver takes the fields it reads, not the visitor's event type, so a
 *  caller that located a site some other way (a cursor in an editor buffer) can
 *  ask the same question. */
export interface CelSiteRef {
  source: ResourceManifest;
  path: string;
  contextSchema?: Record<string, any>;
  matchedScope?: string;
  /** Every region in force at the path, outermost first, ending with the one
   *  `contextSchema` names. Each adds to those enclosing it. */
  contexts?: readonly MatchedContext[];
  /** The site's eval mode: a binding whose `x-telo-context-eval` does not list
   *  it is out of scope there. Unknown, a binding listing `compile` or
   *  `runtime` stays. */
  mode?: CelEvalMode;
  /** How the bindings typed from the resource's referrers are typed here —
   *  one of {@link CelScopeResolver.siteVariants}. Absent, the first. */
  variant?: ReferrerVariant;
}

/**
 * The CEL scope rule, applied per resource and then per expression.
 *
 * Stateful across a resource because the per-resource half — the step context,
 * the error-bearing regions, the invocation context — is derived from the kind's
 * schema once and read by every expression in that resource. `enterResource`
 * establishes it; `scopeFor` answers for one path.
 */
const NO_MODULE_CALL_NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map();

export class CelScopeResolver {
  private readonly typedEnvByManifest = new Map<ResourceManifest, CelEnvironment>();
  /** The context standing in where no `x-telo-context` matched, one per
   *  module's globals. It binds nothing the environment lacks, so a site read
   *  against it shares the manifest's cached environment. */
  private readonly fallbackContexts = new WeakMap<Record<string, any>, Record<string, any>>();
  private readonly fallbackContextSet = new WeakSet<Record<string, any>>();

  /** Per-resource state, replaced at each `enterResource`. */
  private stepContext: Record<string, any> | undefined;
  private invocationContext: Record<string, any> | undefined;
  private errorScopes: Map<string, Record<string, any>> = new Map();
  /** The same two facts per `resources:` entry of a `Telo.Definition` — a
   *  template body is a declaration of ANOTHER kind, so its step body and its
   *  error branches are that kind's, not the enclosing definition's. */
  private bodyScopes: Array<{
    prefix: string;
    scopePrefix: string;
    manifest: Record<string, any>;
    stepContext: Record<string, any> | undefined;
    inputsSchema: Record<string, any> | undefined;
    argumentSites: CelEvalSites | undefined;
    errorScopes: Map<string, Record<string, any>>;
    contexts: ReadonlyArray<{ scope: string; schema: Record<string, any> }>;
    sites: CelEvalSites;
  }> = [];
  /** The regions and eval sites of the current resource's kind — what types a
   *  chain an `x-telo-context-element-from-item` pointer names, at its own site. */
  private kindContexts: ReadonlyArray<{ scope: string; schema: Record<string, any> }> = [];
  private kindSites: CelEvalSites = celEvalSites(undefined);
  /** Element-from-item targets being typed, so a pointer leading back is untyped. */
  private readonly itemsInProgress = new Set<string>();
  /** The input contract a step body's `inputs` is typed from, when the
   *  resource or its kind declares one. */
  private inputsSchema: Record<string, any> | undefined;
  /** Set only when the resource's kind receives call arguments. */
  private argumentSites: CelEvalSites | undefined;
  /** The enclosing definition's `self` schema, resolved once per resource. A
   *  template body's contexts resolve against the BODY, so `self` — the one
   *  binding anchored on the definition — is substituted before they do. */
  private selfSchema: Record<string, any> | undefined;

  private readonly referrerTypes: ReferrerTypeIndex;

  constructor(
    private readonly inputs: CelScopeInputs,
    shared?: ReferrerTypeIndex,
  ) {
    this.referrerTypes = shared ?? { types: new WeakMap(), inProgress: new Set(), ids: new WeakMap(), next: 0 };
  }

  /**
   * Every way the bindings this site's regions type from the resource's
   * referrers are typed: one variant per distinct combination of the types the
   * referrers' scopes give them. A site with no such binding, or whose
   * referrers all agree, has exactly one; a binding nothing references keeps
   * the keywords it declares.
   */
  siteVariants(site: CelSiteRef): ReferrerVariant[] {
    const chain: ReadonlyArray<{ schema: Record<string, any> | undefined }> =
      site.contexts && site.contexts.length > 0
        ? site.contexts
        : site.contextSchema
          ? [{ schema: site.contextSchema }]
          : [];
    const owners = new Map<string, unknown>();
    for (const region of chain) {
      const properties = region.schema?.properties;
      if (!properties || typeof properties !== "object") continue;
      for (const [name, binding] of Object.entries(properties as Record<string, unknown>)) owners.set(name, binding);
    }
    let variants: ReferrerVariant[] = [{ bindings: {}, referrers: [] }];
    for (const [name, binding] of owners) {
      const from = readFromReferrer(binding);
      if (from === undefined || !bindingExistsAt(binding, site.mode)) continue;
      const typed = this.typesFromReferrers(site.source, from);
      if (typed.length === 0) continue;
      variants = variants.flatMap((variant) =>
        typed.map((t) => ({
          bindings: { ...variant.bindings, [name]: t.bindings[from]! },
          referrers: [...variant.referrers, ...t.referrers],
        })),
      );
    }
    return variants;
  }

  /** The types the resources referencing `m` give the binding `name` at their
   *  referencing slots, one per distinct type. */
  private typesFromReferrers(m: ResourceManifest, name: string): ReferrerVariant[] {
    const index = this.referrerTypes;
    let byName = index.types.get(m);
    const known = byName?.get(name);
    if (known) return known;
    let id = index.ids.get(m);
    if (id === undefined) index.ids.set(m, (id = index.next++));
    const key = `${id}\0${name}`;
    // A chain leading back to a resource being typed adds nothing.
    if (index.inProgress.has(key)) return [];
    index.inProgress.add(key);
    try {
      const distinct = new Map<string, { schema: Record<string, any>; referrers: ReferrerVariant["referrers"][number][] }>();
      const { defs } = this.inputs;
      for (const { manifest: referrer, path } of this.inputs.referrersOf?.(m) ?? []) {
        const definition = this.inputs.definitionOf?.(referrer);
        const authorSchema = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
        if (!authorSchema) continue;
        const regions = contextChainAt(extractContextsFromSchema(authorSchema, defs.shapeLookup), path);
        const innermost = regions[regions.length - 1];
        const sub = new CelScopeResolver(this.inputs, index);
        sub.enterResource(referrer, definition);
        const site: CelSiteRef = {
          source: referrer,
          path,
          ...(innermost ? { contextSchema: innermost.schema, matchedScope: innermost.scope } : {}),
          contexts: regions,
          mode: "accessor",
        };
        const label = `${referrer.kind}/${String(referrer.metadata?.name ?? "")}`;
        for (const variant of sub.siteVariants(site)) {
          const schema = sub.resolveContextFor({ ...site, variant }, false)?.properties?.[name];
          if (!schema || typeof schema !== "object") continue;
          const json = stableJson(schema);
          let entry = distinct.get(json);
          if (!entry) distinct.set(json, (entry = { schema, referrers: [] }));
          const labels = variant.referrers.length > 0 ? [...new Set(variant.referrers.map((r) => r.label))] : [label];
          for (const each of labels) entry.referrers.push({ manifest: referrer, path, label: each });
        }
      }
      const out: ReferrerVariant[] = [...distinct.values()].map((entry) => ({
        bindings: { [name]: entry.schema },
        referrers: entry.referrers,
      }));
      if (!byName) index.types.set(m, (byName = new Map()));
      byName.set(name, out);
      return out;
    } finally {
      index.inProgress.delete(key);
    }
  }

  /** The `steps` context schema for the current resource, or undefined when it
   *  holds no step body. Exposed because the step-inputs check needs the
   *  same schema this resource's expressions are typed against — recomputing it
   *  there is how the two would come to disagree. */
  get stepContextSchema(): Record<string, any> | undefined {
    return this.stepContext;
  }

  /** The error-bearing regions the current resource's kind declares. */
  get errorContextScopes(): ReadonlyMap<string, Record<string, any>> {
    return this.errorScopes;
  }

  /** The resource-wide invocation context, when this resource is an inline
   *  declaration that carries one. Read by the "CEL in a non-eval field" check:
   *  such a resource's CEL is evaluated by the enclosing kind, not by an
   *  `x-telo-eval` annotation of its own. */
  get invocationContextSchema(): Record<string, any> | undefined {
    return this.invocationContext;
  }

  /** Establish the per-resource half of the scope. */
  enterResource(m: ResourceManifest, definition: ResourceDefinition | undefined): void {
    const { allManifests, defs, aliases, scopes } = this.inputs;
    this.invocationContext = (m.metadata as any)?.xTeloInvocationContext as
      | Record<string, any>
      | undefined;
    // The INHERITANCE-RESOLVED schema at both sites, for the reason the CEL
    // context regions use it: an `extends` child is authored against
    // merge(parent, own), so a step body or a `catch:` region the parent
    // declares is in force on the child. All three consumers share one memo so
    // they cannot come to disagree about which schema a kind means.
    const authorSchema = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
    this.stepContext = authorSchema
      ? buildStepContextSchema(
          m as Record<string, any>,
          authorSchema,
          allManifests as Record<string, any>[],
          defs,
          aliases,
          scopes,
        )
      : undefined;
    this.errorScopes = collectErrorContextScopes(authorSchema);
    this.kindContexts = authorSchema ? extractContextsFromSchema(authorSchema, defs.shapeLookup) : [];
    this.kindSites = celEvalSites(authorSchema, defs.shapeLookup);
    const contractScope = analyzerContractScope(defs, aliases, scopes, allManifests as Record<string, any>[]);
    const resolveDef = contractScope.resolveDefinition;
    this.argumentSites = this.stepContext
      ? callArgumentSites(definition, defs, resolveDef)
      : undefined;
    this.inputsSchema = this.argumentSites
      ? resolveContract("inputType", m as Record<string, any>, definition, contractScope)?.schema
      : undefined;
    this.selfSchema =
      m.kind === "Telo.Definition" ? buildSelfSchema(m as Record<string, any>, defs, aliases) : undefined;
    const declaringModule = (m.metadata as { module?: string } | undefined)?.module;
    this.bodyScopes = templateBodies(m, defs, aliases, scopes).map((template) => {
      // A body entry is authoring data, so a named contract is still a `!ref`;
      // it is read in the canonical form a registered resource carries.
      const inputType = (template.manifest as Record<string, any>).inputType;
      const body =
        inputType === undefined
          ? template
          : {
              ...template,
              manifest: {
                ...template.manifest,
                inputType: withCanonicalRefSentinels(inputType, declaringModule, (alias) =>
                  contractScope.projectionModules?.moduleForAlias(declaringModule, alias),
                ),
              } as ResourceManifest,
            };
      const bodySchema = defs.effectiveSchemaOf(body.definition) as Record<string, any> | undefined;
      const stepContext = bodySchema
        ? buildStepContextSchema(
            body.manifest as Record<string, any>,
            bodySchema,
            allManifests as Record<string, any>[],
            defs,
            aliases,
            scopes,
          )
        : undefined;
      const argumentSites = stepContext
        ? callArgumentSites(body.definition, defs, resolveDef)
        : undefined;
      return {
        prefix: body.prefix,
        scopePrefix: body.scopePrefix,
        manifest: body.manifest as Record<string, any>,
        stepContext,
        argumentSites,
        inputsSchema: argumentSites
          ? resolveContract(
              "inputType",
              body.manifest as Record<string, any>,
              body.definition,
              contractScope,
            )?.schema
          : undefined,
        errorScopes: collectErrorContextScopes(bodySchema),
        contexts: bodySchema ? extractContextsFromSchema(bodySchema, defs.shapeLookup) : [],
        sites: celEvalSites(bodySchema, defs.shapeLookup),
      };
    });
  }

  /**
   * What the expression at `site` is typed against.
   *
   * The environment is cached per manifest when no context applied, which is
   * most expressions: it then depends only on the manifest, so rebuilding it per
   * expression is pure waste — a clone plus a re-registration of every variable,
   * on every keystroke in the IDE. A matched context makes it path-specific (its
   * schema is resolved against the enclosing array item), so those build fresh
   * rather than risk one item's types leaking into another's.
   */
  scopeFor(site: CelSiteRef): CelScope {
    const m = site.source;
    const parameterScope = isParameterScope(site.contextSchema ?? this.invocationContext);
    const contextSchema = this.resolveContextFor(site, parameterScope);
    const {
      celEnv,
      allManifests,
      moduleManifest,
    } = this.inputs;

    const functions = this.inputs.moduleFunctions;
    const resolved = (qualified: string) => {
      const resolution = functions?.resolve(m, qualified);
      return resolution?.status === "resolved" ? resolution : undefined;
    };
    const moduleNames = moduleCallNamesOf(this.inputs.moduleCallNames ?? NO_MODULE_CALL_NAMES, m);

    // An import's `needs:` supply is evaluated in the importer's scope like any
    // startup field — `resources` included — unlike its config-only
    // `variables:` / `secrets:`, so the two never share an environment.
    const importNeeds = m.kind === "Telo.Import" && site.path.startsWith("needs.");
    const envFromManifest =
      (contextSchema === null || this.fallbackContextSet.has(contextSchema)) && !importNeeds;
    const cached = envFromManifest ? this.typedEnvByManifest.get(m) : undefined;
    let env: CelEnvironment;
    if (cached) {
      env = cached;
    } else if (parameterScope) {
      env = buildParameterCelEnvironment(celEnv, contextSchema);
    } else if (m.kind === "Telo.Import" && !importNeeds) {
      // A `Telo.Import`'s variables/secrets are a config-only contract evaluated
      // in the IMPORTING module's scope, so they type from the owning module doc
      // and drop `resources`/`env`, making a reference to either an error.
      env = buildImportInputCelEnvironment(
        celEnv,
        allManifests.find(
          (mm) =>
            (mm.kind === "Telo.Application" || mm.kind === "Telo.Library") &&
            (mm.metadata as { name?: string } | undefined)?.name ===
              (m.metadata as { module?: string } | undefined)?.module,
        ),
      );
    } else {
      env = buildTypedCelEnvironment(celEnv, m, contextSchema ?? undefined, moduleManifest);
    }
    if (!cached) {
      // The module's own names are NAMESPACES on the environment the site is
      // read against, which is what turns `Billing.total(x)` into a qualified
      // call as it is READ — the engine resolves it there, never afterwards.
      registerModuleNamespaces(env, moduleNames, (receiver) =>
        (functions?.callablesThrough(m, receiver) ?? []).map((entry) => ({
          name: entry.name,
          celType: entry.function.celType,
        })),
      );
      if (envFromManifest) this.typedEnvByManifest.set(m, env);
    }

    return {
      env,
      contextSchema,
      moduleNames,
      moduleCallType: (qualified) => resolved(qualified)?.celType,
      moduleCallResult: (qualified) => resolved(qualified)?.returns,
      moduleCallFlags: (qualified) => this.inputs.callableFlags?.ofCall(m, qualified),
      moduleFunction: resolved,
      moduleFunctionsOf: (receiver) => functions?.callablesThrough(m, receiver) ?? [],
      // The observed-state context that stands in where no `x-telo-context`
      // matched carries no globals; merging is a no-op for one that does.
      explainSchema: () =>
        parameterScope
          ? contextSchema
          : mergeKernelGlobalsIntoContext(
              contextSchema ?? { type: "object", properties: {}, additionalProperties: true },
              this.inputs.kernelGlobals.forResource(m),
            ),
    };
  }

  /** The context schema in force at `site`: the matched `x-telo-context` (or the
   *  resource-wide invocation context), plus the step and error regions this
   *  path falls in, resolved and merged with the kernel globals. A parameter
   *  scope is resolved alone: it replaces all of those. */
  resolveContextFor(
    site: CelSiteRef,
    parameterScope: boolean,
  ): Record<string, any> | null {
    const { path } = site;
    const m = site.source;
    let matched: Record<string, any> | undefined = site.contextSchema ?? this.invocationContext;
    const declaredInnermost = matched;

    // Inside a template body the step and error regions are the NESTED kind's.
    // Its `steps` accumulator and its `catch:` branches are declared there, and
    // the enclosing definition's (there are none) would say nothing about them.
    const inBody = this.bodyScopes.length > 0 ? bodyForPath(this.bodyScopes, path) : undefined;
    const stepContext = parameterScope ? undefined : inBody ? inBody.stepContext : this.stepContext;
    const errorScopes = parameterScope
      ? new Map<string, Record<string, any>>()
      : inBody
        ? inBody.errorScopes
        : this.errorScopes;

    if (stepContext) {
      const base = matched ?? { type: "object", properties: {}, additionalProperties: true };
      const declaredInputs = inBody ? inBody.inputsSchema : this.inputsSchema;
      const argumentSites = inBody ? inBody.argumentSites : this.argumentSites;
      const localPath = inBody ? path.slice(inBody.prefix.length + 1) : path;
      const argumentsBound =
        argumentSites !== undefined && celEvalModeAt(argumentSites, localPath) !== "compile";
      matched = {
        ...base,
        properties: {
          // `inputs` is in scope beside `steps` only where a call's arguments
          // exist: a kind in the `Telo.Executable` lineage, at a site evaluated
          // per call rather than at compile time. Typed from the resolved input
          // contract the kernel binds and validates every call against, so a
          // misspelled argument is `CEL_UNKNOWN_FIELD`; it wins over a caller's
          // view of the slot (a route's open `inputs`). Open only where no
          // contract is declared.
          ...(argumentsBound ? { inputs: { type: "object", additionalProperties: true } } : {}),
          ...(base.properties ?? {}),
          ...(argumentsBound && declaredInputs ? { inputs: declaredInputs } : {}),
          steps: stepContextAt(stepContext, localPath),
        },
      };
    }

    // `error` is only in scope inside an error-bearing branch (e.g. a
    // `catch:` / `finally:`), so it's merged per-path, not resource-wide.
    const errorSchema =
      errorScopes.size > 0 ? errorContextForPath(path, errorScopes) : undefined;
    if (errorSchema) {
      const base = matched ?? { type: "object", properties: {}, additionalProperties: true };
      matched = {
        ...base,
        properties: { ...(base.properties ?? {}), error: errorSchema },
      };
    }

    if (!matched) {
      // No `x-telo-context` matched: the kernel globals alone, as every other
      // context merges them, so `resources` is checked against the names the
      // module declares — a read of one it does not declare fails at run time.
      // A kind document's CEL is written for a consumer or a template body,
      // whose resources these names do not describe, so it keeps the
      // observed-state segment alone.
      if (isKindDocument(m)) return this.inputs.observedStateContext;
      // An `imports:` entry's expressions are its desugared `Telo.Import`'s,
      // judged there in the import's own config-only scope.
      if (isModuleKind(m.kind) && path.startsWith("imports.")) {
        return this.inputs.observedStateContext;
      }
      const globals = this.inputs.kernelGlobals.forResource(m);
      let fallback = this.fallbackContexts.get(globals);
      if (!fallback) {
        fallback = mergeKernelGlobalsIntoContext(
          { type: "object", additionalProperties: true, properties: {} },
          globals,
        );
        this.fallbackContexts.set(globals, fallback);
        this.fallbackContextSet.add(fallback);
      }
      return fallback;
    }

    const { defs, aliases, scopes, allManifests, kernelGlobals } = this.inputs;

    // A template body's context annotations are the NESTED kind's, and every one
    // that anchors at a root — `x-telo-context-element-from`,
    // `-collection-from`, `-from-root`, `x-telo-bindings-from` — means the root
    // of the DECLARATION they were written for. Resolving them against the
    // enclosing `Telo.Definition` looked `collection:` up on a document that has
    // no such field, so `item` typed open and a typo below it went unreported —
    // the one place a nested declaration did not answer as the same declaration
    // written at the top level.
    //
    // So the path and the scope are rebased into the body and the body becomes
    // the resolution root. `self` is the single binding that genuinely belongs to
    // the enclosing definition, and it is substituted below rather than left as
    // an annotation the rebased root would misread.
    const body = inBody;
    const localPath = body ? path.slice(body.prefix.length + 1) : path;
    const rootManifest = body ? body.manifest : (m as Record<string, any>);
    const rootForResolver = body
      ? rootManifest
      : manifestRootForResolver(
          m as Record<string, any>,
          defs,
          aliases,
          allManifests as Record<string, any>[],
          scopes,
        );

    // Each region resolves against the item its own scope names.
    const resolveRegion = (schema: Record<string, any>, scope: string | undefined) => {
      const localScope =
        body && scope?.startsWith(`${body.scopePrefix}.`)
          ? `$.${scope.slice(body.scopePrefix.length + 1)}`
          : body
            ? undefined
            : scope;
      const own =
        body && this.selfSchema && schema.properties?.self
          ? { ...schema, properties: { ...schema.properties, self: this.selfSchema } }
          : schema;
      const manifestItem = localScope
        ? getManifestItem(localPath, localScope, rootManifest)
        : rootManifest;
      return withBindingNames(
        resolveContextAnnotations(own, manifestItem, {
          manifestRoot: rootForResolver,
          contextHolder: localScope
            ? getContextHolder(localPath, localScope, rootManifest)
            : rootManifest,
          defs,
          aliases,
          aliasesByModule: scopes?.aliasesByModule,
          allManifests: allManifests as Record<string, any>[],
        }),
        rootManifest,
      );
    };

    // A nested region ADDS to every region enclosing it, a name it declares
    // shadowing theirs. A parameter scope replaces everything, so nothing
    // above one is read.
    const chain = site.contexts ?? [];
    const enclosing =
      site.contextSchema !== undefined && chain[chain.length - 1]?.schema === site.contextSchema
        ? chain.slice(0, -1)
        : [];
    let from = 0;
    enclosing.forEach((ctx, i) => {
      if (isParameterScope(ctx.schema)) from = i;
    });
    const outer = isParameterScope(site.contextSchema) ? [] : enclosing.slice(from);
    let resolved = resolveRegion(matched, site.matchedScope);
    if (outer.length > 0) {
      const inherited = Object.assign(
        {},
        ...outer.map((ctx) => resolveRegion(ctx.schema, ctx.scope).properties ?? {}),
      );
      resolved = { ...resolved, properties: { ...inherited, ...(resolved.properties ?? {}) } };
    }
    resolved = this.withItemElements(
      site,
      [...outer, { scope: site.matchedScope, schema: declaredInnermost }],
      resolved,
      body,
    );
    // A binding its referrers type takes the type this site's variant gives it.
    const variant = site.variant ?? this.siteVariants(site)[0];
    if (variant && resolved.properties) {
      const typed = Object.entries(variant.bindings).filter(([name]) => name in resolved.properties!);
      if (typed.length > 0) resolved = { ...resolved, properties: { ...resolved.properties, ...Object.fromEntries(typed) } };
    }
    const absent = bindingsAbsentAt([...outer.map((ctx) => ctx.schema), matched], site.mode);
    if (absent.length > 0 && resolved.properties) {
      const properties = { ...resolved.properties };
      for (const name of absent) delete properties[name];
      resolved = { ...resolved, properties };
    }
    // A named shape nested anywhere in the context — a contract's
    // `outputType: { properties: { x: !ref Money } }`, an input declared as
    // `!ref Shape` — is a `$ref` the member walk cannot see through, so it is
    // expanded here, once, for every binding the site reads. Contract
    // resolution keeps the reference: the kernel shares it and keys its
    // validators on the schema's identity.
    const expand = (schema: Record<string, any>) =>
      inlineNamedShapes(schema, (id) => defs.schemaForId(id));
    if (parameterScope) return expand(resolved);
    return expand(
      mergeKernelGlobalsIntoContext(
        resolved,
        // Typed in the module that DECLARED this resource — for a manifest
        // forwarded from an imported library, that is its `moduleGlobals` stamp,
        // not the consuming application's block.
        kernelGlobals.forResource(m),
      ),
    );
  }

  /** `resolved` with every binding an `x-telo-context-element-from-item`
   *  pointer types — by the innermost region declaring its name — replaced by
   *  the element of the collection the chain at the pointed field names. */
  private withItemElements(
    site: CelSiteRef,
    regions: ReadonlyArray<{ scope: string | undefined; schema: Record<string, any> | undefined }>,
    resolved: Record<string, any>,
    body: CelScopeResolver["bodyScopes"][number] | undefined,
  ): Record<string, any> {
    const owners = new Map<string, { pointer: unknown; scope: string | undefined }>();
    for (const region of regions) {
      const properties = region.schema?.properties;
      if (!properties || typeof properties !== "object") continue;
      for (const [name, binding] of Object.entries(properties as Record<string, any>)) {
        owners.set(name, { pointer: binding?.[ELEMENT_FROM_ITEM], scope: region.scope });
      }
    }
    let properties: Record<string, any> | undefined;
    for (const [name, { pointer, scope }] of owners) {
      if (pointer === undefined || scope === undefined || !resolved.properties || !(name in resolved.properties)) continue;
      const next: Record<string, any> = properties ?? { ...resolved.properties };
      next[name] = this.itemElementAt(site, scope, pointer, body) ?? {};
      properties = next;
    }
    return properties ? { ...resolved, properties } : resolved;
  }

  /** The element of the collection the chain at the field `pointer` names
   *  holds, typed as at that field's own site — or undefined. */
  private itemElementAt(
    site: CelSiteRef,
    scope: string,
    written: unknown,
    body: CelScopeResolver["bodyScopes"][number] | undefined,
  ): Record<string, any> | undefined {
    const pointer = readRelativePointer(written);
    if (!pointer) return undefined;
    const m = site.source;
    const prefix = body ? `${body.prefix}.` : "";
    const localPath = body ? site.path.slice(prefix.length) : site.path;
    const localScope = body
      ? scope.startsWith(`${body.scopePrefix}.`)
        ? `$.${scope.slice(body.scopePrefix.length + 1)}`
        : undefined
      : scope;
    const root = body ? body.manifest : (m as Record<string, any>);
    if (!localScope) return undefined;
    const target = itemTargetPath(localPath, localScope, root, pointer);
    if (target === undefined) return undefined;
    const chain = plainChainSource(navigateConcretePath(root, target));
    if (!chain) return undefined;
    const full = `${prefix}${target}`;
    if (this.itemsInProgress.has(full)) return undefined;
    const regions = contextChainAt(body ? body.contexts : this.kindContexts, target).map((ctx) =>
      body ? { ...ctx, scope: `${body.scopePrefix}${ctx.scope.slice(1)}` } : ctx,
    );
    const innermost = regions[regions.length - 1];
    this.itemsInProgress.add(full);
    try {
      const context = this.resolveContextFor(
        {
          source: m,
          path: full,
          contextSchema: innermost?.schema,
          matchedScope: innermost?.scope,
          contexts: regions,
          mode: celEvalModeAt(body ? body.sites : this.kindSites, target) ?? undefined,
        },
        false,
      );
      if (!context) return undefined;
      return elementOfCollection(
        navigateDeclaredChain(context, chain, (id) => this.inputs.defs.schemaForId(id)),
      );
    } finally {
      this.itemsInProgress.delete(full);
    }
  }

}

/** The expression a plain `!cel` member chain holds, or undefined. */
function plainChainSource(value: unknown): string | undefined {
  const source = isTaggedSentinel(value) && value.engine === CEL_ENGINE ? value.source.trim() : undefined;
  return source !== undefined && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(source) ? source : undefined;
}
