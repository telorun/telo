import {
  InvokeError,
  NoopValidator,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
  RuntimeResource,
  UNCANCELLABLE_CONTEXT,
  createCancellationSource,
  deriveContext,
  getRefIdentity,
  resolveRefInstance,
  type CancellationSource,
  type ControllerPolicy,
  type EvaluationContext as IEvaluationContext,
  type InvokeByNameOptions,
  type InvokeContext,
  type LoadOptions,
  type ModuleContext,
  type Logger,
  type OpenSpan,
  type OpenSpanOptions,
  type ParsedArgs,
  type ResourceDefinition,
  type ResourceHandle,
  type RuntimeSeam,
  type TypeRule,
  type ZoneEntry,
} from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { ZoneContext } from "./zone-context.js";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ModuleArtifact } from "./bundle/module-artifact.js";
import { hostEnv } from "./host-env.js";
import type { LoggingHost } from "./logging/logging-host.js";
import type { ScopeConfig } from "./logging/scope-config.js";

/** The kernel's `ModuleContext` as far as logging is concerned. Declared
 *  structurally rather than imported to avoid a module cycle. */
interface KernelModuleContext {
  getLoggingConfig?(): ScopeConfig | undefined;
}
import { stripCompiledValues } from "./schema-compiled-values.js";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { Kernel } from "./kernel.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { policyFingerprint } from "./runtime-registry.js";
import { KernelRuntimeSeam } from "./runtime-seam.js";
import { SchemaValidator } from "./schema-validator.js";

const Ajv = AjvModule.default ?? AjvModule;

/** How long a resource's teardown waits for its in-flight detached tasks before
 *  abandoning them (with a logged event). */
const DETACHED_DRAIN_TIMEOUT_MS = 5000;

export class ResourceContextImpl implements ResourceContext {
  readonly env: Record<string, string | undefined>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly args: ParsedArgs;
  /** Id prefix of the context this resource was created in. A controller that
   *  spawns sub-resources composes their ids as `ownerPrefix + kind + "." + name`
   *  and stamps the owner on the child context it registers them into. */
  readonly ownerPrefix: string;

  /** Built lazily: most resources never log, and constructing the scoped logger
   *  eagerly for every context would allocate per resource for nothing. */
  #log: Logger | undefined;

  /**
   * The resource's structured logger, stamped with its identity, module, and
   * import-alias scope so a record identifies *which instance* emitted it — the
   * distinction `module` alone cannot make when the same library is imported
   * twice (§7.3).
   */
  get log(): Logger {
    if (!this.#log) {
      const kind = this.metadata?.kind as string | undefined;
      const name = this.metadata?.metadata?.name as string | undefined;
      const resource =
        kind && name
          ? { kind, name, id: `${this.ownerPrefix}${kind}.${name}` }
          : undefined;
      // The runtime value is always the kernel's `ModuleContext`, which carries
      // the resolved per-scope config; the field is typed as the SDK's narrower
      // interface, which deliberately does not expose kernel-internal state.
      const scope = (
        this.moduleContext as unknown as KernelModuleContext
      ).getLoggingConfig?.();
      this.#log = this.kernel.logging.createLogger(scope, resource);
    }
    return this.#log;
  }

  /** The sink-facing half of the pipeline. Only the built-in sink controllers
   *  reach for it; every other controller uses {@link log}. */
  get logging(): LoggingHost {
    return this.kernel.logging.host;
  }

  /** Built lazily and shared per resource: the seam holds no per-call state, and
   *  most controllers never run or analyze a manifest. */
  #runtime: RuntimeSeam | undefined;

