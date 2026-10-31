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
import { emittedStepIdentity } from "@telorun/sdk";
import type { CelEnvironment } from "@telorun/cel";
import { AliasResolver, type ModuleScopes } from "./alias-resolver.js";
import { bindingContextProperties, BINDINGS_ANNOTATION } from "./cel-bindings.js";
import {
  buildImportInputCelEnvironment,
  buildParameterCelEnvironment,
  buildTypedCelEnvironment,
  celNamespaceNames,
  parseCelSource,
  registerModuleNamespaces,
} from "./cel-environment.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import { TypedEnvironments } from "./typed-environments.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import {
  celEvalModeAt,
  celEvalSites,
  type CelEvalMode,
  type CelEvalSites,
  kindCelEvalSites,
  type NamedShapeLookup,
} from "./eval-paths.js";
import { ELEMENT_FROM_ITEM, itemTargetPath, readRelativePointer } from "./element-from-item.js";
import {
  CEL_ENGINE,
  celExpressionsOf,
  defaultRegistry,
  extractAccessChains,
  INDEX_SEGMENT,
  isTaggedSentinel,
  makeTaggedSentinel,
  plainChainOf,
} from "@telorun/templating";
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
import { inlineNamedShapes, navigateSchemaToExprPath, type ExternalSchemaResolver } from "./schema-compat.js";
import type { ModuleFunctionIndex, ResolvedFunction } from "./module-function-index.js";
import type { CallableFlags, CallableFlagsIndex } from "./callable-flags.js";
import { declaredDocument, navigateDeclaredChain } from "./referenced-shape.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot, type StepSlot } from "./step-slot.js";
import { withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { valueDerivedContract } from "./value-derived-contract.js";
import {
  computedProducers,
  inferredResultSchema,
  OPEN_FACT,
  producerFact,
  sameNamedResult,
  stepContextAt,
  stepContextOf,
  stepContextOver,
  stepContextWithFacts,
  type ComputedProducer,
  type StepFact,
  type StepResultAlternative,
} from "./step-result-inference.js";
import { bodyForPath, templateBodies } from "./template-body.js";
import { withCaughtData } from "./caught-member.js";
import { scopeReadAt } from "./scoped-name-resolver.js";
import type { DeclarationRequests } from "./declaration-requests.js";
import {
  contextChainAt,
  elementOfCollection,
  extractContextsFromSchema,
  getContextHolder,
  getManifestItem,
  navigateConcretePath,
  isParameterScope,
  resolveContextAnnotations,
  type MatchedContext,
} from "./validate-cel-context.js";

/** Build a closed JSON Schema for the `self` CEL variable available inside a
 *  `Telo.Definition` template body. Mirrors the runtime template controller's
 *  `const self = { ...resource, name: resource.metadata.name };` — every
 *  property the user declared in `schema:` plus synthetic `name` / `kind` and
 *  the metadata sub-object (kept open since metadata legitimately carries
 *  arbitrary user-added fields). */
export function buildSelfSchema(
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
  declarations: DeclarationRequests,
  scopes: ModuleScopes,
): Record<string, any> | undefined {
  return resolveContract(
    "inputType",
    undefined,
    definition as unknown as ResourceDefinition,
    analyzerContractScope(defs, aliases, scopes, declarations),
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
  declarations: DeclarationRequests,
  scopes: ModuleScopes,
): Record<string, any> {
  if (m.kind !== "Telo.Definition") return m;
  const inputs = lookupTemplateInputsSchema(m, defs, aliases, declarations, scopes);
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
  declarations: DeclarationRequests,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  scopes: ModuleScopes,
  /** The steps the judged expression reads; absent, every step. A step outside
   *  them and the pure steps they read is typed open, its target unread. */
  stepsRead?: ReadonlySet<string>,
): Record<string, any> | undefined {
  const bodies = stepRecordBodies(manifest, defSchema);
  if (bodies.length === 0) return undefined;
  const body = bodies.find((each) => each.entries.some(producesResult));
  if (!body) return stepContextOf({});

  const contractScope = analyzerContractScope(defs, aliases, scopes, declarations);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;
  const { invoke: invokeField, outputType: outputTypeField, value: valueField } = body.slot;

  // Every step producing a result, by name: a name may be carried by several
  // (a branch pair, a loop's seed and the step advancing it), and it is typed
  // only by what all of them produce.
  const producers = new Map<string, StepProducer[]>();
  /** The names a named template repeat publishes, with its key's type. */
  const repeats = new Map<string, string>();
  const produce = (name: string, producer: StepProducer): void => {
    const named = producers.get(name);
    if (named) named.push(producer);
    else producers.set(name, [producer]);
  };

  const alternativeOf = (producer: StepProducer): StepResultAlternative => ({
    result: resultOf(producer),
    ...(producer.at === undefined ? {} : { at: producer.at }),
  });

  // A pure step dispatches nothing, so there is no contract to resolve: a
  // tagged value is its producer's fact, settled where it is read (a forward
  // included — its producer navigates what it names), and a literal is typed by
  // its own shape (`step-result-inference.ts`).
  const resultOf = (producer: StepProducer): Record<string, any> =>
    (producer.result ??= inferredResultSchema(producer.value, producer.at!) ?? PERMISSIVE_CONTRACT);

  for (const entry of body.entries) {
    const { name, step: s, stepPath } = entry;
    if (entry.repeatKey !== undefined) repeats.set(name, entry.repeatKey);
    if (entry.form === "none") continue;
    if (entry.form === "dispatch") {
      const invoke = s[invokeField] as Record<string, any>;
      produce(name, { dispatch: () => dispatchResult(invoke, stepPath) });
      continue;
    }
    produce(name, { value: s[valueField!], at: `${stepPath}.${valueField}` });
  }

  /** What a dispatching step's result is: its target's contract. */
  function dispatchResult(invoke: Record<string, any>, stepPath: string): Record<string, any> {
    const invokedKind = invoke.kind as string | undefined;
    const invokedName = invoke.name as string | undefined;
    // A named `!ref` carries the target's own manifest (which may narrow the
    // contract for this one instance); an inline `{ kind, ... }` step IS the
    // manifest. Either way the kind layer resolves through `extends`. A step
    // in a scope's region names the scope's members first.
    const invokedManifest = invokedName
      ? (declarations.names.resolve(
          invokedName,
          readingModule,
          scopeReadAt(manifest, `${stepPath}.${invokeField}`),
          (m) => !invokedKind || m.kind === invokedKind,
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
    return contract ?? derived ?? PERMISSIVE_CONTRACT;
  }

  // The steps whose results the judged expression can reach: those it reads,
  // and those the pure steps among them read, transitively.
  const reached = stepsRead && new Set(stepsRead);
  if (reached) {
    const queue = [...reached];
    while (queue.length > 0) {
      for (const producer of producers.get(queue.shift()!) ?? []) {
        for (const read of stepNamesReadBy(producer.value)) {
          if (read === undefined) return buildStepContextSchema(manifest, defSchema, declarations, defs, aliases, scopes);
          if (!reached.has(read)) {
            reached.add(read);
            queue.push(read);
          }
        }
      }
    }
  }
  for (const [name, named] of producers) {
    for (const producer of named) {
      if (!producer.dispatch) continue;
      producer.result = reached && !reached.has(name) ? PERMISSIVE_CONTRACT : producer.dispatch();
    }
  }

  const stepProperties: Record<string, any> = {};
  for (const [name, named] of producers) {
    const entry = {
      type: "object",
      properties: { result: sameNamedResult(named.map(alternativeOf)) },
    };
    const keyed = repeats.get(name);
    // A named repeat's results are a map by element key: a map source's
    // string keys type it; a list source's int keys have no JSON Schema
    // spelling, so its entries stay open.
    stepProperties[name] =
      keyed === undefined
        ? entry
        : keyed === "string"
          ? { type: "object", additionalProperties: entry }
          : {};
  }
  return stepContextOf(stepProperties);
}

/** One step a step body registers in `steps`. */
export interface StepRecordEntry {
  readonly name: string;
  readonly step: Record<string, any>;
  /** Where the step is written in the manifest (`steps[0].try[1]`). */
  readonly stepPath: string;
  /** For a step a named template repeat emitted: the type of the repeat's
   *  element key. */
  readonly repeatKey?: string;
  /** Whether it dispatches, produces its result without dispatching, or —
   *  a control-flow wrapper a named repeat emitted — produces none. */
  readonly form: "dispatch" | "pure" | "none";
}

/** Whether a step registers a `steps.<name>.result` entry. */
function producesResult(entry: StepRecordEntry): boolean {
  return entry.form !== "none";
}

/** A field of a manifest holding a step body, and the steps it registers. */
export interface StepRecordBody {
  readonly field: string;
  readonly slot: StepSlot;
  readonly entries: readonly StepRecordEntry[];
}

/**
 * Every step body `manifest` writes where its kind's schema `defSchema`
 * declares one, in property order, each with the steps it registers in
 * `steps`, in walk order: a step a named template repeat emitted under the
 * repeat's name, an unnamed repeat's steps and a step producing no result (a
 * control-flow wrapper) not at all. The one reader of step names — the
 * `steps` record, the step-names class and a whole read of `steps` all list
 * names through it.
 */
export function stepRecordBodies(manifest: Record<string, any>, defSchema: Record<string, any>): StepRecordBody[] {
  const props = defSchema.properties as Record<string, any> | undefined;
  if (!props) return [];
  const out: StepRecordBody[] = [];
  for (const [field, fieldSchema] of Object.entries(props)) {
    const slot = readStepSlot(fieldSchema);
    if (!slot) continue;
    const steps = manifest[field];
    if (!Array.isArray(steps)) continue;
    const itemSchema = resolveLocalRef(fieldSchema.items as Record<string, any> | undefined, defSchema);
    const entries: StepRecordEntry[] = [];
    walkStepArray(steps, itemSchema, defSchema, field, (s, stepPath) => {
      const emitted = emittedStepIdentity(s);
      if (emitted && !("repeat" in emitted)) return;
      const name = emitted && "repeat" in emitted ? emitted.repeat : s.name;
      if (typeof name !== "string") return;
      const repeatKey = emitted && "repeat" in emitted ? typeof emitted.key : undefined;
      const invoke = s[slot.invoke];
      // Only invoke and value steps register a `steps.<name>.result` entry —
      // control-flow wrappers (try/if/while/switch/throw) don't produce a
      // result and must not shadow real entries with a permissive
      // `additionalProperties: true`, or unknown step references slip through
      // chain validation.
      const form =
        invoke && typeof invoke === "object" ? "dispatch" : slot.value && slot.value in s ? "pure" : "none";
      if (form === "none" && repeatKey === undefined) return;
      entries.push({ name, step: s, stepPath, ...(repeatKey !== undefined ? { repeatKey } : {}), form });
    });
    out.push({ field, slot, entries });
  }
  return out;
}

/** The names the `steps` record of `manifest` lists, in order: the first step
 *  body registering any; empty where its bodies register none, undefined where
 *  it writes no step body. */
export function stepRecordNames(manifest: Record<string, any>, defSchema: Record<string, any>): string[] | undefined {
  const bodies = stepRecordBodies(manifest, defSchema);
  if (bodies.length === 0) return undefined;
  const body = bodies.find((each) => each.entries.some(producesResult));
  return [...new Set((body?.entries ?? []).filter(producesResult).map((entry) => entry.name))];
}

/** One step producing `steps.<name>.result`: a dispatch's contract, or a pure
 *  step's value, resolved when first read. */
interface StepProducer {
  result?: Record<string, any>;
  /** A dispatching step's result, read from its target. */
  dispatch?: () => Record<string, any>;
  value?: unknown;
  /** Where a pure step's value is written. */
  at?: string;
}

/** Where a resource of this kind receives call arguments: undefined unless its
 *  effective capability is in the `Telo.Executable` lineage; otherwise its eval
 *  sites, since a compile-eval field is resolved before any call exists. */
function callArgumentSites(
  definition: ResourceDefinition | undefined,
  defs: DefinitionRegistry,
  resolveDef: DefResolver,
  shapes: NamedShapeLookup,
): CelEvalSites | undefined {
  if (!definition) return undefined;
  const capability = inheritedCapability(definition, resolveDef);
  if (capability === undefined || !capabilityExtendsExecutable(capability, defs)) return undefined;
  return kindCelEvalSites(definition, resolveDef, shapes);
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
  /** A named shape by its id — what every `$ref: telo:<Module>/<Type>` a
   *  context, a contract or an eval site reaches resolves to. */
  shapes: NamedShapeLookup;
  /** Every other declaration a scope reads, by request — the slots
   *  referencing a resource among them: with none, a binding typed from its
   *  referrer is what it declares itself. */
  declarations: DeclarationRequests;
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
  /** A referrer's kind, resolved in the scope of the module declaring it. */
  definitionOf?: (m: ResourceManifest) => ResourceDefinition | undefined;
  /** The data of the codes the catch entry holding `path` matches — the catch
   *  ladder's answer — which every `x-telo-caught-member: data` member of the
   *  site's context takes. Absent, or undefined for a path, a marked member keeps
   *  the schema it declares. */
  caughtDataAt?: (m: ResourceManifest, path: string) => Record<string, any> | undefined;
  /** The loop bindings a template body's `!for-each` puts in scope at `path`
   *  of an expanded definition, as context properties. */
  loopBindingsAt?: (m: ResourceManifest, path: string) => Record<string, Record<string, any>> | undefined;
  /** The steps the expressions judged read; absent, every step. */
  stepsRead?: ReadonlySet<string>;
  /** Every name the `steps` record of a resource lists, in order, where the
   *  resource holds only the steps read ({@link stepContextOver}); absent, the
   *  names its steps carry. */
  stepNamesAt?: (m: ResourceManifest) => readonly string[] | undefined;
  /** The typed environments built so far, shared by every resolver of one
   *  analysis; absent, the resolver keeps its own. */
  typedEnvironments?: TypedEnvironments;
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

/** The names `buildTypedCelEnvironment` registers before a context's, so a
 *  context property of one of them never reaches the environment. */
const GLOBALS_TYPED_FROM_BLOCKS: ReadonlySet<string> = new Set(["variables", "ports", "secrets", "resources", "module"]);

export class CelScopeResolver {
  /** The context standing in where no `x-telo-context` matched, one per
   *  module's globals. */
  private readonly fallbackContexts = new WeakMap<Record<string, any>, Record<string, any>>();
  private readonly typedEnvironments: TypedEnvironments;

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
  /** The resource entered last. */
  private current: ResourceManifest | undefined;
  /** Per step context: its computed producers' facts and read groups. */
  private readonly stepFacts = new WeakMap<object, StepFacts>();
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
    this.typedEnvironments = inputs.typedEnvironments ?? new TypedEnvironments();
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
      for (const { manifest: referrer, path } of this.inputs.declarations.referrersOf(m)) {
        const definition = this.inputs.definitionOf?.(referrer);
        const authorSchema = defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
        if (!authorSchema) continue;
        const regions = contextChainAt(extractContextsFromSchema(authorSchema, this.inputs.shapes), path);
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
    const { declarations, defs, aliases, scopes, shapes } = this.inputs;
    this.current = m;
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
          declarations,
          defs,
          aliases,
          scopes,
          this.inputs.stepsRead,
        )
      : undefined;
    const stepNames = this.inputs.stepNamesAt?.(m);
    if (stepNames) this.stepContext = stepContextOver(this.stepContext ?? stepContextOf({}), stepNames);
    this.errorScopes = collectErrorContextScopes(authorSchema);
    this.kindContexts = authorSchema ? extractContextsFromSchema(authorSchema, shapes) : [];
    this.kindSites = celEvalSites(authorSchema, shapes);
    const contractScope = analyzerContractScope(defs, aliases, scopes, declarations);
    const resolveDef = contractScope.resolveDefinition;
    this.argumentSites = this.stepContext
      ? callArgumentSites(definition, defs, resolveDef, shapes)
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
            declarations,
            defs,
            aliases,
            scopes,
            this.inputs.stepsRead,
          )
        : undefined;
      const argumentSites = stepContext
        ? callArgumentSites(body.definition, defs, resolveDef, shapes)
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
        contexts: bodySchema ? extractContextsFromSchema(bodySchema, shapes) : [],
        sites: celEvalSites(bodySchema, shapes),
      };
    });
  }

  /**
   * What the expression at `site` is typed against.
   *
   * The environment is taken from the analysis's typed environments, keyed by
   * the content it is built from — the typing (a parameter scope, an import's
   * inputs, or the kernel globals), the declaring module's blocks, the context
   * schema and the module namespaces with their callables — so a site whose
   * inputs equal another's, in any key, reads the environment already built.
   */
  scopeFor(site: CelSiteRef): CelScope {
    reportKeyCost({ kind: "scope" });
    const m = site.source;
    const parameterScope = isParameterScope(site.contextSchema ?? this.invocationContext);
    const contextSchema = this.resolveContextFor(site, parameterScope);
    const {
      celEnv,
      declarations,
      moduleManifest,
    } = this.inputs;

    const functions = this.inputs.moduleFunctions;
    const resolved = (qualified: string) => {
      const resolution = functions?.resolve(m, qualified);
      return resolution?.status === "resolved" ? resolution : undefined;
    };
    const moduleNames = moduleCallNamesOf(this.inputs.moduleCallNames ?? NO_MODULE_CALL_NAMES, m);
    // The module's own names are NAMESPACES on the environment the site is
    // read against, which is what turns `Billing.total(x)` into a qualified
    // call as it is READ — the engine resolves it there, never afterwards.
    const namespaces = [...celNamespaceNames(moduleNames)].map((receiver) => ({
      receiver,
      callables: (functions?.callablesThrough(m, receiver) ?? []).map((entry) => ({
        name: entry.name,
        celType: entry.function.celType,
      })),
    }));

    // An import's `needs:` supply is evaluated in the importer's scope like any
    // startup field — `resources` included — unlike its config-only
    // `variables:` / `secrets:`, so the two never share an environment.
    const importNeeds = m.kind === "Telo.Import" && site.path.startsWith("needs.");
    const metadata = m.metadata as { module?: string; moduleGlobals?: unknown } | undefined;
    let typing: Record<string, unknown>;
    let build: () => CelEnvironment;
    if (parameterScope) {
      typing = { typing: "parameter", context: contextSchema };
      build = () => buildParameterCelEnvironment(celEnv, contextSchema);
    } else if (m.kind === "Telo.Import" && !importNeeds) {
      // A `Telo.Import`'s variables/secrets are a config-only contract evaluated
      // in the IMPORTING module's scope, so they type from the owning module doc
      // and drop `resources`/`env`, making a reference to either an error.
      const owner = declarations
        .moduleDocuments()
        .find((mm) => (mm.metadata as { name?: string } | undefined)?.name === metadata?.module) as
        | Record<string, any>
        | undefined;
      typing = { typing: "import", variables: owner?.variables, secrets: owner?.secrets, metadata: owner?.metadata };
      build = () => buildImportInputCelEnvironment(celEnv, owner as ResourceManifest | undefined);
    } else {
      const kindDocument = isKindDocument(m);
      const own = m as Record<string, any>;
      const root = moduleManifest as Record<string, any> | undefined;
      typing = {
        typing: "globals",
        kindDocument,
        declaring: isModuleKind(m.kind) ? { variables: own.variables, secrets: own.secrets } : undefined,
        moduleGlobals: metadata?.moduleGlobals,
        // A module's shared globals base is one identity for the analysis.
        root:
          root && this.typedEnvironments.identifies(root)
            ? root
            : root && { variables: root.variables, secrets: root.secrets, ports: root.ports, metadata: root.metadata },
        ports: root ? undefined : own.ports,
        // The kernel globals are typed from the module's blocks above, never
        // from the context: only what the context binds beside them counts.
        context: contextSchema?.properties
          ? Object.fromEntries(
              Object.entries(contextSchema.properties as Record<string, unknown>).filter(
                ([name]) => !GLOBALS_TYPED_FROM_BLOCKS.has(name),
              ),
            )
          : undefined,
      };
      build = () => buildTypedCelEnvironment(celEnv, m, contextSchema ?? undefined, moduleManifest);
    }
    const env = this.typedEnvironments.environmentFor({ ...typing, namespaces }, () => {
      const built = build();
      registerModuleNamespaces(built, moduleNames, (receiver) =>
        namespaces.find((namespace) => namespace.receiver === receiver)?.callables ?? [],
      );
      return built;
    });

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
              this.inputs.kernelGlobals.forResource(m, site.path),
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
          steps: this.stepsAt(stepContext, localPath, inBody),
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
      const globals = this.inputs.kernelGlobals.forResource(m, path);
      let fallback = this.fallbackContexts.get(globals);
      if (!fallback) {
        fallback = mergeKernelGlobalsIntoContext(
          { type: "object", additionalProperties: true, properties: {} },
          globals,
        );
        this.fallbackContexts.set(globals, fallback);
      }
      return fallback;
    }

    const { defs, aliases, scopes, declarations, kernelGlobals } = this.inputs;

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
          declarations,
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
          declarations,
          shapes: this.inputs.shapes,
          sitePath: localPath,
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
    // Inside a catch entry, a member marked as the caught failure's data is the
    // data of the codes that entry matches.
    const caught = this.inputs.caughtDataAt?.(m, path);
    if (caught) resolved = withCaughtData(resolved, caught);
    // A loop's binding is in scope throughout what the loop emits.
    const loops = this.inputs.loopBindingsAt?.(m, path);
    if (loops) resolved = { ...resolved, properties: { ...(resolved.properties ?? {}), ...loops } };
    // A named shape nested anywhere in the context — a contract's
    // `outputType: { properties: { x: !ref Money } }`, an input declared as
    // `!ref Shape` — is a `$ref` the member walk cannot see through, so it is
    // expanded here, once, for every binding the site reads. Contract
    // resolution keeps the reference: the kernel shares it and keys its
    // validators on the schema's identity.
    const expand = (schema: Record<string, any>) =>
      inlineNamedShapes(schema, this.inputs.shapes);
    if (parameterScope) return expand(resolved);
    return expand(
      mergeKernelGlobalsIntoContext(
        resolved,
        // Typed in the module that DECLARED this resource — for a manifest
        // forwarded from an imported library, that is its `moduleGlobals` stamp,
        // not the consuming application's block.
        kernelGlobals.forResource(m, path),
      ),
    );
  }

  /**
   * The `steps` context the expression at `localPath` reads, each computed
   * result its producer's fact. A producer's own value reads only the steps it
   * names, and the members of its read group as `dyn`; any other site reads the
   * steps the judged expressions read (every step when that is not known).
   */
  private stepsAt(
    stepContext: Record<string, any>,
    localPath: string,
    body: CelScopeResolver["bodyScopes"][number] | undefined,
  ): Record<string, any> {
    const state = this.stepFactsOf(stepContext);
    const view = stepContextAt(stepContext, localPath);
    const producer = state.producers.find((each) => each.at === localPath);
    const key = producer ? producer.at : "";
    let byKey = state.views.get(view);
    if (!byKey) state.views.set(view, (byKey = new Map()));
    const known = byKey.get(key);
    if (known) return known;
    const fact = (other: ComputedProducer) => this.stepFact(stepContext, other, body);
    const group = producer ? state.groupOf.get(producer.at)! : undefined;
    const settled = producer
      ? stepContextWithFacts(view, state.readsOf.get(producer.at), (other) => (group!.has(other.at) ? OPEN_FACT : fact(other)))
      : stepContextWithFacts(view, this.inputs.stepsRead, fact);
    byKey.set(key, settled);
    return settled;
  }

  /** The `steps` record the expression at `path` reads, each computed result
   *  its producer's fact; undefined outside a step body. */
  stepsReadAt(path: string): Record<string, any> | undefined {
    const inBody = this.bodyScopes.length > 0 ? bodyForPath(this.bodyScopes, path) : undefined;
    const stepContext = inBody ? inBody.stepContext : this.stepContext;
    if (!stepContext) return undefined;
    return this.stepsAt(stepContext, inBody ? path.slice(inBody.prefix.length + 1) : path, inBody);
  }

  /** A computed producer's fact, judged once in the environment of its own
   *  site: what its tag's engine types it as, and what its plain chain
   *  forwards as that site navigates it ({@link producerFact}). */
  private stepFact(
    stepContext: Record<string, any>,
    producer: ComputedProducer,
    body: CelScopeResolver["bodyScopes"][number] | undefined,
  ): StepFact {
    const state = this.stepFactsOf(stepContext);
    const known = state.facts.get(producer.at);
    if (known !== undefined) return known;
    if (state.inProgress.has(producer.at)) {
      throw new Error(`internal: the result of step '${producer.name}' at '${producer.at}' was asked for while it was being typed.`);
    }
    state.inProgress.add(producer.at);
    try {
      reportKeyCost({ kind: "step-result-probe", body: stepContext, producer: producer.at });
      const regions = contextChainAt(body ? body.contexts : this.kindContexts, producer.at).map((ctx) =>
        body ? { ...ctx, scope: `${body.scopePrefix}${ctx.scope.slice(1)}` } : ctx,
      );
      const innermost = regions[regions.length - 1];
      const path = body ? `${body.prefix}.${producer.at}` : producer.at;
      const scope = this.scopeFor({
        source: this.current!,
        path,
        ...(innermost ? { contextSchema: innermost.schema, matchedScope: innermost.scope } : {}),
        contexts: regions,
        mode: celEvalModeAt(body ? body.sites : this.kindSites, producer.at) ?? undefined,
      });
      const analyzed = defaultRegistry().get(producer.engine)?.analyze(producer.source, {
        celEnv: scope.env,
        contextSchema: scope.contextSchema,
        moduleNames: scope.moduleNames,
        moduleCallType: scope.moduleCallType,
        moduleCallResult: scope.moduleCallResult,
        moduleCallFlags: scope.moduleCallFlags,
      });
      const chain = plainChainOf(makeTaggedSentinel(producer.engine, producer.source));
      const produced = chain
        ? declaredChainSchemaAt(
            chain,
            scope.contextSchema ?? this.inputs.kernelGlobals.forResource(this.current!, path),
            this.stepsAt(stepContext, producer.at, body),
            this.inputs.shapes,
          )
        : undefined;
      const fact = producerFact(producer.engine, analyzed?.type, produced);
      state.facts.set(producer.at, fact);
      return fact;
    } finally {
      state.inProgress.delete(producer.at);
    }
  }

  /** The computed producers of a step context, the steps each reads and the
   *  strongly connected group of step reads each belongs to. */
  private stepFactsOf(stepContext: Record<string, any>): StepFacts {
    const known = this.stepFacts.get(stepContext);
    if (known) return known;
    const producers = computedProducers(stepContext);
    const readsOf = new Map<string, ReadonlySet<string> | undefined>();
    for (const producer of producers) {
      const reads = stepNamesReadIn(producer.engine, producer.source);
      readsOf.set(producer.at, reads.includes(undefined) ? undefined : new Set(reads as string[]));
    }
    // A producer reads every OTHER producer of a name it reads.
    const edges = (from: ComputedProducer) =>
      producers.filter((to) => {
        if (to === from) return false;
        const reads = readsOf.get(from.at);
        return reads === undefined || reads.has(to.name);
      });
    const state: StepFacts = {
      producers,
      readsOf,
      groupOf: stronglyConnectedGroups(producers, edges),
      facts: new Map(),
      inProgress: new Set(),
      views: new WeakMap(),
    };
    this.stepFacts.set(stepContext, state);
    return state;
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
        navigateDeclaredChain(context, chain, this.inputs.shapes),
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

/** What one step context's computed producers are, read and typed as. */
interface StepFacts {
  readonly producers: readonly ComputedProducer[];
  /** The step names each producer's expression reads; undefined for `steps` whole. */
  readonly readsOf: ReadonlyMap<string, ReadonlySet<string> | undefined>;
  /** Each producer's strongly connected group of step reads, itself included. */
  readonly groupOf: ReadonlyMap<string, ReadonlySet<string>>;
  readonly facts: Map<string, StepFact>;
  readonly inProgress: Set<string>;
  /** The settled `steps` context per view and reading producer. */
  readonly views: WeakMap<object, Map<string, Record<string, any>>>;
}

/**
 * The schema the plain chain `chain` resolves to where `context` is in force,
 * references followed — a step chain read off `steps`, the record the site
 * reads, where each result is its target's own document or its producer's
 * fact; undefined where nothing is declared. The one navigation a producer's
 * forwarded schema and an expression's produced schema are both read by.
 */
export function declaredChainSchemaAt(
  chain: string,
  context: Record<string, any>,
  steps: Record<string, any> | undefined,
  shapes: ExternalSchemaResolver | undefined,
): Record<string, any> | undefined {
  if (steps === undefined || !chain.startsWith(STEPS_ROOT)) return navigateDeclaredChain(context, chain, shapes);
  const within = chain.slice(STEPS_ROOT.length);
  // An undeclared result is the absence of a claim, not a producer saying `object`.
  if (navigateSchemaToExprPath(steps, within) === PERMISSIVE_CONTRACT) return undefined;
  return navigateDeclaredChain(steps, within, shapes);
}

const STEPS_ROOT = "steps.";

/** Each producer's strongly connected group under `edges`, by its site. */
function stronglyConnectedGroups(
  producers: readonly ComputedProducer[],
  edges: (from: ComputedProducer) => readonly ComputedProducer[],
): Map<string, ReadonlySet<string>> {
  const groupOf = new Map<string, ReadonlySet<string>>();
  const index = new Map<ComputedProducer, number>();
  const low = new Map<ComputedProducer, number>();
  const stack: ComputedProducer[] = [];
  const onStack = new Set<ComputedProducer>();
  let counter = 0;
  const strong = (v: ComputedProducer): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges(v)) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const members = new Set<string>();
    let member: ComputedProducer;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.add(member.at);
    } while (member !== v);
    for (const at of members) groupOf.set(at, members);
  };
  for (const producer of producers) if (!index.has(producer)) strong(producer);
  return groupOf;
}

/** The step names an expression of `engine` written as `source` reads —
 *  `undefined` among them for a read of `steps` whole or by a computed name. */
export function stepNamesReadIn(engine: string, source: string): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const expression of celExpressionsOf(engine, source)) {
    const parsed = parseCelSource(expression);
    if (!parsed) continue;
    for (const chain of extractAccessChains(parsed.root)) {
      if (chain[0] !== "steps") continue;
      out.push(chain.length < 2 || chain[1] === INDEX_SEGMENT ? undefined : chain[1]);
    }
  }
  return out;
}

/** The step names the expressions inside `value` read — `undefined` among
 *  them for a read of `steps` whole or by a computed name. */
export function stepNamesReadBy(value: unknown): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const visit = (node: unknown): void => {
    if (isTaggedSentinel(node)) {
      out.push(...stepNamesReadIn(node.engine, node.source));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const field of Array.isArray(node) ? node : Object.values(node)) visit(field);
  };
  visit(value);
  return out;
}
