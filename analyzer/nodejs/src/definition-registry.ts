import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { schemaWithTagsAsText } from "./schema-tag-text.js";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { KERNEL_BUILTINS } from "./builtins.js";
import { moduleAliasScope, type KindResolver } from "./module-alias-scope.js";
import {
  declaredReach,
  reachPositions,
  reachSites,
  type DeclaredReach,
  type ReachPosition,
  type ReachSite,
  type ResolvedSchemaNode,
  type SchemaFromResolver,
  type ShapeResolver,
} from "./reference-reach.js";
import { createAjv, navigateJsonPointer } from "./schema-compat.js";
import { SchemaNodeValidator } from "./schema-node-validator.js";
import { withoutStandInFindings, type StandIns } from "./stand-in-findings.js";
import {
  explainFormatErrors,
  formatSingleError,
  reduceSchemaErrors,
  schemaIssues,
  type AjvErrorLike,
  type SchemaIssue,
} from "./schema-error-report.js";
import { effectiveAuthorSchema } from "./extends-resolution.js";

/** Pure kind → ResourceDefinition map. No controller loading, no lifecycle. */
/** What `ajv.compile` hands back: a predicate carrying its own `errors`. */
type CompiledValidator = ((data: unknown) => boolean) & { errors?: any[] | null };

/** A kind's reach as one owner scope reads it: the inheritance-resolved schema,
 *  the resolver expanding its static `x-telo-schema-from` slots, and the
 *  declared view, built once. */
interface KindReach {
  schema: Record<string, any>;
  schemaFrom: SchemaFromResolver;
  shapes: ShapeResolver;
  declared?: DeclaredReach;
}

/** A resource's concrete sites as last enumerated, with what they were read over. */
interface CachedSites {
  reach: KindReach;
  data: unknown;
  sites: ReachSite[];
}

/** The canonical id of the named shape a non-local `$ref` names: the id itself
 *  once canonical, and the authored `telo://<authority>/<Type>` resolved in the
 *  module that wrote it. Undefined for anything else. */
function shapeId(
  ref: string,
  module: string | undefined,
  scope: KindResolver | undefined,
): string | undefined {
  if (parseCanonicalTypeSchemaId(ref)) return ref;
  const authored = parseTeloTypeRef(ref);
  if (!authored) return undefined;
  const owner = authored.authority === "Self" ? module : scope?.moduleForAlias?.(authored.authority);
  return owner === undefined ? undefined : canonicalTypeSchemaId(owner, authored.typeName);
}

/** The owner-scope key when no alias table is in play. */
const CANONICAL_SCOPE = {};

export class DefinitionRegistry {
  constructor() {
    // The built-ins are this package's own constants, meta-validated once by
    // their test rather than on every registry, where validating them was a
    // third of a registry's cost.
    for (const def of KERNEL_BUILTINS) this.add(def, true);
  }

  /** Per-instance AJV for cross-module $ref resolution. Isolated so each registry
   *  (and thus each AnalysisContext) has its own schema store — no stale schemas
   *  across analyze() calls and no unbounded growth across the process lifetime. */
  private readonly ajv = createAjv();
  private readonly registeredSchemaIds = new Set<string>();
  /** Every schema `ajv` holds by id, as registered — what {@link nodeValidator}'s
   *  instance is given, so a reference resolves there as it does here. */
  private readonly registeredSchemas: Array<{ schema: object; id: string }> = [];
  private nodes: { ajv: ReturnType<typeof createAjv>; validator: SchemaNodeValidator } | undefined;
  private readonly compiledValidators = new WeakMap<Record<string, any>, CompiledValidator>();
  /** The subset of `registeredSchemaIds` claimed by a kind's schema. Kinds and
   *  named `Telo.Type`s share one `telo://<module>/<Name>` id space, so this is
   *  what lets a colliding type name be reported instead of silently dropped. */
  private readonly definitionSchemaIds = new Set<string>();
  /** Each named `Telo.Type`'s schema as its resource holds it, by canonical id —
   *  the document the reference reach walks where a kind's schema `$ref`s it. */
  private readonly namedShapes = new Map<string, Record<string, any>>();

