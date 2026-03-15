import { ControllerContext } from "./controller-context.js";
import { ModuleContext } from "./module-context.js";
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

export type ResourceCapability = string;

export interface CapabilityDefinition {
  name: string;
  expand?: {
    /** Dot-paths expanded strictly at creation time. '**' = entire manifest.
     *  Paths also in `runtime` are excluded here (runtime takes precedence). */
    compile?: string[];
    /** Dot-paths expanded strictly at invoke time with invocation context. */
    runtime?: string[];
  };
  onDefinition?(definition: ResourceDefinition, ctx: ResourceContext): void | Promise<void>;
  onManifest?(manifest: ResourceManifest, ctx: ModuleContext): ResourceManifest | Promise<ResourceManifest>;
  onInit?(instance: ResourceInstance, ctx: ResourceContext): Promise<void>;
  onInvoke?(instance: ResourceInstance, inputs: any, ctx: ResourceContext): Promise<any>;
}

export interface ResourceDefinition {
  kind: string;
  metadata: {
    name: string;
    module: string;
  };
  schema: Record<string, any>; // JSON Schema
  capabilities: ResourceCapability[];
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
 */
export interface ControllerInstance {
  execute?(name: string, inputs: any, ctx: ExecContext): Promise<any>;
  compile?(
    resource: ResourceManifest,
    ctx: ResourceContext,
  ): RuntimeResource | Promise<RuntimeResource>;
  register?(ctx: ControllerContext): void | Promise<void>;
  create?(
    resource: ResourceManifest,
    ctx: ResourceContext,
  ): ResourceInstance | null | Promise<ResourceInstance | null>;
  schema: any;
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
