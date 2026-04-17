import type { ResourceDefinition } from "@telorun/sdk";
import { KERNEL_BUILTINS } from "./builtins.js";
import { buildReferenceFieldMap, type ReferenceFieldMap } from "./reference-field-map.js";
import { createAjv, formatSingleError } from "./schema-compat.js";

/** Pure kind → ResourceDefinition map. No controller loading, no lifecycle. */
export class DefinitionRegistry {
  constructor() {
    for (const def of KERNEL_BUILTINS) this.register(def);
  }

  /** Per-instance AJV for cross-module $ref resolution. Isolated so each registry
   *  (and thus each AnalysisContext) has its own schema store — no stale schemas
   *  across analyze() calls and no unbounded growth across the process lifetime. */
  private readonly ajv = createAjv();
  private readonly registeredSchemaIds = new Set<string>();

  private readonly defs = new Map<string, ResourceDefinition>();
  private readonly fieldMaps = new Map<string, ReferenceFieldMap>();
  /** Reverse inheritance index: parent kind → direct child kinds. */
  private readonly extendedBy = new Map<string, string[]>();
  /** Module identity table: identity string → canonical module name.
   *  "telo" → "Telo", "std/pipeline" → "pipeline", etc. */
  private readonly identityMap = new Map<string, string>();
  /** Reverse identity table: canonical module name → full identity string.
   *  "Telo" → "telo", "pipeline" → "std/pipeline", etc.
   *  Used to compute definition $id values for the AJV schema store. */
  private readonly reverseIdentityMap = new Map<string, string>();

  register(definition: ResourceDefinition): void {
    const { name, module: mod } = definition.metadata;
    const key = mod ? `${mod}.${name}` : name;
    this.defs.set(key, definition);
    this.fieldMaps.set(key, buildReferenceFieldMap(definition.schema ?? {}));
    if (definition.capability) {
      const children = this.extendedBy.get(definition.capability);
      if (children) {
        children.push(key);
      } else {
        this.extendedBy.set(definition.capability, [key]);
      }
    }
    // Auto-register the telo identity when any Telo built-in is registered.
    if (definition.kind === "Telo.Abstract" && mod === "Telo") {
      this.identityMap.set("telo", "Telo");
      this.reverseIdentityMap.set("Telo", "telo");
    }
    // If identity is already known, register the schema in AJV immediately.
    if (mod && definition.schema) {
      this.tryRegisterSchema(mod, name as string, definition.schema as Record<string, any>);
    }
  }

  /** Register a module identity for x-telo-ref resolution.
   *  Call once per module doc (Telo.Application or Telo.Library) when the manifest is loaded.
   *  @param namespace  The module's metadata.namespace (e.g. "std"), or null for telo built-ins.
   *  @param moduleName The module's metadata.name (e.g. "pipeline", "http-server"). */
  registerModuleIdentity(namespace: string | null, moduleName: string): void {
    const identity = namespace ? `${namespace}/${moduleName}` : "telo";
    this.identityMap.set(identity, moduleName);
    this.reverseIdentityMap.set(moduleName, identity);
    // Retroactively register AJV schemas for definitions of this module already in the registry.
    for (const def of this.defs.values()) {
      if (def.metadata.module === moduleName && def.schema) {
        this.tryRegisterSchema(
          moduleName,
          def.metadata.name as string,
          def.schema as Record<string, any>,
        );
      }
    }
  }

  /** Computes the $id for a definition schema: "<identity>/<TypeName>".
   *  Returns undefined when the module identity is not yet registered. */
  computeId(moduleName: string, typeName: string): string | undefined {
    const identity = this.reverseIdentityMap.get(moduleName);
    if (!identity) return undefined;
    return `${identity}/${typeName}`;
  }

  /** Validates data against a schema using this registry's AJV instance, which has all
   *  registered definition schemas loaded — enabling cross-module $ref resolution. */
  validateWithRefs(data: unknown, schema: Record<string, any>): string[] {
    let validate: ReturnType<typeof this.ajv.compile>;
    try {
      validate = this.ajv.compile(schema);
    } catch {
      return [];
    }
    if (validate(data)) return [];
    return (validate.errors ?? []).map(formatSingleError);
  }

  private tryRegisterSchema(
    moduleName: string,
    typeName: string,
    schema: Record<string, any>,
  ): void {
    const id = this.computeId(moduleName, typeName);
    if (!id || this.registeredSchemaIds.has(id)) return;
    if (this.ajv.getSchema(id)) {
      throw new Error(`Duplicate definition schema $id: "${id}" is already registered`);
    }
    this.ajv.addSchema(schema, id);
    this.registeredSchemaIds.add(id);
  }

  /** Resolves an x-telo-ref string to a canonical registry kind key.
   *  Splits on "#", looks up the left side in the identity table, and returns
   *  "<canonicalModule>.<TypeName>".
   *
   *  "telo#Invocable"         → "Telo.Invocable"
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

  /** Returns the field map for `kind`, falling back to the alias-resolved kind when not found. */
  getFieldMapForKind(
    kind: string,
    aliases?: { resolveKind(k: string): string | undefined },
  ): ReferenceFieldMap | undefined {
    const fm = this.getFieldMap(kind);
    if (fm) return fm;
    const resolved = aliases?.resolveKind(kind);
    return resolved ? this.getFieldMap(resolved) : undefined;
  }

  /** Returns all definitions that transitively extend the given abstract kind.
   *  Follows the capability chain to any depth (equivalent to instanceof in OOP).
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
