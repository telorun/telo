import { ControllerContext } from "./controller-context.js";
import { ResourceContext } from "./resource-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeErrorCode } from "./runtime-error.js";
import { RuntimeResource } from "./runtime-resource.js";

export interface KernelContext {
  kernel: Kernel;
}

export interface ExecContext {
  execute(urn: string, input: any): Promise<any>;
  [key: string]: any;
}

export interface InvocationContext {
  /** JSON Path (RFC 9535) expression into the resource config identifying the invocation field,
   *  e.g. '$.routes[*].handler'. Used to locate the referenced invokable resource name(s). */
  scope: string;
  /** JSON Schema for the data shape provided to the invoked resource's invoke() inputs.
   *  Validated statically by the analyzer at bootstrap. */
  schema: Record<string, any>;
}

export interface ResourceDefinition {
  kind: string;
  metadata: {
    name: string;
    module: string;
  };
  /** JSON Schema for the resource's compile-time configuration fields. */
  schema?: Record<string, any>;
  /** JSON Schema for invoke() inputs. Used for runtime validation and static analysis. */
  inputs?: Record<string, any>;
  /** JSON Schema for invoke() outputs. Used for static analysis. */
  outputs?: Record<string, any>;
  /** Invocation context declarations — what each call site provides to invoked resources.
   *  Used for static analysis at bootstrap. */
  contexts?: InvocationContext[];
  capability?: string;
  /** CEL expression paths expanded at compile time and/or runtime.
   *  '**' expands the entire manifest. Inherited from the parent base definition. */
  expand?: {
    compile?: string[];
    runtime?: string[];
  };
  events?: string[];
  controllers?: Array<{
    runtime: string;
    entry: string;
  }>;
}

/**
 * Controller definition for a resource kind.
 * Maps a fully-qualified resource kind to its controller implementation for a specific runtime.
 */
export interface ControllerDefinition {
  kind: string; // Fully-qualified kind (e.g., "Http.Route")
  runtime: string; // Runtime selector (e.g., "node@>=20")
  entry: string; // Path to controller implementation
  controller?: any; // Lazy-loaded controller code
}

/**
 * Controller instance - runtime representation of a controller that handles resource instances.
 *
 * TResource - the typed shape of the resource manifest (compile-time config)
 * TInput    - the typed shape of invoke() inputs (runtime)
 * TOutput   - the typed shape of invoke() outputs (runtime)
 */
export interface ControllerInstance<
  TResource extends ResourceManifest = ResourceManifest,
  TInput = Record<string, any>,
  TOutput = any,
> {
  execute?(name: string, inputs: any, ctx: ExecContext): Promise<any>;
  compile?(resource: TResource, ctx: ResourceContext): RuntimeResource | Promise<RuntimeResource>;
  register?(ctx: ControllerContext): void | Promise<void>;
  create?(
    resource: TResource,
    ctx: ResourceContext,
  ): ResourceInstance<TInput, TOutput> | null | Promise<ResourceInstance<TInput, TOutput> | null>;
  schema?: any;
  /** JSON Schema for invoke() inputs — used for runtime validation and static analysis. */
  inputSchema?: Record<string, any>;
  /** JSON Schema for invoke() outputs — used for documentation and static analysis. */
  outputSchema?: Record<string, any>;
}

export interface Kernel {
  loadFromConfig(runtimeYamlPath: string): Promise<void>;
  start(): Promise<void>;
  acquireHold(reason?: string): () => void;
  waitForIdle(): Promise<void>;
  requestExit(code: number): void;
  readonly exitCode: number;
  // teardownResource(module: string, kind: string, name: string): Promise<void>;
  // getSourceFiles(): string[];
  // reloadSource(sourcePath: string): Promise<void>;
  shutdown(): void;
}

export class RuntimeError extends Error {
  constructor(
    public code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