  /** The host's own manifest machinery — see {@link RuntimeSeam}. Reached
   *  through the context so a module that needs it (`test` runs a child
   *  manifest, `assert` analyzes one) binds to a versioned contract instead of
   *  importing the kernel. */
  get runtime(): RuntimeSeam {
    if (!this.#runtime) this.#runtime = new KernelRuntimeSeam(this.kernel);
    return this.#runtime;
  }

  kernelLoggingRootScope(): ScopeConfig {
    return this.kernel.logging.rootScope;
  }

  constructor(
    readonly kernel: Kernel,
    readonly moduleContext: ModuleContext,
    private readonly metadata: Record<string, any>,
    private readonly validator: SchemaValidator = new SchemaValidator(),
    env?: Record<string, string | undefined>,
    stdin?: NodeJS.ReadableStream,
    stdout?: NodeJS.WritableStream,
    stderr?: NodeJS.WritableStream,
    args?: ParsedArgs,
    ownerPrefix = "",
    /**
     * The context that OWNS this instance — the module context for a top-level
     * resource, the per-run scope child for a `with:`-scoped one.
     *
     * Everything resource-scoped goes through here: registering a manifest,
     * resolving a sibling by name, expanding CEL, spawning a child context,
     * dispatching, publishing. `moduleContext` is reserved for what genuinely
     * belongs to the MODULE rather than to this resource's context — imports
     * (`registerImport` / `resolveImported*`), the controller policy, and the
     * logging scope, all of which a scope child inherits rather than owns.
     *
     * Getting this wrong is not cosmetic: a scoped resource that registers an
     * inline definition into the module lands it in a pending queue the module's
     * init loop has already drained, so the resource is never created and the
     * dispatch fails.
     */
    private readonly owningContext: IEvaluationContext = moduleContext,
  ) {
    // `ctx.env` is the sanctioned host-env channel for controllers — always the
    // real environment (kernel passes its snapshot), never the locked Proxy.
    this.env = env ?? hostEnv();
    this.stdin = stdin ?? process.stdin;
    this.stdout = stdout ?? process.stdout;
    this.stderr = stderr ?? process.stderr;
    this.args = args ?? { _: [] };
    this.ownerPrefix = ownerPrefix;
  }

  /**
   * Where a NAME resolves from: the owning context first, then the enclosing
   * module. Same order as `ScopeContext.getInstance` and the CEL `resources`
   * layering — scope-local wins, outer is the fallback — so a `with:`-scoped
   * resource can still dispatch a module-level one by name (an `Http.Server`
   * whose `notFoundHandler` targets a module-level invocable).
   *
   * Registration deliberately does NOT use this: a new manifest belongs to the
   * context that owns the resource creating it, never to the module.
   */
  private contextForName(name: string): IEvaluationContext {
    return this.owningContext.resourceInstances.has(name)
      ? this.owningContext
      : this.moduleContext;
  }

  createSchemaValidator(schema: any) {
    if (!schema) {
      return new NoopValidator();
    }
    return this.validator.compile(schema);
  }

  registerSchema(name: string, schema: object): void {
    this.validator.addSchema(name, schema);
  }

  lookupSchema(name: string): object | undefined {
    return this.validator.getSchema(name);
  }

  registerTypeRules(name: string, rules: TypeRule[]): void {
    this.validator.addTypeRules(name, rules);
  }

  lookupTypeRules(name: string): TypeRule[] | undefined {
    return this.validator.getTypeRules(name);
  }

  /** The JSON Schema behind a type field, resolved the same four ways
   *  {@link createTypeValidator} resolves it (named ref, `{kind, name}` ref
   *  object, inline `{kind, schema}`, raw schema), and then followed through a
   *  bare `telo://<module>/<Type>` `$ref` to the schema that type registered.
   *
   *  Following the `$ref` matters because AJV resolves cross-schema references
   *  against its own registry at compile time, while the kernel's registry is
   *  what actually holds these — a `Type.JsonSchema` registers under the
   *  canonical URI as a *key*, which AJV does not treat as a resolvable id. A
   *  definition whose whole contract is `{ $ref: "telo://Self/TokenSet" }` (the
   *  sanctioned way to declare a shape once and reference it from several kinds)
   *  would otherwise be uncompilable at dispatch. Resolving here means AJV is
   *  handed the real schema and never has to resolve the reference at all.
   *
   *  Contract binding needs the schema rather than just a compiled validator
   *  anyway, for the decisions a validator cannot answer: which properties carry
   *  `x-telo-stream` and must be exempt from the walk, and which paths a
   *  `default:` can be written to. Returns undefined when the reference resolves
   *  to nothing. */
  resolveTypeSchema(typeRef: unknown): Record<string, any> | undefined {
    return this.followTypeAlias(this.readTypeSchema(typeRef), new Set());
  }

  private readTypeSchema(typeRef: unknown): Record<string, any> | undefined {
    if (!typeRef) return undefined;
    if (typeof typeRef === "string") return this.validator.getSchema(typeRef) as any;
    if (typeof typeRef !== "object") return undefined;
    const ref = typeRef as Record<string, any>;
    if (ref.schema && typeof ref.schema === "object") return ref.schema;
    if (typeof ref.name === "string") return this.validator.getSchema(ref.name) as any;
    if (ref.type || ref.properties || ref.$ref) return ref;
    return undefined;
  }

  /**
   * Follow a schema that is nothing but a `$ref` to a registered type, so the
   * schema-level questions (which properties are streams, which paths carry a
   * default) are asked of the real shape rather than of an alias.
   *
   * Only the whole-document alias form is followed, and only to READ it — the
   * schema handed to AJV keeps its `$ref`s intact, because AJV resolves them
   * itself against the registered ids and each type stays its own document with
   * its own `$defs`. Inlining instead would move a `$ref: "#/$defs/X"` out of the
   * document that defines `$defs.X`.
   *
   * `seen` guards a cycle two mutually-referencing types would otherwise spin on.
   * A `$ref` alongside other keywords is left alone: that is a composition, not
   * an alias.
   */
  private followTypeAlias(
    schema: Record<string, any> | undefined,
    seen: Set<string>,
  ): Record<string, any> | undefined {
    let current = schema;
    while (
      current &&
      typeof current.$ref === "string" &&
      Object.keys(current).length === 1 &&
      !seen.has(current.$ref)
    ) {
      seen.add(current.$ref);
      const target = this.validator.getSchema(current.$ref) as Record<string, any> | undefined;
      if (!target) return current;
      current = target;
    }
    return current;
  }

  /** Compile `schema` but compose the CEL `rules:` registered under `name`.
   *
   *  A named type's rules are its business invariants, and they are reachable
   *  only through the name. {@link createTypeValidator} composes them when it is
   *  handed a bare name, but a caller that must adjust the schema first — the
   *  contract binding, which strips `x-telo-stream` properties before validating
   *  — would otherwise have to choose between the adjustment and the rules. */
  createTypeValidatorWithRules(name: string | undefined, schema: Record<string, any>) {
    const base = this.validator.compile(schema);
    const rules = name ? this.validator.getTypeRules(name) : undefined;
    return rules && rules.length > 0 ? this.validator.composeWithRules(base, name!, rules) : base;
  }

  createTypeValidator(typeRef: string | Record<string, any> | undefined) {
    if (!typeRef) return new NoopValidator();

    // String ref, or {kind, name} ref object produced by inline-resource
    // normalization (before Phase 5 injection substitutes the live instance).
    // Both resolve by looking up the registered schema by name.
    const hasInlineSchema =
      typeof typeRef !== "string" && typeRef.schema && typeof typeRef.schema === "object";
    const refName =
      typeof typeRef === "string"
        ? typeRef
        : typeof typeRef.name === "string" && !hasInlineSchema
          ? typeRef.name
          : undefined;

    if (refName !== undefined) {
      const schema = this.validator.getSchema(refName);
      if (!schema) {
        throw new RuntimeError(
          "ERR_TYPE_NOT_FOUND",
          `Type "${refName}" not found in schema registry`,
        );
      }
      const base = this.validator.compile(schema);
      const rules = this.validator.getTypeRules(refName);
      if (rules && rules.length > 0) {
        return this.validator.composeWithRules(base, refName, rules);
      }
      return base;
    }

    // Strings were handled above. TS can't follow the narrowing through the
    // compound `refName` expression, so restate it here.
    if (typeof typeRef === "string") return this.validator.compile(typeRef);

    // Inline schema object: if it has a `schema` property, it's a type resource shape
    if (hasInlineSchema) {
      const base = this.validator.compile(typeRef.schema);
      const rules = Array.isArray(typeRef.rules) ? typeRef.rules : [];
      if (rules.length > 0) {
        return this.validator.composeWithRules(base, "inline", rules);
      }
      return base;
    }

    // Raw JSON Schema object (direct schema, not wrapped in type resource)
    return this.validator.compile(typeRef);
  }

  validateSchema(value: any, schema: any) {
    const ajv = new Ajv({
      removeAdditional: true,
    });
    addFormats.default(ajv);
    for (const kw of ["x-telo-ref", "x-telo-scope", "x-telo-context", "x-telo-schema-from"]) {
      ajv.addKeyword(kw);
    }
    const validate = ajv.compile(
      "type" in schema && typeof schema.type === "string"
        ? schema
        : {
            type: "object",
            properties: schema,
            required: Object.keys(schema),
            additionalProperties: false,
          },
    );
    const isValid = validate(stripCompiledValues(value));
    if (!isValid) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Invalid value. Error: ${formatAjvErrors(validate.errors)}`,
      );
    }
  }

  createCancellationSource(): CancellationSource {
    return createCancellationSource();
  }

  // ── Execution zones (kernel/specs/execution-zones.md) ─────────────────────
  //
  // Identity is held here (it is the resource's, not the zone subsystem's);
  // everything else delegates to `ZoneContext`, which owns the annotation
  // resolution, correlation walk and stack matching — and memoizes them, since
  // this sits on the dispatch path.

  #self: ResourceHandle | undefined;
  #zones: ZoneContext | undefined;

  /** Kernel-internal: stamped at `create()`, the moment the instance exists. */
  bindResourceIdentity(
    handle: ResourceHandle,
    resolvedKind: string,
    manifest: Record<string, unknown>,
  ): void {
    this.#self = handle;
    this.#zones = new ZoneContext({
      resourceName: (this.metadata?.name as string) ?? "<unnamed>",
      resolvedKind,
      self: handle,
      // The SAME object Phase-5 injection later mutates, so a correlation
      // pointer read at invoke time sees live instances in ref slots.
      manifest,
      resolveDefinition: (kind) => this.kernel.getAnalysisRegistry().resolveDefinition(kind),
      resolveDefinitionIn: (kind, module) =>
        this.kernel.getAnalysisRegistry().resolveDefinitionIn(kind, module),
      resolveLocalInstance: (name) => this.resolveLocalInstance(name),
      resolveLocalManifest: (name) =>
        this.contextForName(name).resourceInstances.get(name)?.resource as
          | Record<string, unknown>
          | undefined,
    });
  }

  get self(): ResourceHandle {
    if (!this.#self) {
      throw new RuntimeError(
        "ERR_RESOURCE_IDENTITY_UNBOUND",
        `[${this.metadata.name}] ctx.self is unavailable inside create() — the handle is minted when create() returns`,
      );
    }
    return this.#self;
  }

  /** The zone subsystem, available once `create()` has returned. */
  private zoneContext(): ZoneContext {
    if (!this.#zones) {
      throw new RuntimeError(
        "ERR_RESOURCE_IDENTITY_UNBOUND",
        `[${this.metadata.name}] zones are unavailable inside create() — the handle is minted when create() returns`,
      );
    }
    return this.#zones;
  }

  withZone<T>(
    slot: string,
    fn: (ctx: InvokeContext, entry: ZoneEntry) => Promise<T>,
    base?: InvokeContext,
  ): Promise<T> {
    return this.zoneContext().withZone(slot, fn, base);
  }

  requireZone(field: string, ctx?: InvokeContext): ZoneEntry {
    return this.zoneContext().requireZone(field, ctx);
  }

  findZone(field: string, ctx?: InvokeContext): ZoneEntry | undefined {
    return this.zoneContext().findZone(field, ctx);
  }

  zonesFor(instance: ResourceInstance, ctx?: InvokeContext): readonly ZoneEntry[] {
    return this.zoneContext().zonesFor(instance, ctx);
  }

  /** The root context for runtime-driven inbound work — inherits nothing from
   *  whatever ambient happens to be live at the registration site. */
  rootContext(opts?: { cancellation?: CancellationSource }): InvokeContext {
    return opts?.cancellation?.context ?? UNCANCELLABLE_CONTEXT;
  }

  /** In-flight fire-and-forget tasks this resource spawned. Owned here, not by
   *  the kernel: the resource drains them in its own teardown (see
   *  `drainDetached`), so background work is bounded by the resource's lifetime. */
  private readonly pendingDetached = new Set<Promise<unknown>>();

  runDetached(fn: () => Promise<unknown>): void {
    // Fire-and-forget: a detached task has no caller to throw to, so route a
    // failure to the EventBus rather than letting it go unhandled. We track the
    // error-handled chain (not the raw promise) so teardown drains a task whose
    // settlement is already observed here.
    const tracked = this.owningContext
      .runDetached(fn) // bare scope-detach primitive
      .catch(async (err: unknown) => {
        const detail =
          err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
        await this.emitEvent("background.task.error", { resource: this.metadata.name, error: detail });
      })
      .finally(() => {
        this.pendingDetached.delete(tracked);
      });
    this.pendingDetached.add(tracked);
  }

  /**
   * Await this resource's in-flight detached tasks, bounded by
   * `DETACHED_DRAIN_TIMEOUT_MS`. Folded into the resource's teardown by the
   * kernel, so tearing the resource down drains its background work (and its
   * dependencies, torn down later in reverse order, are still alive meanwhile).
   * Past the bound, remaining tasks are abandoned with a logged event rather
   * than blocking shutdown.
   */
  async drainDetached(): Promise<void> {
    if (this.pendingDetached.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DETACHED_DRAIN_TIMEOUT_MS);
    });
    await Promise.race([Promise.allSettled([...this.pendingDetached]), timeout]);
    if (timer) clearTimeout(timer);
    if (this.pendingDetached.size > 0) {
      await this.emitEvent("background.task.abandoned", {
        resource: this.metadata.name,
        count: this.pendingDetached.size,
      });
    }
  }

  openSpan(base: InvokeContext | undefined, opts: OpenSpanOptions): Promise<OpenSpan> {
    return this.owningContext.openSpan(base, opts);
  }

  invoke<TInputs>(
    kind: string,
    name: string,
    inputs: TInputs,
    options?: InvokeByNameOptions,
  ): Promise<any> {
    return this.contextForName(name).invoke(kind, name, inputs, options?.ctx);
  }

  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any> {
    return this.owningContext.invokeResolved(kind, name, instance, inputs, ctx);
  }

  resolveImportedInstance(alias: string, name: string): ResourceInstance | undefined {
    return this.moduleContext.resolveImportedInstance(alias, name);
  }

  resolveRef<T>(
    value: unknown,
    guard: (candidate: unknown) => candidate is T,
    describe: () => string,
    expects?: string,
  ): T {
    // Two things the raw resolver cannot do from a `{ moduleContext }` slice:
    //
    //  - A `!ref` can reach a controller as the raw SENTINEL. Phase-5 injection is
    //    field-map-driven, and the field map does not descend into the inline
    //    declarations inside an `x-telo-scope` array, so a ref slot on a scoped
    //    resource is not an injection site. (Phase 2.5 does rewrite such a
    //    sentinel to `{kind, name}` when it can name a target, so the shape that
    //    arrives varies — both are accepted.) `ensureKindRef` is the same rescue
    //    the sentinel path already performs for hidden slots.
    //  - A scope-local name lives in the OWNING context, not the module, so a
    //    `with:`-scoped resource referencing a scoped sibling has to resolve in
    //    the same order `contextForName` and `ScopeContext.getInstance` use —
    //    scope-local first, module as the fallback — or CEL and `!ref` disagree
    //    about what a name means inside a scope.
    const normalized = isRefSentinel(value) ? this.ensureKindRef(value) : value;
    return resolveRefInstance(normalized, this, guard, describe, expects);
  }

  /** Name lookup with scope-local precedence, for {@link resolveRefInstance}. */
  resolveLocalInstance(name: string): ResourceInstance | undefined {
    return this.contextForName(name).resourceInstances.get(name)?.instance;
  }

  async run(name: string) {
    await this.contextForName(name).run(name);
  }

  /** Report what this resource has observed. Configured state stays on
   *  `snapshot()`, which the kernel pulls; only what the resource LEARNS is
   *  pushed, because nothing but the controller knows when it learned it. */
  async setStatus(status: Record<string, unknown>): Promise<void> {
    // `metadata` is the resource's `metadata` block, not the resource — every
    // other member here reads `this.metadata.name`.
    const name = this.metadata?.name as string | undefined;
    if (!name) return;
    await this.owningContext.setResourceStatus(name, status);
  }

  registerManifest(resource: any): void {
    this.owningContext.registerManifest(resource);
  }

  loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
    return this.kernel.loadModule(url, options);
  }

  loadManifests(url: string): Promise<ResourceManifest[]> {
    return this.kernel.loadManifests(url);
  }

  isImportValidatedAtLoad(url: string): boolean {
    return this.kernel.isImportValidatedAtLoad(url);
  }

  resolveImportUrl(fromSource: string, importSource: string): string {
    return this.kernel.resolveImportUrl(fromSource, importSource);
  }

  /** @deprecated Renamed to {@link ensureKindRef}. */
  resolveChildren(
    resource: any,
    resourceName?: string,
  ): { kind: string; name: string; alias?: string } {
    return this.ensureKindRef(resource, resourceName);
  }

  /**
   * Normalizes a nested slot value into a {kind, name, alias?} reference.
   * An inline definition (kind + properties) is registered as a manifest first,
   * under `resourceName` or a generated name; a value that is already a
   * reference is normalized and returned as-is.
   *
   * @param resource Inline definition, `{kind, name}` reference, or `!ref` sentinel
   * @param resourceName Name to assign when the value is an unnamed inline definition
   * @returns Normalized {kind, name, alias?} reference
   * @throws RuntimeError if 'kind' is missing
   */
  ensureKindRef(
    resource: any,
    resourceName?: string,
  ): { kind: string; name: string; alias?: string } {
    if (!resource || typeof resource !== "object") {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Resource must be an object. Got: ${typeof resource}`,
      );
    }

