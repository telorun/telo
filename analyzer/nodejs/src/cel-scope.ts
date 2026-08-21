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
import type { Environment } from "@marcbachmann/cel-js";
import { AliasResolver, type ModuleScopes } from "./alias-resolver.js";
import {
  bindingContextProperties,
  bindingPathChain,
  BINDINGS_ANNOTATION,
  schemaAtChain,
} from "./cel-bindings.js";
import { buildImportInputCelEnvironment, buildTypedCelEnvironment } from "./cel-environment.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { type ContractDirection, effectiveAuthorSchema } from "./extends-resolution.js";
import {
  analyzerContractScope,
  PERMISSIVE_CONTRACT,
  resolveContract,
} from "./invocation-contract.js";
import {
  mergeKernelGlobalsIntoContext,
  type KernelGlobalsIndex,
} from "./kernel-globals.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import {
  getManifestItem,
  resolveContextAnnotations,
  resolveTypeFieldToSchema,
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

  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const stepCtx = readStepSlot(fieldSchema);
    if (!stepCtx) continue;

    const invokeField = stepCtx.invoke;
    const outputTypeField = stepCtx.outputType;
    // Optional: the field a step uses to produce a result without dispatching.
    // Only a kind that declares one has pure steps at all.
    const valueField = stepCtx.value;
    if (!invokeField || !outputTypeField) continue;

    const steps = manifest[fieldName];
    if (!Array.isArray(steps)) continue;

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

    const stepProperties: Record<string, any> = {};

    walkStepArray(steps, stepItemSchema, defSchema, fieldName, (s) => {
      const name = s.name;
      const invoke = s[invokeField] as Record<string, any> | undefined;
      // Only invoke steps register a `steps.<name>.result` entry — control-flow
      // wrappers (try/if/while/switch/throw) don't produce a result and must
      // not shadow real entries with a permissive `additionalProperties: true`,
      // or unknown step references slip through chain validation.
      if (typeof name !== "string") return;
      if (!invoke || typeof invoke !== "object") {
        // A pure step dispatches nothing, so there is no contract to resolve.
        // Where its expression is a plain chain into something already typed —
        // an earlier step's result, or the kind's own inputs — that type carries
        // through; anything else (arithmetic, a call, a comprehension) stays
        // permissive rather than guessed. Same rule as a named binding's.
        if (valueField && valueField in s) {
          const scopeRoot = {
            properties: {
              steps: { type: "object", properties: { ...stepProperties } },
              ...(ownInputs ? { inputs: ownInputs } : {}),
            },
          };
          const chained = schemaAtChain(bindingPathChain(s[valueField]), scopeRoot);
          stepProperties[name] = {
            type: "object",
            properties: { result: chained ?? PERMISSIVE_CONTRACT },
          };
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
      const outputSchema = resolveContract(
        outputTypeField as ContractDirection,
        invokedManifest,
        invokedDef,
        contractScope,
      )?.schema;
      stepProperties[name] = {
        type: "object",
        properties: {
          result: outputSchema ?? PERMISSIVE_CONTRACT,
        },
      };
    });

    if (Object.keys(stepProperties).length > 0) {
      return {
        type: "object",
        properties: stepProperties,
      };
    }
  }

  return undefined;
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
  env: Environment;
  /** The resolved `x-telo-context` schema merged with the kernel globals, or
   *  null when no context applied (the environment alone types the site). */
  contextSchema: Record<string, any> | null;
}

/** The analyzer state a scope is resolved against — everything a manifest set
 *  contributes, gathered once per analysis. */
export interface CelScopeInputs {
  /** The base (untyped) CEL environment. */
  celEnv: Environment;
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  scopes: ModuleScopes;
  allManifests: ResourceManifest[];
  kernelGlobals: KernelGlobalsIndex;
  /** The module doc carrying the Application-only `ports` namespace. */
  moduleManifest?: ResourceManifest;
  /** The observed-state-only context, used where no `x-telo-context` matched. */
  observedStateContext: Record<string, any> | null;
}

/** One CEL site, as the manifest visitor reports it. Structural on purpose —
 *  the resolver takes the fields it reads, not the visitor's event type, so a
 *  caller that located a site some other way (a cursor in an editor buffer) can
 *  ask the same question. */
export interface CelSiteRef {
  source: ResourceManifest;
  path: string;
  contextSchema?: Record<string, any>;
  matchedScope?: string;
}

