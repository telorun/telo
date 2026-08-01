import type { CancellationSource, InvokeContext, OpenSpan, OpenSpanOptions } from "./cancellation.js";
import { ControllerContext } from "./controller-context.js";
import type { Logger } from "./logger.js";
import type { LoggingHost } from "./log-sink.js";
import { ControllerPolicy } from "./controller-policy.js";
import { EvaluationContext } from "./evaluation-context.js";
import { ModuleContext } from "./module-context.js";
import type { KindRef } from "./ref.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeResource } from "./runtime-resource.js";
import type { RuntimeSeam } from "./runtime-seam.js";

export interface LoadOptions {
  /** When true, `${{ }}` templates are replaced with CompiledValue wrappers
   *  so they can be evaluated at runtime. Leave unset for static analysis. */
  compile?: boolean;
  /** When true, each module document's inline `imports:` map is desugared into
   *  synthetic `Telo.Import` manifests before the manifests are returned, so
   *  inline imports resolve and execute identically to authored `Telo.Import`
   *  documents. Mirrors the analyzer loader's option of the same name. */
  desugarImports?: boolean;
}

export interface DataValidator {
  validate(data: any): void;
  isValid(data: any): boolean;
}

export interface TypeRule {
  condition: string;
  code: string;
  message?: string;
}

export class NoopValidator implements DataValidator {
  isValid() {
    return true;
  }

  validate() {
    // noop
  }
}

export type ParsedArgs = Partial<Record<string, string | boolean | string[]>> & { _: string[] };

