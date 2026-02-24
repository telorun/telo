import type {
    ControllerContext,
    ResourceContext,
    ResourceInstance,
    ResourceManifest,
    RuntimeErrorCode,
    RuntimeResource,
} from "@telorun/sdk";
export type {
    ControllerContext,
    ResourceContext,
    ResourceInstance,
    ResourceManifest
} from "@telorun/sdk";

export interface KernelContext {
  kernel: Kernel;
}

export interface ExecContext {
  execute(urn: string, input: any): Promise<any>;
  [key: string]: any;
}

export interface ResourceDefinition {
  kind: string;
  metadata: {
    name: string;
    module: string;
  };
  schema: Record<string, any>; // JSON Schema
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
  teardownResource(module: string, kind: string, name: string): Promise<void>;
  registerChildManifest(parentKey: string, resource: ResourceManifest): void;
  getSourceFiles(): string[];
  reloadSource(sourcePath: string): Promise<void>;
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
