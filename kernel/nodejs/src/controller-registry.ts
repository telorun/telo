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
export class ControllerRegistry {
  private controllersByKind: Map<string, Map<string, ControllerInstance>> = new Map();
  private definitionsByKind: Map<string, ResourceDefinition> = new Map();

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
}
