import type { CancellationSource, InvokeContext, OpenSpan, OpenSpanOptions } from "./cancellation.js";
import { ControllerContext } from "./controller-context.js";
import { ControllerPolicy } from "./controller-policy.js";
import { EvaluationContext } from "./evaluation-context.js";
import { ModuleContext } from "./module-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeResource } from "./runtime-resource.js";

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
  acquireHold(reason?: string): () => void;
  emitEvent(event: string, payload?: any): Promise<void>;
  /** Mint a writable cancellation source for a trigger to own (HTTP request,
   *  lambda budget). Pass `source.context` into `invokeResolved` to scope an
   *  invocation tree to it. */
  createCancellationSource(): CancellationSource;
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
  resolveChildren(resource: any, resourceName?: string): { kind: string; name: string };
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
  registerModuleImport(alias: string, targetModule: string, kinds: string[]): void;
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
  /** Load a single module (its own file + `include`d partials). Use this when
   *  you need just the declaring file's manifests. */
  loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]>;
  /** Load a module and follow its Telo.Import chain, returning the union of
   *  the module's manifests plus all transitively-imported Telo.Definition
   *  manifests. Use this when you need the full kind surface area visible from
   *  the module. */
  loadManifests(url: string): Promise<ResourceManifest[]>;
  readonly moduleContext: ModuleContext;
  readonly env: Record<string, string | undefined>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
