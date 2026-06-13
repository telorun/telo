import { ResourceInstance, ResourceManifest, RuntimeError } from "@telorun/sdk";

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
): void {
  const parts = fieldPath.split(".");

  // Resolve a {kind, name, alias?} reference to its live instance. A non-`Self` alias is a
  // cross-module reference into an import's published exports; if that import hasn't
  // finished init() yet the instance is absent, so we throw to defer this resource to a
  // later pass of the multi-pass init loop (which catches and retries) rather than leaving
  // the ref unresolved. Local refs (no alias) that miss are left for topo ordering / later
  // diagnostics, matching prior behaviour.
  function resolveInto(ref: Record<string, unknown>): ResourceInstance | undefined {
    const alias = typeof ref.alias === "string" ? ref.alias : undefined;
    const instance = getInstance(ref.name as string, alias);
    if (!instance && alias && alias !== "Self") {
      throw new RuntimeError(
        "ERR_CROSS_MODULE_REF_PENDING",
        `Cross-module reference '${alias}.${String(ref.name)}' is not available yet (import not initialized)`,
      );
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
