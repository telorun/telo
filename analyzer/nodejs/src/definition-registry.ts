import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { KERNEL_BUILTINS } from "./builtins.js";
import {
  buildFieldMapAtPath,
  buildReferenceFieldMap,
  isSchemaFromEntry,
  type ReferenceFieldMap,
} from "./reference-field-map.js";
import { createAjv, formatSingleError, navigateJsonPointer } from "./schema-compat.js";
import { effectiveAuthorSchema } from "./extends-resolution.js";

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
  /** The subset of `registeredSchemaIds` claimed by a kind's schema. Kinds and
   *  named `Telo.Type`s share one `telo://<module>/<Name>` id space, so this is
   *  what lets a colliding type name be reported instead of silently dropped. */
  private readonly definitionSchemaIds = new Set<string>();

  private readonly defs = new Map<string, ResourceDefinition>();
  private readonly fieldMaps = new Map<string, ReferenceFieldMap>();
  /** Reverse inheritance index: parent kind → direct child kinds. */
  private readonly extendedBy = new Map<string, string[]>();
  /** DEPRECATED module identity table: identity string → canonical module name
   *  ("std/pipeline" → "pipeline"). Serves only the legacy
   *  `<namespace>/<module>#<Kind>` form of `x-telo-ref`, kept resolvable for
   *  module versions published before constraints named their target by import
   *  alias. Fed by `metadata.namespace`, which nothing else reads. */
  private readonly identityMap = new Map<string, string>();

  register(definition: ResourceDefinition): void {
    const { name, module: mod } = definition.metadata;
    const key = mod ? `${mod}.${name}` : name;
    this.defs.set(key, definition);
    // Field maps derive from the AUTHOR-FACING (inheritance-resolved) schema, which
    // depends on the parent — possibly registered after this child. Clear the cache
    // so any already-computed map recomputes against the now-larger def set; the
    // maps rebuild lazily on first `getFieldMap` (after all defs are registered).
    this.fieldMaps.clear();
    // `capability` populates extendedBy for backward-compat with the legacy pattern where
    // a concrete definition overloaded `capability: <AbstractKind>` to mean "implements
    // this abstract." The canonical pattern is `extends` (below). Both populate the index,
    // unioned — so in-flight modules pre-migration keep working.
    if (definition.capability) {
      this.addExtendedBy(definition.capability, key);
    }
    // `extends` — first-class "implements-this-abstract" edge. Alias-form resolution
    // happens in the analyzer before register() is called (analyzer.ts pre-resolves
    // via aliases.resolveKind), so the value here is already the canonical kind string
    // (e.g. "workflow.Backend"). If the analyzer could not resolve the alias (partial
    // context, or the declaring file doesn't import the target's alias), the value
    // stays as the original alias-prefixed form; validateExtends emits EXTENDS_MALFORMED
    // or EXTENDS_UNKNOWN_TARGET depending on the case.
    if (definition.extends) {
      this.addExtendedBy(definition.extends, key);
    }
    // Auto-register the legacy telo identity when any Telo built-in is registered,
    // so an already-published `x-telo-ref: "telo#Invocable"` still resolves.
    if (definition.kind === "Telo.Abstract" && mod === "Telo") {
      this.identityMap.set("telo", "Telo");
    }
    if (mod && definition.schema) {
      this.tryRegisterSchema(mod, name as string, definition.schema as Record<string, any>);
    }
  }

  private addExtendedBy(parent: string, child: string): void {
    const children = this.extendedBy.get(parent);
    if (children) {
      if (!children.includes(child)) children.push(child);
    } else {
      this.extendedBy.set(parent, [child]);
    }
  }

  /** DEPRECATED. Register a module identity so the legacy
   *  `<namespace>/<module>#<Kind>` form of `x-telo-ref` still resolves for module
   *  versions published before constraints named their target by import alias.
   *  New manifests declare no namespace and need no identity — their constraints
   *  are canonicalized to `<module>.<Kind>` before registration.
   *
   *  The "telo" identity is reserved for the built-in module and is populated
   *  automatically when a `Telo.Abstract` registers. A namespace-less module must
   *  not claim it: overwriting the entry would repoint every legacy `telo#…`
   *  constraint at a module that declares no such kind, and the resulting
   *  unresolvable ref reads as partial context rather than an error.
   *
   *  @param namespace  The module's `metadata.namespace`, or null when it declares none.
   *  @param moduleName The module's `metadata.name` (e.g. "pipeline", "http-server"). */
  registerModuleIdentity(namespace: string | null, moduleName: string): void {
    if (!namespace || moduleName === "Telo") return;
    this.identityMap.set(`${namespace}/${moduleName}`, moduleName);
  }

  /** Registers a named `Telo.Type` resource's schema under its canonical
   *  module-scoped URI `$id` (`telo://<module>/<name>`), so a sibling schema's
   *  `$ref: "telo://Self/<name>"` (rewritten to the canonical form by
   *  `resolveSchemaTypeRefs`) resolves during AJV compilation. Mirrors the
   *  kernel type controller's `registerSchema(canonicalTypeSchemaId(...))`.
   *
   *  Returns `false` when a kind schema in the same module already owns the id —
   *  a name collision between a kind and a named type. Definitions register
   *  first, so the type is the one that would be dropped, and every
   *  `$ref: "telo://<module>/<Name>"` would then silently validate against the
   *  kind's schema instead. The caller reports it; nothing is overwritten. */
  registerNamedTypeSchema(id: string, schema: Record<string, any>): boolean {
    if (this.definitionSchemaIds.has(id)) return false;
    if (this.registeredSchemaIds.has(id) || this.ajv.getSchema(id)) return true;
    if (!this.tryAddSchema(schema, id)) return true;
    this.registeredSchemaIds.add(id);
    return true;
  }

  /**
   * Register a schema, surviving one AJV refuses.
   *
   * `addSchema` META-VALIDATES and THROWS, and a throw here escapes the whole
   * analyze pass: one author schema with `minimum: "3"` in it aborted the run
   * with AJV's own unanchored text and took every other diagnostic in the file
   * down with it — including the anchored one that says exactly which keyword is
   * wrong. Registration is a lookup table for `$ref` resolution, so failing to
   * fill one entry costs a reference that could not have resolved anyway.
   *
   * Nothing is swallowed: an unregisterable schema is invalid, and the two
   * checks that report it both run afterwards and both anchor on the offending
   * line — `SCHEMA_VIOLATION` from the `KindSchema` / `JsonSchema7` fragment the
   * slot points at, and `SCHEMA_COMPILE_ERROR` from {@link schemaCompileError},
   * which wraps `compile` for this same reason.
   */
  private tryAddSchema(schema: Record<string, any>, id: string): boolean {
    try {
      this.ajv.addSchema(schema, id);
      return true;
    } catch {
      return false;
    }
  }

  /** True when a schema is registered under `id` (a canonical `telo://` type id
   *  or a definition `$id`). Used to flag schema `$ref`s that resolve to nothing. */
  hasSchemaId(id: string): boolean {
    return this.registeredSchemaIds.has(id) || this.ajv.getSchema(id) !== undefined;
  }

  /** The schema registered under `id`, for a structural comparison that must see
   *  THROUGH a named shape. Declaring a shape once and referencing it is the
   *  sanctioned way to reuse one, so a comparator that cannot follow the
   *  reference judges two opaque nodes and learns nothing. */
  schemaForId(id: string): Record<string, any> | undefined {
    const compiled = this.ajv.getSchema(id);
    const schema = compiled?.schema;
    return schema && typeof schema === "object" ? (schema as Record<string, any>) : undefined;
  }

  /** Validates data against a schema using this registry's AJV instance, which has all
   *  registered definition schemas loaded — enabling cross-module $ref resolution.
   *  A compile failure returns `[]` here; it is surfaced loudly (once, on the
   *  owning definition) by `schemaCompileError` via the analyzer's
   *  definition-schema compile check, so resources are never silently skipped. */
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

  /** Returns the AJV compile error for `schema`, or `undefined` when it compiles.
   *  Compiles on this registry's instance, which has every loaded module schema
   *  plus the manifest root registered, so local `#/$defs`, `telo://manifest`,
   *  and cross-module `$ref`s all resolve. Used to fail loud on a definition
   *  schema that AJV cannot compile — otherwise `validateAgainstSchema` /
   *  `validateWithRefs` would swallow the failure and silently skip every
   *  resource of that kind. */
  schemaCompileError(schema: Record<string, any>): string | undefined {
    try {
      this.ajv.compile(schema);
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Registers a definition schema under the same module-scoped `telo://` id a
   *  named `Telo.Type` uses, so a kind schema and a type schema are addressable
   *  the same way and a `$ref` between them resolves at AJV compile time. One id
   *  space per module: a kind and a named type may not share a name, which
   *  `registerNamedTypeSchema` reports rather than resolving silently. */
  private tryRegisterSchema(
    moduleName: string,
    typeName: string,
    schema: Record<string, any>,
  ): void {
    const id = canonicalTypeSchemaId(moduleName, typeName);
    if (this.registeredSchemaIds.has(id)) {
      this.definitionSchemaIds.add(id);
      return;
    }
    if (this.ajv.getSchema(id)) {
      throw new Error(`Duplicate definition schema $id: "${id}" is already registered`);
    }
    // A schema AJV refuses is left unregistered rather than aborting the pass —
    // see {@link tryAddSchema}. The id stays claimed either way, so a later
    // named type cannot quietly take a kind's place.
    this.tryAddSchema(schema, id);
    this.registeredSchemaIds.add(id);
    this.definitionSchemaIds.add(id);
  }

  /** Resolves an `x-telo-ref` constraint to a canonical registry kind key.
   *
   *  The constraint is already canonical `<module>.<Kind>`: alias-form values
   *  (`KvStore.Store`, `Self.Store`, `Telo.Invocable`) are rewritten in the
   *  declaring module's scope by `resolveSchemaRefKinds` before registration, so
   *  no module context is needed here.
   *
   *  The legacy `<namespace>/<module>#<Kind>` form still resolves through the
   *  identity table for module versions published before the alias form existed:
   *
   *    "telo#Invocable"         → "Telo.Invocable"
   *    "std/http-server#Server" → "http-server.Server"
   *
   *  Returns undefined when a legacy string is malformed or its identity was
   *  never registered. */
  resolveRef(xTeloRef: string): string | undefined {
    const hash = xTeloRef.indexOf("#");
    if (hash === -1) return xTeloRef;
    if (hash === xTeloRef.length - 1) return undefined;
    const moduleName = this.identityMap.get(xTeloRef.slice(0, hash));
    if (!moduleName) return undefined;
    return `${moduleName}.${xTeloRef.slice(hash + 1)}`;
  }

  resolve(kind: string): ResourceDefinition | undefined {
    return this.defs.get(kind);
  }

  /** Returns the reference field map for the given kind, computed lazily from the
   *  kind's AUTHOR-FACING (inheritance-resolved) schema and memoized. Lazy so a
   *  child registered before its parent still sees the parent's inherited ref
   *  slots once both are present. */
  getFieldMap(kind: string): ReferenceFieldMap | undefined {
    const cached = this.fieldMaps.get(kind);
    if (cached) return cached;
    const def = this.defs.get(kind);
    if (!def) return undefined;
    const schema = effectiveAuthorSchema(def, (k) => this.resolve(k));
    const map = buildReferenceFieldMap(schema ?? {});
    this.fieldMaps.set(kind, map);
    return map;
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

  /** Returns the field map for `resource.kind` with x-telo-schema-from entries replaced
   *  by their nested ref/scope slots — so Phase 2 inline normalization and Phase 5
   *  injection see encoders nested behind a schema-from indirection (e.g.
   *  http-server `Server.notFoundHandler.returns[].content[mime].encoder`).
   *
   *  Only static absolute schema-from paths with a dotted alias anchor are expanded
   *  (e.g. "HttpDispatch.Outcomes/$defs/Returns"). Relative and unqualified absolute
   *  anchors depend on a sibling property at runtime and stay unexpanded; the
   *  analyzer's reference validation phase already flags the cases that matter. */
  expandedFieldMapForResource(
    resource: ResourceManifest,
    aliases: AliasResolver,
    aliasesByModule: Map<string, AliasResolver>,
  ): ReferenceFieldMap | undefined {
    // Resolve the resource's OWN kind through its module's alias scope, not the global
    // aliases. A library-internal resource's kind uses a library-local alias
    // (e.g. `Ai.AgentStream` in a library that imports `Ai`), which the root/global
    // resolver doesn't know — using the global scope here left the base field map
    // unresolved, so Phase-5 injection saw no ref fields and skipped injection.
    const ownModule = (resource.metadata as { module?: string } | undefined)?.module;
    const moduleScope =
      (ownModule ? aliasesByModule.get(ownModule) : undefined) ?? aliases;

    const baseMap = this.getFieldMapForKind(resource.kind, moduleScope);
    if (!baseMap) return undefined;

    const resolvedKind = moduleScope.resolveKind(resource.kind) ?? resource.kind;
    const def = this.resolve(resource.kind) ?? this.resolve(resolvedKind);
    // schema-from anchors resolve in the DEFINITION's module scope (where the anchor
    // kind is declared), which may differ from the resource's own module.
    const ownerModule = (def?.metadata as { module?: string } | undefined)?.module;
    const ownerScope =
      (ownerModule ? aliasesByModule.get(ownerModule) : undefined) ?? aliases;

    const expanded: ReferenceFieldMap = new Map();
    for (const [path, entry] of baseMap) {
      if (!isSchemaFromEntry(entry)) {
        expanded.set(path, entry);
        continue;
      }
      const sub = this.resolveSchemaFromSubMap(entry.schemaFrom, path, ownerScope);
      if (!sub) continue;
      for (const [subPath, subEntry] of sub) expanded.set(subPath, subEntry);
    }
    return expanded;
  }

  private resolveSchemaFromSubMap(
    schemaFrom: string,
    fieldPath: string,
    ownerScope: AliasResolver,
  ): ReferenceFieldMap | null {
    const isAbsolute = schemaFrom.startsWith("/");
    const expr = isAbsolute ? schemaFrom.slice(1) : schemaFrom;
    const slashIdx = expr.indexOf("/");
    if (slashIdx === -1) return null;
    const anchorName = expr.slice(0, slashIdx);
    const jsonPointer = "/" + expr.slice(slashIdx + 1);

    // Static form: absolute path whose anchor is a dotted alias (e.g.
    // "HttpDispatch.Outcomes/$defs/Returns"). Polymorphic forms — relative
    // anchors or single-segment absolute anchors — only resolve once we know a
    // sibling property's value, which is per-resource.
    if (!anchorName.includes(".")) return null;

    const targetKind = ownerScope.resolveKind(anchorName);
    if (!targetKind) return null;
    const targetDef = this.resolve(targetKind);
    if (!targetDef?.schema) return null;
    const subSchema = navigateJsonPointer(
      targetDef.schema as Record<string, unknown>,
      jsonPointer,
    );
    if (!subSchema || typeof subSchema !== "object") return null;

    return buildFieldMapAtPath(subSchema as Record<string, any>, fieldPath);
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
