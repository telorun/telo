import { ModuleContext } from "./evaluation-context.js";

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

function emptyModuleContext(): ModuleContext {
  return new ModuleContext({}, {}, {}, {});
}

/**
 * Per-module ModuleContext store, keyed by module name.
 *
 * Accumulates variables, secrets, resources, and imports for each module
 * during the initialization phase. Used by the kernel to build the flat
 * CEL evaluation context for resources within a module.
 */
export class ModuleContextRegistry {
  private readonly store = new Map<
    string,
    {
      variables: Record<string, unknown>;
      secrets: Record<string, unknown>;
      resources: Record<string, unknown>;
      imports: Record<string, unknown>;
    }
  >();

  /** Module names explicitly declared via a kind: Kernel.Module manifest. */
  private readonly declaredModules = new Set<string>();

  /**
   * Mark a module name as declared. Called by the kernel whenever a
   * kind: Kernel.Module manifest is registered so that getContext() can
   * distinguish "not yet populated" (valid during multi-pass init) from
   * "completely unknown module name" (always an error).
   */
  declareModule(moduleName: string): void {
    this.declaredModules.add(moduleName);
  }

  private getOrCreate(moduleName: string) {
    if (!this.store.has(moduleName)) {
      this.store.set(moduleName, {
        variables: {},
        secrets: {},
        resources: {},
        imports: {},
      });
    }
    return this.store.get(moduleName)!;
  }

  /**
   * Register variables and secrets for a module.
   * Called by the kernel after a Kernel.Module resource is created.
   */
  setVariablesAndSecrets(
    moduleName: string,
    variables: Record<string, unknown>,
    secrets: Record<string, unknown>,
  ): void {
    const entry = this.getOrCreate(moduleName);
    entry.variables = { ...variables };
    entry.secrets = { ...secrets };
  }

  /**
   * Register or update a single resource's exported properties in the
   * module's `resources` namespace.
   */
  setResource(
    moduleName: string,
    resourceName: string,
    props: Record<string, unknown>,
  ): void {
    const entry = this.getOrCreate(moduleName);
    entry.resources = { ...entry.resources, [resourceName]: props };
  }

  /**
   * Register or update an imported module's exported properties under an alias
   * in the module's `imports` namespace. Called by the Import controller.
   */
  setImport(
    moduleName: string,
    alias: string,
    exports: Record<string, unknown>,
  ): void {
    const entry = this.getOrCreate(moduleName);
    entry.imports = { ...entry.imports, [alias]: exports };
  }

  /**
   * Return a ModuleContext for the given module name.
   *
   * If the module has been declared (a kind: Kernel.Module manifest was
   * registered for it) but not yet populated, returns an empty context so
   * the multi-pass init loop can retry once the import controller has
   * injected the variables and secrets.
   *
   * If the module name is completely unknown — i.e. no kind: Kernel.Module
   * manifest was ever registered for it — throws immediately so the error
   * surfaces as an init failure rather than a cryptic CEL "Identifier not
   * found" message at runtime.
   */
  getContext(moduleName: string): ModuleContext {
    const entry = this.store.get(moduleName);
    if (!entry) {
      if (!this.declaredModules.has(moduleName)) {
        const known = [...this.declaredModules].join(", ") || "(none)";
        throw new Error(
          `Module '${moduleName}' not found. ` +
          `Check that metadata.module matches a declared module name. ` +
          `Known modules: ${known}.`,
        );
      }
      return emptyModuleContext();
    }
    return new ModuleContext(
      entry.variables,
      entry.secrets,
      entry.resources,
      entry.imports,
    );
  }

  hasModule(moduleName: string): boolean {
    return this.store.has(moduleName);
  }
}
