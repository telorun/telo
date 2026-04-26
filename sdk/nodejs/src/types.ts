import { ControllerContext } from "./controller-context.js";
import { ResourceContext } from "./resource-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeDiagnostic, RuntimeErrorCode } from "./runtime-error.js";
import { RuntimeResource } from "./runtime-resource.js";

export interface KernelContext {
  kernel: Kernel;
}

export interface ExecContext {
  execute(urn: string, input: any): Promise<any>;
  [key: string]: any;
}

export interface ThrowCodeSpec {
  description: string;
  data?: Record<string, any>;
}

/**
 * Declared throw contract for a Telo.Invocable or Telo.Runnable definition.
 * Codes-only (explicit contract) in Phase 1; `inherit` and `passthrough` land
 * in Phase 2 together with the analyzer dataflow pass.
 */
export interface ThrowsSpec {
  codes?: Record<string, ThrowCodeSpec>;
  inherit?: boolean;
  passthrough?: boolean;
}

export interface ResourceDefinition {
  kind: string;
  metadata: {
    name: string;
    module: string;
  };
  /** JSON Schema for the resource's compile-time configuration fields. */
  schema?: Record<string, any>;
  capability?: string;
  /** Alias-form reference to a Telo.Abstract this definition implements, e.g. "Ai.Model".
   *  Resolved against the declaring file's `Telo.Import` declarations — same pattern as
   *  kind prefixes (`kind: Http.Api`). Orthogonal to `capability` (lifecycle role); the
   *  analyzer populates its `extendedBy` index from this field so references typed via
   *  `x-telo-ref: "<ns>/<mod>#<Abstract>"` accept this definition. */
  extends?: string;
  controllers?: Array<{
    runtime: string;
    entry: string;
  }>;
  /** Declared throw contract — only valid on Telo.Invocable / Telo.Runnable. */
  throws?: ThrowsSpec;
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
  /** CLI argument spec. Keys are arg names; values define type, alias, and description. */
  args?: Record<string, { type: "string" | "boolean"; alias?: string; description?: string }>;
  /** Type reference for invoke() inputs — name string or inline type definition. */
  inputType?: string | Record<string, any>;
  /** Type reference for invoke() outputs — name string or inline type definition. */
  outputType?: string | Record<string, any>;
}

export interface Kernel {
  load(url: string): Promise<void>;
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
    public diagnostics?: RuntimeDiagnostic[],
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