    // Stopgap: `!ref <name>` sentinels can reach the controller directly
    // when the slot is hidden behind a local `$ref: "#/$defs/..."` — the
    // analyzer's field-map walker descends `oneOf`/`anyOf` variant
    // properties but intentionally early-returns on `$ref` (see
    // `analyzer/nodejs/src/reference-field-map.ts`). Enabling the `$ref`
    // descent regresses the kernel's `<name>.Invoked` event
    // emission for kinds (notably `Run.Sequence`) whose controllers
    // call `instance.invoke()` directly on Phase-5-injected instances;
    // the walker fix needs to land together with routing those callers
    // through `EvaluationContext.invokeResolved`. Until then, the Node
    // kernel resolves the sentinel here. Polyglot controllers don't get
    // this rescue — schemas exercising those hidden slots must use the
    // legacy string or `{kind, name}` forms for now.
    if (isRefSentinel(resource)) {
      const source = resource.source;
      const dot = source.indexOf(".");
      const alias = dot > 0 ? source.slice(0, dot) : undefined;
      // Cross-module exported instance (`!ref Alias.name`) — resolve the {kind, name} ref
      // from the import's exported scope and reattach the alias so downstream scope
      // resolution (executeInvokeStep → ScopeContext.getInstance) routes into the import's
      // child context rather than scope-local resources.
      if (alias && alias !== "Self") {
        const name = source.slice(dot + 1);
        const ref = this.moduleContext.resolveImportedRef(alias, name);
        if (!ref) {
          throw new RuntimeError(
            "ERR_RESOURCE_NOT_FOUND",
            `[${this.metadata.name}] !ref '${source}' is not an exported instance of import '${alias}'.`,
          );
        }
        return { kind: ref.kind, name: ref.name, alias };
      }
      const refName = alias === "Self" ? source.slice(dot + 1) : source;
      // Mirror the legacy `{kind, name}` path: return a `{kind, name}` ref and let
      // the downstream resolution (module-global `invoke`, or scope-local
      // `executeInvokeStep → ScopeContext.getInstance`) find it by name at invoke
      // time. The kind is carried for invocation-event naming. Prefer an
      // already-initialized instance's kind, else the authored kind from the
      // static manifest (init-order-independent — the target may not be
      // initialized yet when this resolves, and scope-local resources never enter
      // `resourceInstances`).
      const kind =
        (this.contextForName(refName).resourceInstances.get(refName)?.resource.kind as string | undefined) ??
        this.kernel.resourceKindByName(refName) ??
        "";
      return { kind, name: refName };
    }

