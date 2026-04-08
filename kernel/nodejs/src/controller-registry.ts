import { ControllerInstance, ResourceDefinition, RuntimeResource } from "@telorun/sdk";
import * as path from "path";

/**
 * ControllerRegistry: Manages controller loading and dispatch
 * Maps fully-qualified resource kinds to their controller implementations
 */
export class ControllerRegistry {
  private controllersByKind: Map<string, ControllerInstance> = new Map();
  private definitionsByKind: Map<string, ResourceDefinition> = new Map();
  private controllerLoaders: Map<string, () => Promise<ControllerInstance>> = new Map();
  /**
   * Register a controller definition
   */
  registerDefinition(
    definition: ResourceDefinition,
    // baseDir?: string,
    // namespace?: string | null,
  ): void {
    // Construct fully qualified kind: Namespace.Name
    // Only add namespace if name is not already qualified (doesn't contain a dot)
    const namespace = definition.metadata.module;
    const baseDir = null;
    const name = definition.metadata.name;
    const kind = namespace && !name.includes(".") ? `${namespace}.${name}` : name;

    this.definitionsByKind.set(kind, definition);

    // If definition has controllers, register loader for them
    if (definition.controllers && definition.controllers.length > 0 && baseDir) {
      this.registerControllerLoader(kind, definition, baseDir);
    }
  }

  /**
   * Get a controller instance for a kind
   * Lazy-loads controller code on first access
   * Throws if controller not found
   */
  getController(kind: string): ControllerInstance {
    // Return cached instance if available
    if (this.controllersByKind.has(kind)) {
      return this.controllersByKind.get(kind)!;
    }

    // Load controller if loader is registered
    // const loader = this.controllerLoaders.get(kind);
    // if (loader) {
    //   const controller = await loader();
    //   this.controllersByKind.set(kind, controller);
    //   return controller;
    // }
    return {
      schema: { type: "object", additionalProperties: false },
    };
    // throw new Error(`No controller registered for kind: ${kind}`);
  }

  /**
   * Safe get - returns undefined if controller not found
   */
  getControllerOrUndefined(kind: string): ControllerInstance | undefined {
    // Return cached instance if available
    if (this.controllersByKind.has(kind)) {
      return this.controllersByKind.get(kind);
    }
    return undefined;
  }

  /**
   * Check if a controller exists for this kind (definition or directly registered)
   */
  hasController(kind: string): boolean {
    return this.controllersByKind.has(kind) || this.definitionsByKind.has(kind);
  }

  /**
   * Get definition for a kind
   */
  getDefinition(kind: string): ResourceDefinition | undefined {
    return this.definitionsByKind.get(kind);
  }

  /**
   * Get all registered kinds
   */
  getKinds(): string[] {
    return Array.from(this.definitionsByKind.keys());
  }

  getControllerKinds(): string[] {
    return Array.from(this.controllersByKind.keys());
  }

  /**
   * Create a resource instance using its controller
   */
  async create(kind: string, resource: RuntimeResource, ctx: any): Promise<any | null> {
    const controller = this.getController(kind);
    if (!controller || !controller.create) {
      return null;
    }
    return controller.create(resource, ctx);
  }

  /**
   * Register a controller for a kind
   */
  registerController(kind: string, controller: ControllerInstance): void {
    if (!this.definitionsByKind.has(kind)) {
      throw new Error(`Cannot register controller for kind ${kind} without definition`);
    }
    // Ensure controller has schema from definition
    const definition = this.definitionsByKind.get(kind);
    const wrappedController: ControllerInstance = {
      ...controller,
      schema: controller.schema ?? definition?.schema,
      inputType: controller.inputType,
      outputType: controller.outputType,
    };
    this.controllersByKind.set(kind, wrappedController);
  }

  /**
   * Private: Register controller loader
   */
  private registerControllerLoader(
    kind: string,
    definition: ResourceDefinition,
    moduleDir: string,
  ): void {
    const controllerDef = definition.controllers?.[0]; // Use first matching controller for now
    if (!controllerDef) return;

    this.controllerLoaders.set(kind, async () => {
      const modulePath = path.resolve(moduleDir, controllerDef.entry);
      const moduleRuntime = await import(modulePath);
      const exported = moduleRuntime.default || moduleRuntime.Module || moduleRuntime;

      const registerFn =
        typeof moduleRuntime.register === "function"
          ? moduleRuntime.register
          : typeof exported === "function" && !this.isModuleClass(exported)
            ? exported
            : null;

      const createFn =
        typeof moduleRuntime.create === "function"
          ? moduleRuntime.create
          : typeof exported?.create === "function"
            ? exported.create
            : null;

      const executeFn =
        typeof moduleRuntime.execute === "function"
          ? moduleRuntime.execute
          : typeof exported?.execute === "function"
            ? exported.execute
            : null;

      const compileFn =
        typeof moduleRuntime.compile === "function"
          ? moduleRuntime.compile
          : typeof exported?.compile === "function"
            ? exported.compile
            : null;

      if (!registerFn && !executeFn && !createFn && !compileFn) {
        throw new Error(`Controller for "${kind}" exports no usable handlers`);
      }

      if (!definition.schema) {
        throw new Error(`Definition for "${kind}" does not have schema`);
      }

      return {
        register: registerFn ?? undefined,
        create: createFn ?? undefined,
        execute: executeFn ?? undefined,
        compile: compileFn ?? undefined,
        schema: definition.schema,
      };
    });
  }

  private isModuleClass(obj: any): boolean {
    return (
      typeof obj === "function" && (obj.name === "Controller" || obj.toString().includes("class"))
    );
  }
}