export interface ResourceContext extends ControllerContext {
  readonly args: ParsedArgs;
  /** The id prefix of the context this resource was created in (the creating
   *  {@link EvaluationContext}'s `ownerPrefix`). A controller that spawns
   *  sub-resources composes their hierarchical ids as
   *  `ownerPrefix + <kind>.<name>` and stamps the owner on the child context it
   *  registers them into, so two instances of the same templated kind don't
   *  collide and the children nest under their parent in a debug view. */
  readonly ownerPrefix: string;
  acquireHold(reason?: string): () => void;
  /**
   * Report this resource's **observed state** — what it has learned while
   * running — publishing it at `resources.<name>.status.<field>`.
   *
   * Pushed rather than pulled because nothing but the controller knows when the
   * value was learned. Configured state stays on `snapshot()`, which the kernel
   * pulls whenever it needs it; the two never share a payload, so neither shape
   * is described twice.
   *
   * - **Replaces**, never merges: this is the resource's observed state now. A
   *   field the kind declares but this call omits reads as missing, which is the
   *   truth — declare a sometimes-absent field with a nullable type and report
   *   it as `null`.
   * - **Validated** against the kind's `status:` on every call.
   * - **Illegal before the resource has started** (`ERR_OBSERVED_STATE_BEFORE_START`).
   *   `init()` performs no I/O, so there is nothing observed to report there.
   * - **Sticky**: the last value reported stays published until the resource is
   *   torn down. A dispatch that reports nothing leaves the previous reading in
   *   place — a listener's bound address does not stop being true between calls.
   */
  setStatus(status: Record<string, unknown>): Promise<void>;
  emitEvent(event: string, payload?: any): Promise<void>;
  /** Mint a writable cancellation source for a trigger to own (HTTP request,
   *  lambda budget). Pass `source.context` into `invokeResolved` to scope an
   *  invocation tree to it. */
  createCancellationSource(): CancellationSource;
  /** Run `fn` detached from the caller's cancellation/trace scope: the ambient
   *  request token + span are replaced with the uncancellable root, so request
   *  teardown cannot abort the work and it does not nest under the request's
   *  trace. Fire-and-forget — the call returns nothing; the task is tracked
   *  against this resource and drained (bounded) when the resource tears down,
   *  and a failure (no caller to throw to) is routed to the EventBus. */
  runDetached(fn: () => Promise<unknown>): void;
  /** Open a trace span for an inbound boundary (an HTTP request, a queue message).
   *  Returns a child {@link InvokeContext} to thread into `invokeResolved` so the
   *  handler nests under this span, plus `settle` to close it with an outcome.
   *  The span roots a fresh trace unless `inbound` continues an upstream one
   *  (e.g. a W3C `traceparent`). A no-op (returns `base` unchanged) when tracing
   *  is off. */
  openSpan(base: InvokeContext | undefined, opts: OpenSpanOptions): Promise<OpenSpan>;
  invoke<TInputs>(kind: string, name: string, inputs: TInputs, options?: any): Promise<any>;
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any>;
  run(kind: string, name: string): Promise<void>;
  getResourcesByName(kind: string, name: string): RuntimeResource | null;
  registerManifest(resource: any): void;
  spawnChildContext(): EvaluationContext;
  transientChild(context: Record<string, any>): EvaluationContext;
  withManifests<T>(manifests: any[], fn: () => T): T;
  /**
   * Normalize a nested slot value to a {@link KindRef}. The value is an inline
   * definition (`{ kind, …config }`), an already-normalized `{ kind, name }`
   * ref, or a `!ref` sentinel. An inline definition is *registered* into this
   * module's scope first — minting `resourceName` (or a generated one) as its
   * name — so the returned ref always points at a resource the kernel knows.
   *
   * The inverse of {@link resolveRef}: this goes slot value → ref, that goes
   * ref → live instance. Controllers that dispatch through
   * `invokeResolved(kind, name, …)` want the ref, so the invocation keeps its
   * identity for tracing and error wrapping.
   */
  ensureKindRef(value: any, resourceName?: string): KindRef;
  /** @deprecated Renamed to {@link ensureKindRef} — it produces a reference
   *  (registering an inline definition on the way), it does not resolve one. */
  resolveChildren(resource: any, resourceName?: string): { kind: string; name: string };
  /**
   * Resolve a `!ref` config field to a live instance of `T`. See
   * {@link resolveRefInstance} — this is the same resolution, reached through
   * the context a controller already holds. `expects` names the contract the
   * slot wants — its `x-telo-ref` string (`Cache.Store`) — so a mis-wire
   * says what was missing.
   */
  resolveRef<T>(
    value: unknown,
    guard: (candidate: unknown) => candidate is T,
    describe: () => string,
    expects?: string,
  ): T;
  validateSchema(value: any, schema: any): void;
  createSchemaValidator(schema: any): DataValidator;
  registerSchema(name: string, schema: object): void;
  lookupSchema(name: string): object | undefined;
  registerTypeRules(name: string, rules: TypeRule[]): void;
  lookupTypeRules(name: string): TypeRule[] | undefined;
  /** Resolve a type reference (name string or inline schema) to a DataValidator. */
  createTypeValidator(typeRef: string | Record<string, any> | undefined): DataValidator;
  registerController(moduleName: string, kindName: string, controllerInstance: any): Promise<void>;
  registerDefinition(definition: any): void;
  /** `kinds` is the target's `exports.kinds` gate; `undefined` only when the target
   *  declares none (the legacy permissive default). */
  registerModuleImport(alias: string, targetModule: string, kinds?: readonly string[]): void;
  /**
   * Resolved controller-selection policy for the module declaring this resource.
   * `undefined` when no policy was stamped (root module, or import without
   * `runtime:`). Consumers should treat undefined as "auto."
   */
  getControllerPolicy(): ControllerPolicy | undefined;
  /**
   * URL of the entry manifest the kernel is running, or `undefined` if the
   * kernel hasn't loaded a manifest yet. Stable for the lifetime of the
   * kernel process once set; identical across every resource regardless of
   * which imported library defined it. Controllers (and the controller-loader)
   * anchor per-manifest install roots here so a single `node_modules` tree
   * and one realpath for `@telorun/sdk` are shared by every controller in
   * the process. The `undefined` case shows up only for callers that bypass
   * `Kernel.load()` (e.g. early in test setup); resource controllers always
   * see a defined value because their `init()` runs after `load()` has
   * recorded it.
   */
  getEntryUrl(): string | undefined;
  /** The npm install root threaded from the kernel's single cache-root
   *  resolution (`<cache-root>/npm`). Controllers pass it to the
   *  controller-loader so a relocated `TELO_CACHE_DIR` is honoured without the
   *  loader re-deriving the root from the entry URL. `undefined` mirrors
   *  `getEntryUrl()` (callers that bypass `Kernel.load()`). */
  getInstallRoot(): string | undefined;
  /**
   * Resolve a module-relative reference — an `Http.Static` root, a template
   * directory, a seed-data file — against the directory of the module that
   * declared this resource, and return it as a **URI**.
   *
   * This is the sanctioned way to reach a file that ships with a module. Never
   * derive one from `moduleContext.source` by hand: for a published module the
   * manifest's own URL is not where its payload lives, and a `dirname` of it
   * silently resolves against the process working directory instead — serving
   * the wrong files rather than failing.
   *
   * A URI rather than a filesystem path because the SDK is cross-runtime: a path
   * is only what a Node kernel happens to return for a module whose files are
   * local. Callers that need a path convert with `fileURLToPath` after checking
   * the scheme. A reference that already names its own location is not rebased: a
   * URI with a scheme is returned unchanged, and a bare absolute filesystem path
   * comes back as a `file://` URI.
   *
   * Asynchronous because a published module's assets are fetched on first
   * access — a module whose files are never read never downloads them.
   */
  resolveModuleFile(relative: string): Promise<string>;
  /** Load a single module (its own file + `include`d partials). Use this when
   *  you need just the declaring file's manifests. */
  loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]>;
  /** Load a module and follow its Telo.Import chain, returning the union of
   *  the module's manifests plus all transitively-imported Telo.Definition
   *  manifests. Use this when you need the full kind surface area visible from
   *  the module. */
  loadManifests(url: string): Promise<ResourceManifest[]>;
  /**
   * The structured logger for this resource — `kernel/specs/logging.md` §13.2.
   *
   * Ambient rather than a resource (D3), because it must work before any
   * resource initializes. Records are automatically stamped with this
   * resource's identity, its module, its import-alias scope, and the active
   * dispatch span's trace and span ids — a controller never passes those.
   *
   * A controller emits diagnostics **only** through this. Writing to
   * stdout/stderr for diagnostic purposes is forbidden; writing to stdout as
   * *data* (as the `Console` module does) is a separate, legitimate concern and
   * is unaffected.
   */
  readonly log: Logger;
  /**
   * Sink attach/detach and drop accounting — the surface a `Telo.Sink`
   * controller needs and nothing else. §10.2 keeps the sink set open to the
   * ecosystem, so a third-party sink module reaches the pipeline through this
   * rather than through a kernel-internal import. Ordinary controllers use
   * {@link log}.
   */
  readonly logging: LoggingHost;
  /**
   * The host's own manifest machinery — run a manifest, analyze a manifest.
   * See {@link RuntimeSeam}. A controller that needs either reaches it here
   * rather than importing the kernel or the analyzer, so a published module
   * binds to a versioned contract instead of to whatever kernel loads it.
   */
  readonly runtime: RuntimeSeam;
  readonly moduleContext: ModuleContext;
  readonly env: Record<string, string | undefined>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