    if (!resource.kind) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Resource must have 'kind' property. Got: ${JSON.stringify(resource)}`,
      );
    }

    const kind = resource.kind;
    const name =
      resource.name ??
      resource.metadata?.name ??
      resourceName ??
      `Unnamed${Math.random().toString(16).slice(2, 8)}`;
    // `alias` marks a resolved cross-module reference (`{kind, name, alias}`)
    // produced from a `!ref Alias.name`. It is always a reference into an
    // imported library's exported instance — never an inline definition — so it
    // is a reference key alongside kind/name/metadata (not inline config) and is
    // carried through so downstream scope resolution routes into the import.
    const alias = typeof resource.alias === "string" ? resource.alias : undefined;

    // Register an inline manifest when:
    //  - the ref carries definition properties (clearly an inline definition), or
    //  - the ref is bare `{kind}` with no explicit name and the caller supplied
    //    a `resourceName` (the slot is known-inline — e.g. a Run.Sequence step
    //    with `invoke: {kind: SomeInvocable}` — and wants a fresh stateless
    //    instance registered under the generated name).
    // Pure references (`{kind, name}` pointing at an existing resource) carry
    // an explicit name and skip registration. registerManifest itself throws
    // ERR_DUPLICATE_RESOURCE on collision — surfacing collisions loudly is
    // the contract here; previous silent-skip-on-duplicate hid real bugs
    // (e.g. inline auto-names colliding across sibling Run.Sequence steps).
    const hasInlineProperties = Object.keys(resource).some(
      (k) => k !== "kind" && k !== "name" && k !== "metadata" && k !== "alias",
    );
    const hasExplicitName = resource.name !== undefined || resource.metadata?.name !== undefined;
    const shouldRegister =
      hasInlineProperties || (!hasExplicitName && resourceName !== undefined);

    if (shouldRegister) {
      this.registerManifest({
        ...resource,
        metadata: {
          name,
          module: this.metadata.module,
          ...resource.metadata,
        },
      });
    }

    return alias ? { kind, name, alias } : { kind, name };
  }

  getResourcesByName(_kind: string, name: string): RuntimeResource | null {
    const entry = this.contextForName(name).resourceInstances.get(name);
    return (entry?.resource ?? null) as RuntimeResource | null;
  }

  async registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
  ): Promise<void> {
    const fingerprint = policyFingerprint(this.moduleContext.getControllerPolicy());
    await this.kernel.registerController(moduleName, kindName, controllerInstance, fingerprint);
  }

  /**
   * Register a deferred controller under the declaring module's policy
   * fingerprint (same keying as `registerController`). Internal to the kernel's
   * lazy controller loading — not part of the public SDK `ResourceContext`
   * surface; the only caller is the `Telo.Definition` controller.
   */
  registerLazyController(
    moduleName: string,
    kindName: string,
    load: () => Promise<void>,
  ): void {
    const fingerprint = policyFingerprint(this.moduleContext.getControllerPolicy());
    this.kernel.registerLazyController(moduleName, kindName, fingerprint, load);
  }

  /**
   * Run the create phase for an inherited (concrete-`extends`) definition's
   * parent kind, returning the native parent instance (or null when the parent
   * controller isn't registered yet — a retry). A typed internal seam for the
   * inherited-controller delegation; off the public SDK `ResourceContext`
   * surface, like `registerLazyController`.
   */
  createInheritedInstance(
    evalContext: IEvaluationContext,
    resource: Record<string, unknown>,
  ): Promise<ResourceInstance | null> {
    return this.kernel.createInheritedInstance(evalContext, resource as ResourceManifest);
  }

  registerDefinition(def: any) {
    this.kernel.registerResourceDefinition(def);
  }

  getControllerPolicy(): ControllerPolicy | undefined {
    return this.moduleContext.getControllerPolicy();
  }

  getEntryUrl(): string | undefined {
    return this.kernel.getEntryUrl();
  }

  getInstallRoot(): string | undefined {
    return this.kernel.getInstallRoot();
  }

  /** The `.telo` cache root for this load. Kernel-only — the SDK surface has no
   *  business naming a cache directory — reached by the resource-definition
   *  controller through {@link ControllerCacheHost} so the bundle loader can
   *  cache a dev build of a local module's controller source. */
  getCacheRoot(): string | undefined {
    return this.kernel.getCacheRoot();
  }

  /** The artifact of the module whose manifest resolved from `source`. Kernel-only
   *  (it hands back a kernel class), reached by the resource-definition controller
   *  through {@link ModuleArtifactHost} rather than the SDK surface. */
  getModuleArtifact(source: string | undefined): ModuleArtifact | undefined {
    return this.kernel.getModuleArtifact(source);
  }

  /**
   * Resolve a module-relative reference against the declaring module's own
   * directory, materializing the layers that could carry it on first use.
   *
   * A URI, not a filesystem path: the SDK is cross-runtime, and a path is only
   * what *this* kernel happens to return for a module whose files are local.
   * An already-absolute URI (one with a scheme) passes through untouched; a bare
   * absolute filesystem path is returned as a `file://` URI rather than being
   * rebased onto the module directory.
   */
  async resolveModuleFile(relative: string): Promise<string> {
    // An absolute URI names its own location; a bare absolute path is already
    // resolved and must not be rebased onto the module directory.
    if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return relative;
    if (path.isAbsolute(relative)) return pathToFileURL(relative).href;

    const source = this.moduleContext.source;
    const artifact = this.kernel.getModuleArtifact(source);
    if (artifact) {
      // Both the `assets` layer and `common` — the sink rule puts a file the
      // author did not claim via `assets:` into `common`, and a module that ships
      // static files with no bundled controller has no other route to its payload.
      // Fetching only assets would leave such a module resolving into an empty
      // directory.
      await artifact.materializeModuleFiles();
      return new URL(relative, pathToFileURL(path.join(artifact.directory, "/")).href).href;
    }
    // No artifact means no payload to fetch. That is normal for a module already
    // on disk (development) or one that ships no files — but for a module reached
    // over a non-local scheme it means the artifact carries no layer index, i.e. it
    // predates layers. Raise the actionable error here rather than leaving each
    // caller to invent its own message from a URI it cannot open.
    if (!source.startsWith("file://") && !path.isAbsolute(source)) {
      throw new RuntimeError(
        "ERR_MODULE_FILES_UNAVAILABLE",
        `Cannot resolve '${relative}' against module '${source}': the module's artifact ` +
          `carries no layer index, so its files cannot be located. It was published by an ` +
          `older Telo that wrote a single-blob artifact — republish the module, or import it ` +
          `from a local path during development.`,
      );
    }
    // Local module: resolve against the manifest URL, the same rule `include:`
    // and sibling imports follow.
    const base = source.startsWith("file://") ? source : pathToFileURL(source).href;
    return new URL(relative, base).href;
  }

