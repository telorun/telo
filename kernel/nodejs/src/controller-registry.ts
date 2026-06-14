import { ControllerInstance, ResourceDefinition, RuntimeError } from "@telorun/sdk";

const DEFAULT_FINGERPRINT = "default";

/**
 * ControllerRegistry: Manages controller loading and dispatch
 * Maps fully-qualified resource kinds to their controller implementations.
 *
 * Controllers are keyed by `(kind, runtimeFingerprint)` so that two
 * `Telo.Import`s of the same library with different `runtime:` selections
 * each get their own cached controller instance — the first winner does not
 * lock out the second. Definitions remain kind-only; only the loaded
 * controller instance is policy-scoped.
 */
/**
 * A controller whose definition has been resolved but whose module is not yet
 * imported. `load()` performs the import + `registerController` (firing the
 * controller's `register()` hook); `loading` single-flights concurrent
 * instantiations of the same kind through one import.
 */
interface LazyControllerEntry {
  load: () => Promise<void>;
  loading?: Promise<void>;
}

export class ControllerRegistry {
  private controllersByKind: Map<string, Map<string, ControllerInstance>> = new Map();
  private definitionsByKind: Map<string, ResourceDefinition> = new Map();
  private lazyByKind: Map<string, Map<string, LazyControllerEntry>> = new Map();

  /**
   * Register a controller definition
   */
  registerDefinition(definition: ResourceDefinition): void {
    const namespace = definition.metadata.module;
    const name = definition.metadata.name;
    const kind = namespace && !name.includes(".") ? `${namespace}.${name}` : name;
    this.definitionsByKind.set(kind, definition);
  }

  /**
   * Get a controller instance for a (kind, fingerprint) pair. Lookup order:
   *  1. Exact match for the requested fingerprint (the common path).
   *  2. The "default" fingerprint — kernel built-ins register here once and
   *     should be reachable from any module's fingerprinted lookup.
   *  3. The first registered entry for this kind, regardless of fingerprint
   *     — handles the case of a root-context resource referencing a kind
   *     that an import loaded under its own runtime selection.
   *
   * Throws `ERR_CONTROLLER_NOT_LOADED` on full miss.
   */
  getController(kind: string, fingerprint: string = DEFAULT_FINGERPRINT): ControllerInstance {
    const cached = this.lookup(kind, fingerprint);
    if (cached) {
      return cached;
    }
    throw new RuntimeError(
      "ERR_CONTROLLER_NOT_LOADED",
      `No controller loaded for kind "${kind}" (runtime fingerprint "${fingerprint}"). The kind's Telo.Definition must init before its controller is consulted.`,
    );
  }

  /**
   * Safe get - returns undefined if controller not found. Same fallback
   * order as `getController`.
   */
  getControllerOrUndefined(
    kind: string,
    fingerprint: string = DEFAULT_FINGERPRINT,
  ): ControllerInstance | undefined {
    return this.lookup(kind, fingerprint);
  }

  private lookup(kind: string, fingerprint: string): ControllerInstance | undefined {
    const byFp = this.controllersByKind.get(kind);
    if (!byFp) return undefined;
    return (
      byFp.get(fingerprint) ??
      byFp.get(DEFAULT_FINGERPRINT) ??
      byFp.values().next().value
    );
  }

  /**
   * Check if any controller exists for this kind (any fingerprint, or just a definition).
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

  /**
   * Distinct kinds with at least one registered controller. Used by the boot
   * register-hook loop, which fires once per kind regardless of fingerprint.
   */
  getControllerKinds(): string[] {
    return Array.from(this.controllersByKind.keys());
  }

  /**
   * Distinct controller `schema` objects across all registered kinds (one per
   * kind, default fingerprint preferred). Used by the build-time validator warm
   * to pre-compile the framework/builtin controller schemas (`Telo.Import`,
   * `Telo.Definition`, the module controller, …) the runtime validates
   * resources against — module-defined kinds aren't registered here until
   * instantiation, so those are warmed from the static manifests instead.
   */
  getControllerSchemas(): object[] {
    const schemas: object[] = [];
    for (const byFp of this.controllersByKind.values()) {
      const controller = byFp.get(DEFAULT_FINGERPRINT) ?? byFp.values().next().value;
      const schema = controller?.schema;
      if (schema && typeof schema === "object") schemas.push(schema);
    }
    return schemas;
  }

  /**
   * Register a controller for a (kind, fingerprint). Multiple registrations
   * for the same kind with different fingerprints coexist; same fingerprint
   * overwrites the prior entry.
   */
  registerController(
    kind: string,
    controller: ControllerInstance,
    fingerprint: string = DEFAULT_FINGERPRINT,
  ): void {
    if (!this.definitionsByKind.has(kind)) {
      throw new Error(`Cannot register controller for kind ${kind} without definition`);
    }
    const definition = this.definitionsByKind.get(kind);
    const wrappedController: ControllerInstance = {
      ...controller,
      schema: controller.schema ?? definition?.schema,
      inputType: controller.inputType,
      outputType: controller.outputType,
    };
    let byFp = this.controllersByKind.get(kind);
    if (!byFp) {
      byFp = new Map();
      this.controllersByKind.set(kind, byFp);
    }
    byFp.set(fingerprint, wrappedController);
  }

  /**
   * Register a deferred controller for a (kind, fingerprint). The definition's
   * metadata is already registered (so analysis/refs work); the controller
   * module itself is imported lazily by {@link takeLazyController} on the kind's
   * first instantiation. Mirrors `registerController`'s fingerprint keying.
   */
  registerLazyController(
    kind: string,
    fingerprint: string,
    load: () => Promise<void>,
  ): void {
    if (!this.definitionsByKind.has(kind)) {
      throw new Error(`Cannot register lazy controller for kind ${kind} without definition`);
    }
    let byFp = this.lazyByKind.get(kind);
    if (!byFp) {
      byFp = new Map();
      this.lazyByKind.set(kind, byFp);
    }
    byFp.set(fingerprint, { load });
  }

  /**
   * Drive the deferred import for a (kind, fingerprint) if one is registered,
   * single-flighting concurrent callers through the same import. Returns true
   * when a lazy entry existed (after its `load()` has completed and the
   * controller is registered), false when there is none — letting the caller
   * fall through to its existing "no controller" handling. Same fingerprint
   * fallback order as `getControllerOrUndefined`.
   */
  async takeLazyController(
    kind: string,
    fingerprint: string = DEFAULT_FINGERPRINT,
  ): Promise<boolean> {
    const byFp = this.lazyByKind.get(kind);
    if (!byFp) return false;
    const entry =
      byFp.get(fingerprint) ?? byFp.get(DEFAULT_FINGERPRINT) ?? byFp.values().next().value;
    if (!entry) return false;
    if (!entry.loading) {
      // Reset on failure so a later instantiation re-attempts and re-surfaces
      // the error rather than awaiting a cached rejection forever.
      entry.loading = entry.load().catch((err) => {
        entry.loading = undefined;
        throw err;
      });
    }
    await entry.loading;
    return true;
  }
}