  private readonly defs = new Map<string, ResourceDefinition>();
  /** Reverse inheritance index: parent kind → direct child kinds. */
  private readonly extendedBy = new Map<string, string[]>();
  /** Memoized inheritance-resolved schemas. `null` records "resolved to
   *  nothing", so a kind with no schema is not re-walked on every resource. */
  private readonly effectiveSchemas = new Map<string, Record<string, unknown> | null>();
  /** Per kind key, per owner alias scope — cleared with `effectiveSchemas`. */
  private readonly kindReaches = new Map<string, WeakMap<object, KindReach>>();
  private readonly resourceSites = new WeakMap<object, CachedSites>();
  /** DEPRECATED module identity table: identity string → canonical module name
   *  ("std/pipeline" → "pipeline"). Serves only the legacy
   *  `<namespace>/<module>#<Kind>` form of `x-telo-ref`, kept resolvable for
   *  module versions published before constraints named their target by import
   *  alias. Fed by `metadata.namespace`, which nothing else reads. */
  private readonly identityMap = new Map<string, string>();

  register(definition: ResourceDefinition): void {
    this.add(definition, false);
  }

  /** `trustedSchema` skips meta-validating the schema — only for the built-ins,
   *  whose validity a test asserts once. */
  private add(definition: ResourceDefinition, trustedSchema: boolean): void {
    const { name, module: mod } = definition.metadata;
    const key = mod ? `${mod}.${name}` : name;
    this.defs.set(key, definition);
    // The AUTHOR-FACING (inheritance-resolved) schema depends on the parent —
    // possibly registered after this child — so it recomputes lazily against the
    // now-larger def set.
    this.effectiveSchemas.clear();
    this.kindReaches.clear();
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
      this.tryRegisterSchema(
        mod,
        name as string,
        definition.schema as Record<string, any>,
        trustedSchema,
      );
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
    // The registered document supersedes the one announced before the passes
    // that resolve what it holds.
    this.namedShapes.set(id, schema);
    this.kindReaches.clear();
    return true;
  }