  on(event: string, handler: (payload?: any) => void | Promise<void>): void {
    this.kernel.on(event, handler);
  }

  async emit(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(`${this.metadata.name}.${event}`, payload);
  }

  acquireHold(reason?: string): () => void {
    return this.kernel.acquireHold(reason);
  }

  requestExit(code: number): void {
    this.kernel.requestExit(code);
  }

  expandValue(value: any, context: Record<string, any>) {
    return this.owningContext.expandWith(value, context);
  }

  bindScope(
    bindings: Record<string, unknown> | undefined,
    scope: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.owningContext.bindScope(bindings, scope);
  }

  async emitEvent(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(event, payload);
  }

  /** `kinds` is the target's `exports.kinds` gate; omit it for an unrestricted alias
   *  (one crossing no import boundary). See `ModuleContext.registerImport`. */
  registerModuleImport(alias: string, targetModule: string, kinds?: readonly string[]): void {
    this.moduleContext.registerImport(alias, targetModule, kinds);
  }

  /**
   * Create a child EvaluationContext attached to the current module context.
   * Register resources on the returned context with registerManifest(), then
   * call initializeResources() to initialize them in isolation.
   */
  spawnChildContext(): IEvaluationContext {
    // One construction path: defer to the module context's own
    // spawnChildContext(). Rooted on this resource's module context (the
    // consumer scope); a templated definition that needs library-scoped
    // resolution calls the defining library's context directly instead.
    return this.owningContext.spawnChildContext();
  }

  transientChild(context: Record<string, any>): IEvaluationContext {
    return this.owningContext.transientChild(context);
  }

  /**
   * Create a temporary child context, queue manifests on it, run a function,
   * then tear down the child context and its resources.
   * Note: This always returns a Promise even though the interface signature
   * suggests T. The callback can be sync or async (passed as async function).
   */
  withManifests<T>(manifests: any[], fn: () => T): T {
    const child = this.spawnChildContext();
    // Return a Promise cast as T - callers will use await
    return (async () => {
      try {
        for (const manifest of manifests || []) {
          if (manifest) {
            child.registerManifest(manifest);
          }
        }
        await child.initializeResources();
        return await Promise.resolve(fn() as any);
      } finally {
        await child.teardownResources();
      }
    })() as unknown as T;
  }
}