/**
 * The CEL scope rule, applied per resource and then per expression.
 *
 * Stateful across a resource because the per-resource half — the step context,
 * the error-bearing regions, the invocation context — is derived from the kind's
 * schema once and read by every expression in that resource. `enterResource`
 * establishes it; `scopeFor` answers for one path.
 */
export class CelScopeResolver {
  private readonly typedEnvByManifest = new Map<ResourceManifest, Environment>();

  /** Per-resource state, replaced at each `enterResource`. */
  private stepContext: Record<string, any> | undefined;
  private invocationContext: Record<string, any> | undefined;
  private errorScopes: Map<string, Record<string, any>> = new Map();

  constructor(private readonly inputs: CelScopeInputs) {}

  /** The `steps` context schema for the current resource, or undefined when its
   *  kind declares no step body. Exposed because the step-inputs check needs the
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
    this.stepContext = definition?.schema
      ? buildStepContextSchema(
          m as Record<string, any>,
          definition.schema as Record<string, any>,
          allManifests as Record<string, any>[],
          defs,
          aliases,
          scopes,
        )
      : undefined;
    this.errorScopes = collectErrorContextScopes(
      definition?.schema as Record<string, any> | undefined,
    );
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
    const contextSchema = this.resolveContextFor(site);
    const {
      celEnv,
      allManifests,
      moduleManifest,
    } = this.inputs;

    const cached = contextSchema === null ? this.typedEnvByManifest.get(m) : undefined;
    const env =
      cached ??
      // A `Telo.Import`'s variables/secrets are a config-only contract evaluated
      // in the IMPORTING module's scope, so they type from the owning module doc
      // and drop `resources`/`env`, making a reference to either an error.
      (m.kind === "Telo.Import"
        ? buildImportInputCelEnvironment(
            celEnv,
            allManifests.find(
              (mm) =>
                (mm.kind === "Telo.Application" || mm.kind === "Telo.Library") &&
                (mm.metadata as { name?: string } | undefined)?.name ===
                  (m.metadata as { module?: string } | undefined)?.module,
            ),
          )
        : buildTypedCelEnvironment(
            celEnv,
            m,
            contextSchema ?? undefined,
            moduleManifest,
          ));
    if (contextSchema === null && !cached) this.typedEnvByManifest.set(m, env);

    return { env, contextSchema };
  }

  /** The context schema in force at `site`: the matched `x-telo-context` (or the
   *  resource-wide invocation context), plus the step and error regions this
   *  path falls in, resolved and merged with the kernel globals. */
  private resolveContextFor(site: CelSiteRef): Record<string, any> | null {
    const { path } = site;
    const m = site.source;
    let matched: Record<string, any> | undefined = site.contextSchema ?? this.invocationContext;

    if (this.stepContext) {
      const base = matched ?? { type: "object", properties: {}, additionalProperties: true };
      matched = {
        ...base,
        properties: { ...(base.properties ?? {}), steps: this.stepContext },
      };
    }

    // `error` is only in scope inside an error-bearing branch (e.g. a
    // `catch:` / `finally:`), so it's merged per-path, not resource-wide.
    const errorSchema =
      this.errorScopes.size > 0 ? errorContextForPath(path, this.errorScopes) : undefined;
    if (errorSchema) {
      const base = matched ?? { type: "object", properties: {}, additionalProperties: true };
      matched = {
        ...base,
        properties: { ...(base.properties ?? {}), error: errorSchema },
      };
    }

    if (!matched) {
      // No `x-telo-context` matched, so nothing was chain-validated here before.
      // Validate the observed-state segment alone rather than merging the kernel
      // globals, whose closed `variables` / `ports` nodes would newly reject
      // reads that pass today.
      return this.inputs.observedStateContext;
    }

    const { defs, aliases, scopes, allManifests, kernelGlobals } = this.inputs;
    const manifestItem = site.matchedScope
      ? getManifestItem(path, site.matchedScope, m as Record<string, any>)
      : (m as Record<string, any>);
    const rootForResolver = manifestRootForResolver(
      m as Record<string, any>,
      defs,
      aliases,
      allManifests as Record<string, any>[],
      scopes,
    );
    const resolved = resolveContextAnnotations(matched, manifestItem, {
      manifestRoot: rootForResolver,
      defs,
      aliases,
      allManifests: allManifests as Record<string, any>[],
    });
    return mergeKernelGlobalsIntoContext(
      withBindingNames(resolved, m as Record<string, any>),
      // Typed in the module that DECLARED this resource — for a manifest
      // forwarded from an imported library, that is its `moduleGlobals` stamp,
      // not the consuming application's block.
      kernelGlobals.forResource(m),
    );
  }
}