  /**
   * Announces a named `Telo.Type`'s schema to the reference reach, ahead of its
   * registration: a kind whose schema `$ref`s the shape reaches the slots it
   * declares, and the passes that resolve and extract what a resource holds at
   * those slots run before a shape can be registered — registration takes the
   * schema with its own references already resolved, which those same passes
   * produce. A shape already registered, and a kind's own id, are left alone.
   */
  announceNamedShape(id: string, schema: Record<string, any>): void {
    if (this.definitionSchemaIds.has(id) || this.registeredSchemaIds.has(id)) return;
    this.namedShapes.set(id, schema);
    this.kindReaches.clear();
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
  private tryAddSchema(schema: Record<string, any>, id: string, trusted = false): boolean {
    const registered = schemaWithTagsAsText(schema) as object;
    try {
      // `trusted` skips meta-validation; only for the built-ins, whose validity
      // their own test asserts.
      this.ajv.addSchema(registered, id, undefined, !trusted);
    } catch {
      return false;
    }
    this.registeredSchemas.push({ schema: registered, id });
    this.nodes?.ajv.addSchema(registered, id, undefined, false);
    return true;
  }

  /**
   * Validates one node of a schema inside its own document, for the stand-in
   * judge. On an instance of its own: locating a finding's node needs verbose
   * errors, and verbose errors would change what every other failure reads as.
   * Created by the first failure that has a union to decide.
   */
  private nodeValidator(): SchemaNodeValidator {
    if (!this.nodes) {
      const ajv = createAjv({ verbose: true });
      for (const { schema, id } of this.registeredSchemas) ajv.addSchema(schema, id, undefined, false);
      const validator = new SchemaNodeValidator(ajv, {
        canonical: (schema) => schemaWithTagsAsText(schema) as object,
      });
      this.nodes = { ajv, validator };
    }
    return this.nodes.validator;
  }

  /** `errors` without what the stand-ins in `data` excuse. */
  private judged(
    errors: AjvErrorLike[] | null | undefined,
    data: unknown,
    schema: Record<string, any>,
    standIns: StandIns | undefined,
  ): AjvErrorLike[] | null | undefined {
    if (!standIns) return errors;
    return withoutStandInFindings(errors, {
      value: data,
      schema,
      standIns,
      validate: (node, value) => this.nodeValidator().findingsFor(schema)(node, value),
    });
  }

  /** True when a schema is registered under `id` (a canonical `telo://` type id
   *  or a definition `$id`). Used to flag schema `$ref`s that resolve to nothing. */
  hasSchemaId(id: string): boolean {
    return this.registeredSchemaIds.has(id) || this.ajv.getSchema(id) !== undefined;
  }

  /** The schema registered under `id`, for a structural comparison that must see
   *  THROUGH a named shape. Declaring a shape once and referencing it is the
   *  sanctioned way to reuse one, so a comparator that cannot follow the
   *  reference judges two opaque nodes and learns nothing.
   *
   *  A registered id is READ, never compiled: this is a structural lookup, and
   *  compiling a shape the registry holds but cannot compile throws out of
   *  whichever walk asked. That shape's compile failure is reported where the
   *  shape is validated, not here. */
  schemaForId(id: string): Record<string, any> | undefined {
    let entry = this.ajv.schemas[id] ?? this.ajv.refs[id];
    while (typeof entry === "string") entry = this.ajv.schemas[entry] ?? this.ajv.refs[entry];
    const schema = entry ? entry.schema : this.ajv.getSchema(id)?.schema;
    return schema && typeof schema === "object" ? (schema as Record<string, any>) : undefined;
  }

  /**
   * Validates a resource's configuration against its kind's schema, with the
   * offending field's path — what a `SCHEMA_VIOLATION` diagnostic is built from.
   *
   * On THIS registry's AJV, which is the point: it holds every registered
   * definition schema and every named `Telo.Type`, so a kind whose schema
   * references a shape declared elsewhere is checked rather than skipped. The
   * module-level instance this used to run on had none of them registered, so
   * such a schema failed to compile and the failure was swallowed — a resource
   * could be arbitrarily wrong and `telo check` reported nothing, while the
   * kernel (whose validator does resolve the reference) rejected it at boot.
   * Two AJVs answering one question is what made that possible; there is now
   * one, and it is the same one `schemaCompileError` reports through.
   */
  validateWithRefs(data: unknown, schema: Record<string, any>, standIns?: StandIns): string[] {
    const validate = this.compiledFor(schema);
    if (!validate || validate(data)) return [];
    const errors = this.judged(validate.errors, data, schema, standIns);
    return reduceSchemaErrors(explainFormatErrors(errors, data)).map(formatSingleError);
  }

  /** {@link validateWithRefs}, with the path each issue is anchored at. */
  validateResourceConfig(
    data: unknown,
    schema: Record<string, any>,
    standIns?: StandIns,
  ): SchemaIssue[] {
    const validate = this.compiledFor(schema);
    if (!validate || validate(data)) return [];
    return schemaIssues(this.judged(validate.errors, data, schema, standIns), data);
  }

  /** Memoized per schema OBJECT — the analyzer validates every resource of a
   *  kind against the same one, and this runs at keystroke time in an editor.
   *  A schema AJV refuses compiles to `undefined`; that is reported once,
   *  anchored on the owning definition, by `schemaCompileError`. */
  private compiledFor(schema: Record<string, any>): CompiledValidator | undefined {
    const cached = this.compiledValidators.get(schema);
    if (cached) return cached;
    try {
      const validate = this.ajv.compile(schemaWithTagsAsText(schema) as object);
      this.compiledValidators.set(schema, validate);
      return validate;
    } catch {
      return undefined;
    }
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
      this.ajv.compile(schemaWithTagsAsText(schema) as object);
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
    trusted: boolean,
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
    this.tryAddSchema(schema, id, trusted);
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

  /**
   * The kind's AUTHOR-FACING schema — its own merged with everything it
   * inherits along `extends` — memoized per kind.
   *
   * This is what every consumer reading a kind's schema to interpret an
   * INSTANCE must use, because that is the schema the instance was authored
   * against and the one the kernel stamps at definition registration. Reading
   * `resolve(kind).schema` instead sees only what the leaf declared, so an
   * annotation on a parent — a CEL context region, a step body, an error
   * context — is invisible on every child, silently and per consumer. Sharing
   * one memo is what keeps those consumers from drifting apart.
   *
   * Lazy so a child registered before its parent still sees the inherited
   * half once both are present.
   */
  effectiveSchema(kind: string): Record<string, unknown> | undefined {
    const cached = this.effectiveSchemas.get(kind);
    if (cached !== undefined) return cached ?? undefined;
    const def = this.defs.get(kind);
    if (!def) return undefined;
    const schema = effectiveAuthorSchema(def, (k) => this.resolve(k)) as
      | Record<string, unknown>
      | undefined;
    this.effectiveSchemas.set(kind, schema ?? null);
    return schema;
  }

  /** The effective schema for a definition, by the kind it is registered under.
   *  Falls back to the definition's own schema when it is not in this registry
   *  (a synthesized or not-yet-registered kind), which is the pre-inheritance
   *  behaviour and the safe direction: it types less, never wrongly. */
  effectiveSchemaOf(definition: ResourceDefinition | undefined): Record<string, unknown> | undefined {
    if (!definition) return undefined;
    const { name, module: mod } = definition.metadata;
    const resolved = this.effectiveSchema(mod ? `${mod}.${name}` : name);
    return resolved ?? (definition.schema as Record<string, unknown> | undefined);
  }

  /** The registry key a resource's kind resolves to — the kind as written
   *  first, then through `scope` (the declaring module's alias table). */
  private kindKeyOf(kind: string, scope: KindResolver | undefined): string | undefined {
    if (this.defs.has(kind)) return kind;
    const resolved = scope?.resolveKind(kind);
    return resolved && this.defs.has(resolved) ? resolved : undefined;
  }

  /**
   * Where a resource's kind reaches (`reference-reach.ts`): the kind's
   * inheritance-resolved schema, and the resolver that expands its static
   * `x-telo-schema-from` slots. The kind resolves in the alias scope of the
   * module that DECLARED the resource; an anchor in the scope of the module that
   * declared the definition writing it — the resource's kind first, then each
   * anchor definition for the anchors nested in its own schema. Without
   * `aliases`, a kind and an anchor are read as canonical. Memoized per kind and
   * owner scope, anchors per document.
   */
  private reachOf(
    resource: { kind: string; metadata?: { module?: unknown } },
    aliases?: KindResolver,
    aliasesByModule?: ReadonlyMap<string, KindResolver>,
  ): KindReach | undefined {
    const moduleScope = aliases
      ? moduleAliasScope(resource.metadata, aliases, aliasesByModule)
      : undefined;
    const key = this.kindKeyOf(String(resource.kind), moduleScope);
    if (!key) return undefined;
    const def = this.defs.get(key)!;
    const ownerScope = aliases ? moduleAliasScope(def.metadata, aliases, aliasesByModule) : undefined;
    let byScope = this.kindReaches.get(key);
    if (!byScope) this.kindReaches.set(key, (byScope = new WeakMap()));
    const cached = byScope.get(ownerScope ?? CANONICAL_SCOPE);
    if (cached) return cached;

    const schema = (this.effectiveSchema(key) ?? {}) as Record<string, any>;
    const scopes = new WeakMap<object, KindResolver | undefined>([[schema, ownerScope]]);
    // The module each document was declared in — what `telo://Self/<Type>`
    // written there names.
    const modules = new WeakMap<object, string | undefined>([
      [schema, (def.metadata as { module?: string }).module],
    ]);
    const shapes: ShapeResolver = (ref, document) => {
      const id = shapeId(ref, modules.get(document), scopes.get(document));
      const shape = id === undefined ? undefined : this.namedShapes.get(id);
      if (shape && !modules.has(shape)) {
        const module = parseCanonicalTypeSchemaId(id)!.moduleName;
        modules.set(shape, module);
        scopes.set(
          shape,
          aliases ? moduleAliasScope({ module }, aliases, aliasesByModule) : undefined,
        );
      }
      return shape;
    };
    const anchors = new WeakMap<object, Map<string, ResolvedSchemaNode | null>>();
    const schemaFrom: SchemaFromResolver = (expression, document) => {
      let byExpression = anchors.get(document);
      if (!byExpression) anchors.set(document, (byExpression = new Map()));
      const known = byExpression.get(expression);
      if (known !== undefined) return known ?? undefined;
      const anchor = this.resolveSchemaFromAnchor(expression, scopes.get(document));
      byExpression.set(expression, anchor ? { document: anchor.document, node: anchor.node } : null);
      if (!anchor) return undefined;
      if (!scopes.has(anchor.document)) {
        modules.set(anchor.document, (anchor.definition.metadata as { module?: string }).module);
        scopes.set(
          anchor.document,
          aliases ? moduleAliasScope(anchor.definition.metadata, aliases, aliasesByModule) : undefined,
        );
      }
      return { document: anchor.document, node: anchor.node };
    };
    const reach: KindReach = { schema, schemaFrom, shapes };
    byScope.set(ownerScope ?? CANONICAL_SCOPE, reach);
    return reach;
  }

  /**
   * Every concrete reference, step, scope and schema-from site of `data` (the
   * resource itself by default), schema-from slots expanded — the one
   * enumeration Phase-5 injection, scope creation and every analyzer pass read.
   * Empty when the kind resolves to no definition.
   *
   * Memoized per resource object. A cached list stands while every site still
   * holds the value it was enumerated over: the passes that rewrite a manifest
   * (inline extraction, `!ref` resolution, Phase-5 substitution, scope handles)
   * each replace the value at a site, which is what invalidates it.
   */
  referenceSites(
    resource: ResourceManifest,
    aliases?: KindResolver,
    aliasesByModule?: ReadonlyMap<string, KindResolver>,
    data: unknown = resource,
  ): ReachSite[] {
    const reach = this.reachOf(resource, aliases, aliasesByModule);
    if (!reach) return [];
    const cached = this.resourceSites.get(resource);
    if (
      cached &&
      cached.reach === reach &&
      cached.data === data &&
      cached.sites.every(
        (site) =>
          site.holder === undefined ||
          (site.holder as Record<string | number, unknown>)[site.key!] === site.data,
      )
    ) {
      return cached.sites;
    }
    const sites = reachSites(reach.schema, data, reach.schemaFrom, true, reach.shapes);
    this.resourceSites.set(resource, { reach, data, sites });
    return sites;
  }

  /** Every concrete position of `data` at or above one of its reference slots
   *  (`reachPositions`), schema-from slots expanded. Empty when the kind
   *  resolves to no definition. */
  referencePositions(
    resource: ResourceManifest,
    aliases?: KindResolver,
    aliasesByModule?: ReadonlyMap<string, KindResolver>,
    data: unknown = resource,
  ): ReachPosition[] {
    const reach = this.reachOf(resource, aliases, aliasesByModule);
    return reach ? reachPositions(reach.schema, data, reach.schemaFrom, reach.shapes) : [];
  }

  /** The patterns a resource's kind declares, schema-from slots expanded, or
   *  undefined when the kind resolves to no definition. */
  declaredReachOf(
    resource: { kind: string; metadata?: { module?: unknown } },
    aliases?: KindResolver,
    aliasesByModule?: ReadonlyMap<string, KindResolver>,
  ): DeclaredReach | undefined {
    const reach = this.reachOf(resource, aliases, aliasesByModule);
    if (!reach) return undefined;
    return (reach.declared ??= declaredReach(reach.schema, reach.schemaFrom, reach.shapes));
  }

  /**
   * The schema an `x-telo-schema-from` slot derives its shape from.
   *
   * Only the STATIC form resolves: an anchor that is a dotted alias-qualified
   * kind (`HttpDispatch.Request/$defs/Matcher`). The polymorphic forms — a
   * relative anchor, or a single-segment absolute one — name a sibling property
   * whose value is known per resource, so a definition-level lookup would be
   * guessing at one instance's shape.
   *
   * Its own method because a schema-from slot is otherwise INVISIBLE to anything
   * reading `properties`: the reach needs the nested ref slots, and an IDE
   * needs the very same node to offer a key or describe one. Two resolutions of
   * one annotation would eventually disagree about which anchors are static.
   */
  resolveSchemaFromNode(
    schemaFrom: string,
    ownerScope: AliasResolver,
  ): Record<string, any> | undefined {
    return this.resolveSchemaFromAnchor(schemaFrom, ownerScope)?.node;
  }

  /** {@link resolveSchemaFromNode}, with the anchor definition and its whole
   *  schema — the document the anchor's own local `$ref`s resolve against. */
  private resolveSchemaFromAnchor(
    schemaFrom: string,
    ownerScope: KindResolver | undefined,
  ):
    | { node: Record<string, any>; document: Record<string, any>; definition: ResourceDefinition }
    | undefined {
    const isAbsolute = schemaFrom.startsWith("/");
    const expr = isAbsolute ? schemaFrom.slice(1) : schemaFrom;
    const slashIdx = expr.indexOf("/");
    if (slashIdx === -1) return undefined;
    const anchorName = expr.slice(0, slashIdx);
    const jsonPointer = "/" + expr.slice(slashIdx + 1);

    if (!anchorName.includes(".")) return undefined;

    const targetKind = ownerScope ? ownerScope.resolveKind(anchorName) : anchorName;
    if (!targetKind) return undefined;
    const targetDef = this.resolve(targetKind);
    if (!targetDef?.schema) return undefined;
    const document = targetDef.schema as Record<string, any>;
    const subSchema = navigateJsonPointer(document, jsonPointer);
    if (!subSchema || typeof subSchema !== "object") return undefined;
    return { node: subSchema as Record<string, any>, document, definition: targetDef };
  }

  /** The kinds a definition descends from DIRECTLY — the same two edges
   *  `register` feeds into `extendedBy`, read the other way.
   *
   *  Both spellings, because either can carry the edge that satisfies a slot:
   *  `capability:` is the legacy implements-this form, `extends:` the canonical
   *  one. A consumer walking these by hand would be a second reading of what an
   *  inheritance edge IS, and the downward index and the upward walk have to
   *  agree about that forever. */
  parentsOf(kind: string): string[] {
    const def = this.defs.get(kind);
    if (!def) return [];
    return [def.capability, def.extends].filter(
      (parent): parent is string => typeof parent === "string" && parent.length > 0,
    );
  }

  /** Whether every kind this one descends from is registered.
   *
   *  When it is, what the kind implements is FULLY KNOWN: a target it does not
   *  reach is one it genuinely does not implement, so a mismatch is a verdict.
   *  When a hop is missing — an unimported abstract, an alias the declaring file
   *  could not resolve — a mismatch cannot be told from a missing dependency,
   *  which is the partial context every reference check stays lenient in. */
  ancestryResolved(kind: string): boolean {
    const queue = [kind];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (!this.defs.has(current)) return false;
      queue.push(...this.parentsOf(current));
    }
    return true;
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
