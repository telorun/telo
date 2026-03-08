import { EmitEvent, InstanceFactory, ModuleContext } from "@telorun/sdk";

/**
 * Per-module ModuleContext registry, keyed by module name.
 *
 * Stores persistent (stateful) ModuleContext instances that accumulate
 * variables, secrets, and resources throughout the initialization phase.
 * Each instance is created once and mutated in place — no ephemeral snapshots.
 */
export class ModuleContextRegistry {
  private readonly store = new Map<string, ModuleContext>();
  private readonly declaredModules = new Set<string>();

  constructor(
    private readonly createInstance: InstanceFactory = async () => null,
    private readonly emitEvent: EmitEvent,
  ) {}

  /**
   * Mark a module name as declared and ensure its persistent context exists.
   * Called by the kernel whenever a kind: Kernel.Module manifest is registered
   * so that getContext() can distinguish "not yet populated" from "unknown".
   */
  declareModule(moduleName: string): void {
    // this.declaredModules.add(moduleName);
    // // Idempotent: if the module context was already created (e.g. by a previous pass
    // // of the multi-pass init loop that was retried), keep the existing context.
    // if (this.store.has(moduleName)) return;
    // const ctx = new ModuleContext({}, {}, {}, [], this.createInstance, this.emitEvent);
    // // Every module automatically gets access to Kernel.* built-in kinds.
    // ctx.registerImport("Kernel", "Kernel", []);
    // this.store.set(moduleName, ctx);
  }

  private getOrCreate(moduleName: string): ModuleContext {
    if (!this.store.has(moduleName)) {
      this.store.set(
        moduleName,
        new ModuleContext("", {}, {}, {}, [], this.createInstance, this.emitEvent),
      );
    }
    return this.store.get(moduleName)!;
  }

  /**
   * Set variables and secrets on the module's persistent context.
   * Called by the kernel after a Kernel.Module resource is created.
   */
  setVariablesAndSecrets(
    moduleName: string,
    variables: Record<string, unknown>,
    secrets: Record<string, unknown>,
  ): void {
    const ctx = this.getOrCreate(moduleName);
    ctx.setVariables(variables);
    ctx.setSecrets(secrets);
  }

  /**
   * Register or update a single resource's exported properties in the
   * module's `resources` namespace.
   */
  setResource(moduleName: string, resourceName: string, props: Record<string, unknown>): void {
    this.getOrCreate(moduleName).setResource(resourceName, props);
  }

  /**
   * Return the persistent ModuleContext for the given module name.
   *
   * If the module has been declared but not yet populated, returns the empty
   * context so the multi-pass init loop can retry once the import controller
   * has injected variables and secrets.
   *
   * If the module name is completely unknown throws immediately so the error
   * surfaces as an init failure rather than a cryptic CEL runtime message.
   */
  getContext(moduleName: string): ModuleContext {
    // throw new Error("asd");
    const ctx = this.store.get(moduleName);
    if (!ctx) {
      if (!this.declaredModules.has(moduleName)) {
        const known = [...this.declaredModules].join(", ") || "(none)";
        throw new Error(
          `Module '${moduleName}' not found. ` +
            `Check that metadata.module matches a declared module name. ` +
            `Known modules: ${known}.`,
        );
      }
      // Declared but context not yet populated — return the empty context that
      // declareModule() already created.
      return (
        this.store.get(moduleName) ??
        new ModuleContext("", {}, {}, {}, [], this.createInstance, this.emitEvent)
      );
    }
    return ctx;
  }

  hasModule(moduleName: string): boolean {
    return this.store.has(moduleName);
  }

  isDeclared(moduleName: string): boolean {
    return this.declaredModules.has(moduleName);
  }

  /** Iterate all registered module contexts (used for kernel-wide queries). */
  allContexts(): IterableIterator<ModuleContext> {
    return this.store.values();
  }
}
