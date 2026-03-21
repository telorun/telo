import type { ResourceDefinition } from "@telorun/sdk";
import { buildReferenceFieldMap, type ReferenceFieldMap } from "./reference-field-map.js";

/** Pure kind → ResourceDefinition map. No controller loading, no lifecycle. */
export class DefinitionRegistry {
  private readonly defs = new Map<string, ResourceDefinition>();
  private readonly fieldMaps = new Map<string, ReferenceFieldMap>();
  /** Reverse inheritance index: parent kind → direct child kinds. */
  private readonly extendedBy = new Map<string, string[]>();
  /** Module identity table: identity string → canonical module name.
   *  "kernel" → "Kernel", "std/pipeline" → "pipeline", etc. */
  private readonly identityMap = new Map<string, string>();

  register(definition: ResourceDefinition): void {
    const { name, module: mod } = definition.metadata;
    const key = mod ? `${mod}.${name}` : name;
    this.defs.set(key, definition);
    this.fieldMaps.set(key, buildReferenceFieldMap(definition.schema ?? {}));
    if (definition.extends) {
      const children = this.extendedBy.get(definition.extends);
      if (children) {
        children.push(key);
      } else {
        this.extendedBy.set(definition.extends, [key]);
      }
    }
    // Auto-register the kernel identity when any Kernel built-in is registered.
    if (definition.kind === "Kernel.Abstract" && mod === "Kernel") {
      this.identityMap.set("kernel", "Kernel");
    }
  }

  /** Register a module identity for x-telo-ref resolution.
   *  Call once per Kernel.Module manifest when the manifest is loaded.
   *  @param namespace  The module's metadata.namespace (e.g. "std"), or null for kernel built-ins.
   *  @param moduleName The module's metadata.name (e.g. "pipeline", "http-server"). */
  registerModuleIdentity(namespace: string | null, moduleName: string): void {
    const identity = namespace ? `${namespace}/${moduleName}` : "kernel";
    this.identityMap.set(identity, moduleName);
  }

  /** Resolves an x-telo-ref string to a canonical registry kind key.
   *  Splits on "#", looks up the left side in the identity table, and returns
   *  "<canonicalModule>.<TypeName>".
   *
   *  "kernel#Invocable"       → "Kernel.Invocable"
   *  "std/pipeline#Job"       → "pipeline.Job"
   *  "std/http-server#Server" → "http-server.Server"
   *
   *  Returns undefined when the string is malformed or the identity is not registered. */
  resolveRef(xTeloRef: string): string | undefined {
    const hash = xTeloRef.indexOf("#");
    if (hash === -1 || hash === xTeloRef.length - 1) return undefined;
    const identity = xTeloRef.slice(0, hash);
    const typeName = xTeloRef.slice(hash + 1);
    const moduleName = this.identityMap.get(identity);
    if (!moduleName) return undefined;
    return `${moduleName}.${typeName}`;
  }

  resolve(kind: string): ResourceDefinition | undefined {
    return this.defs.get(kind);
  }

  /** Returns the cached reference field map for the given kind, built once during register(). */
  getFieldMap(kind: string): ReferenceFieldMap | undefined {
    return this.fieldMaps.get(kind);
  }

  /** Returns all definitions that transitively extend the given abstract kind.
   *  Follows the extends chain to any depth (equivalent to instanceof in OOP).
   *  Definitions are included regardless of registration order. */
  getByExtends(abstractKind: string): ResourceDefinition[] {
    const result: ResourceDefinition[] = [];
    const queue = [abstractKind];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      const children = this.extendedBy.get(parent);
      if (!children) continue;
      for (const child of children) {
        const def = this.defs.get(child);
        if (def) result.push(def);
        queue.push(child);
      }
    }
    return result;
  }

  kinds(): string[] {
    return Array.from(this.defs.keys());
  }
}
