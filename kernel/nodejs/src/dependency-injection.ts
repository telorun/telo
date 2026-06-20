import { ResourceInstance, ResourceManifest, RuntimeError, stampRefIdentity } from "@telorun/sdk";

/**
 * Walks `resource` following `fieldPath` (dot notation, `[]` = array traversal,
 * `{}` = map traversal). For each leaf value that looks like a {kind, name}
 * reference, calls getInstance(name) and replaces the value in-place with the
 * returned live ResourceInstance. Values where getInstance returns undefined are
 * left unchanged.
 */
export function injectAtPath(
  resource: ResourceManifest,
  fieldPath: string,
  getInstance: (name: string, alias?: string) => ResourceInstance | undefined,
  isPending?: (name: string) => boolean,
): void {
  const parts = fieldPath.split(".");

  // Resolve a {kind, name, alias?} reference to its live instance. A non-`Self` alias is a
  // cross-module reference into an import's published exports; if that import hasn't
  // finished init() yet the instance is absent, so we throw to defer this resource to a
  // later pass of the multi-pass init loop (which catches and retries) rather than leaving
  // the ref unresolved. A LOCAL ref (no alias) that names a resource registered in this
  // context but not yet initialized is deferred the same way — create-success order does
  // not always match init order (e.g. a globally-registered controller lets a dependent
  // create before its dependency's controller has loaded), so injection can run before the
  // dependency inits. Without this defer the slot would be left unresolved and surface as a
  // runtime ERR_RESOURCE_NOT_INVOKABLE. A local ref that names nothing pending is left as-is
  // (topo ordering / later diagnostics), matching prior behaviour.
  function resolveInto(ref: Record<string, unknown>): ResourceInstance | undefined {
    const alias = typeof ref.alias === "string" ? ref.alias : undefined;
    const instance = getInstance(ref.name as string, alias);
    if (!instance && alias && alias !== "Self") {
      throw new RuntimeError(
        "ERR_CROSS_MODULE_REF_PENDING",
        `Cross-module reference '${alias}.${String(ref.name)}' is not available yet (import not initialized)`,
      );
    }
    if (!instance && (!alias || alias === "Self") && isPending?.(ref.name as string)) {
      throw new RuntimeError(
        "ERR_LOCAL_REF_PENDING",
        `Local reference '${String(ref.name)}' is registered but not initialized yet (deferring to a later init pass)`,
      );
    }
    // Tag the instance with the kind+name it resolved from, so a consumer that
    // holds only the bare instance (an invoke-step target) can dispatch it
    // through the traced chokepoint rather than calling `.invoke()` directly.
    if (instance && typeof ref.kind === "string" && typeof ref.name === "string") {
      stampRefIdentity(instance, ref.kind, ref.name);
    }
    return instance;
  }

  function traverse(obj: unknown, partsLeft: string[]): void {
    if (!obj || typeof obj !== "object" || partsLeft.length === 0) return;
    const [head, ...rest] = partsLeft;

    // Map iteration: descend into every value of the current object (used for
    // schema fields with `additionalProperties` like `content[mime]`).
    if (head === "{}") {
      const container = obj as Record<string, unknown>;
      for (const mapKey of Object.keys(container)) {
        const elem = container[mapKey];
        if (!elem || typeof elem !== "object") continue;
        if (rest.length === 0) {
          const ref = elem as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) container[mapKey] = instance;
          }
        } else {
          traverse(elem, rest);
        }
      }
      return;
    }

    const isArr = head.endsWith("[]");
    const key = isArr ? head.slice(0, -2) : head;
    const container = obj as Record<string, unknown>;
    const val = container[key];
    if (val == null) return;

    if (isArr) {
      if (!Array.isArray(val)) return;
      for (let i = 0; i < val.length; i++) {
        const elem = val[i];
        if (!elem || typeof elem !== "object") continue;
        if (rest.length === 0) {
          const ref = elem as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) val[i] = instance;
          }
        } else {
          traverse(elem, rest);
        }
      }
    } else {
      if (rest.length === 0) {
        if (val && typeof val === "object" && !Array.isArray(val)) {
          const ref = val as Record<string, unknown>;
          if (typeof ref.kind === "string" && typeof ref.name === "string") {
            const instance = resolveInto(ref);
            if (instance) container[key] = instance;
          }
        }
      } else {
        traverse(val, rest);
      }
    }
  }

  traverse(resource, parts);
}
