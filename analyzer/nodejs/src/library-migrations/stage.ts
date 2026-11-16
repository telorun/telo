/**
 * The library migration stage: every library's `migrations:` applied to the
 * loaded graph, once the closure has loaded and its definitions are registered,
 * before flatten and every analysis pass.
 *
 * Candidates are found by the value/schema co-walk (`value-schema-walk.ts`) over
 * each declaration the analyzer reads — top-level documents, inline declarations
 * at reference slots, `with:` members, template-body entries and inline
 * `targets:` items of kind documents, and the branches of `!if` / `!switch` /
 * `!for-each` at each position's own schema — each kind read in the alias scope
 * of the module declaring the document. A named shape is a candidate where a
 * current schema types a position by it; inside a value of a library's own type,
 * a position no schema types is a legacy position, where a map whose `kind:`
 * names the library's own type is a declaration of it.
 *
 * Each candidate is brought to a fixpoint bottom-up (`Chained migrations`), its
 * converged result validated against its type's current schema, and the result
 * recorded per module source as an edit record (`edit-record.ts`) and applied to
 * the graph's own copies of the trees — never to the loader's cached files.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { canonicalTypeSchemaId, parseCanonicalTypeSchemaId, parseTeloTypeRef } from "@telorun/sdk";
import { expansionBody, expansionTagOf, isExpansionSentinel } from "@telorun/templating";
import type { DefinitionRegistry } from "../definition-registry.js";
import { isKindDocument } from "../kind-declaration.js";
import { filesOf, importTarget, kindDocumentIn, moduleNameOf } from "../loaded-kind-scope.js";
import type { LoadedFile, LoadedGraph, LoadedModule } from "../loaded-types.js";
import { isModuleKind } from "../module-kinds.js";
import { reachedModuleSources } from "../module-origin.js";
import { templateBodyEntries } from "../template-body.js";
import { refSentinelTarget } from "../ref-sentinel-target.js";
import { inheritedCapability } from "../extends-resolution.js";
import { resolveModuleReferences, type ResolvedModuleReference } from "./reference-resolution.js";
import { foldTypeExtends } from "../validate-cel-context.js";
import { renderValuePath, schemaReachGate, walkValueSchema, type ValuePath } from "../value-schema-walk.js";
import {
  handOverRules,
  migrationPointerSegments,
  readLibraryMigrations,
  removedKindNames,
  rootKindWritten,
  selfTypeName,
  type LibraryMigration,
  type MigrationBinding,
  type MigrationRule,
  type MigrationSeverity,
} from "./declaration.js";
import {
  encodeMigratedNode,
  migrationTextDigest,
  migrationTreeIndex,
  applyLibraryMigrationRecord,
  type MigrationRecordEntry,
  type MigrationTreePointer,
  type ModuleMigrationRecord,
} from "./edit-record.js";
import { isMigrationMap, isOpaqueMigrationValue, migrationMatchHolds } from "./match.js";
import { applyMigrationRule, cloneMigrationTree, type BindingReading, type KindSpelling } from "./rule-application.js";

/** A library whose module doc declares migrations. */
interface MigratingLibrary {
  readonly name: string;
  readonly source: string;
  /** The library's source as its importers requested it. */
  readonly requested: string;
  /** Its migrations, by code. */
  readonly migrations: readonly LibraryMigration[];
}

/** What the stage found at one node of a module's trees. */
export interface LibraryMigrationFinding {
  readonly at: MigrationTreePointer;
  /** The migration's code, or `MIGRATION_FAILED`. */
  readonly code: string;
  readonly severity: MigrationSeverity | "error";
  readonly message: string;
  /** The module declaring the migration. */
  readonly library: { readonly module: string; readonly source: string };
  /** The owner source of the module whose file holds the node. */
  readonly modulePath: string;
  /** For `MIGRATION_FAILED`: the code of the migration that failed (the first by
   *  code order when several are named). */
  readonly migration?: string;
  /** For `MIGRATION_FAILED`: every migration code the failure names. */
  readonly migrations?: readonly string[];
  /** For `MIGRATION_FAILED`: the bare cause, without the message's prefix. */
  readonly cause?: string;
}

/** The stage's result, carried by the graph it ran over and by every graph
 *  re-rooted from it. */
export interface LibraryMigrationOutcome {
  /** One record per module source the stage rewrote, by owner source. */
  readonly records: ReadonlyMap<string, ModuleMigrationRecord>;
  readonly findings: readonly LibraryMigrationFinding[];
  /** Each copied file's documents as they were before the stage. */
  readonly originals: ReadonlyMap<string, readonly unknown[]>;
  /** Every rewritten anchor. */
  readonly rewritten: readonly MigrationTreePointer[];
  /** Every node left as written because its migration failed. */
  readonly failed: readonly MigrationTreePointer[];
  /** Every hand-over that held, as the group write-back writes whole or not at all. */
  readonly handOvers: readonly LibraryHandOver[];
}

/** A referent whose hand-over fired, with every node that takes over what it drops. */
export interface LibraryHandOver {
  /** The owner source of the module holding the group. */
  readonly modulePath: string;
  /** The migration's code. */
  readonly migration: string;
  /** The module declaring the migration. */
  readonly library: string;
  /** The referent's node. */
  readonly referent: MigrationTreePointer;
  /** The referent as a person reads it: `` `me` `` or the inline declaration's place. */
  readonly label: string;
  /** Every reference position of the group. */
  readonly members: readonly MigrationTreePointer[];
}

/** The libraries of `graph` that declare migrations. */
function migratingLibraries(graph: LoadedGraph): Map<string, MigratingLibrary> {
  const out = new Map<string, MigratingLibrary>();
  for (const mod of graph.modules.values()) {
    const doc = mod.owner.manifests.find((m) => m && isModuleKind(m.kind));
    const migrations = readLibraryMigrations(doc);
    const name = moduleNameOf(mod);
    if (!name || migrations.length === 0) continue;
    out.set(name, {
      name,
      source: mod.owner.source,
      requested: mod.owner.requestedUrl,
      migrations: [...migrations].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    });
  }
  return out;
}

/** The pending stage of a graph whose closure declares migrations: the libraries,
 *  and the graph's own copies of every module reaching one. */
export interface PendingLibraryMigrations {
  readonly libraries: ReadonlyMap<string, MigratingLibrary>;
  readonly originals: ReadonlyMap<string, readonly unknown[]>;
}

/**
 * When `graph`'s closure declares migrations, replaces every module whose
 * closure reaches such a library by a copy owned by the graph (its documents'
 * plain containers new) and returns what the stage needs; otherwise nothing.
 * Run before registration, so the registered plane shares the copies' trees.
 */
export function takeLibraryMigrationCopies(graph: LoadedGraph): PendingLibraryMigrations | undefined {
  if (graph.libraryMigrations) return undefined;
  const libraries = migratingLibraries(graph);
  if (libraries.size === 0) return undefined;
  const librarySources = new Set([...libraries.values()].map((l) => l.source));
  const originals = new Map<string, readonly unknown[]>();
  const copyFile = (file: LoadedFile): LoadedFile => {
    originals.set(file.source, file.manifests);
    return { ...file, manifests: file.manifests.map((m) => cloneMigrationTree(m) as ResourceManifest | null) };
  };
  for (const [source, mod] of [...graph.modules]) {
    const reached = reachedModuleSources(graph, source);
    if (![...librarySources].some((library) => reached.has(library))) continue;
    const copy: LoadedModule = { owner: copyFile(mod.owner), partials: mod.partials.map(copyFile) };
    graph.modules.set(source, copy);
    if (graph.entry === mod) graph.entry = copy;
  }
  return { libraries, originals };
}

const SEVERITY_ORDER = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const pathKey = (path: ValuePath) => JSON.stringify(path);
const startsWithPath = (path: ValuePath, prefix: ValuePath) =>
  prefix.length <= path.length && prefix.every((segment, i) => path[i] === segment);

/** The value at `path`, read through plain containers and expansion branches. */
function valueAt(value: unknown, path: ValuePath): unknown {
  let at = value;
  for (const segment of path) {
    if (at === null || typeof at !== "object") return undefined;
    if (!Array.isArray(at) && isOpaqueMigrationValue(at) && !isExpansionSentinel(at)) return undefined;
    at = (at as Record<string | number, unknown>)[segment];
  }
  return at;
}

/** `value` with `replacement` at `path`; containers on the path new. */
function replacedAt(value: unknown, path: ValuePath, replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = replacedAt(copy[head as number], rest, replacement);
    return copy;
  }
  const map = value as Record<string, unknown>;
  return { ...map, [head]: replacedAt(map[head], rest, replacement) };
}

/** The branch bodies an expansion construct stands for at its position. */
function branchesOf(value: unknown, path: ValuePath): { value: unknown; path: ValuePath }[] {
  if (!isExpansionSentinel(value)) return [];
  const body = expansionBody(value);
  const tag = expansionTagOf(value);
  const out: { value: unknown; path: ValuePath }[] = [];
  const at = (key: string) => {
    if (body[key] !== undefined) out.push({ value: body[key], path: [...path, key] });
  };
  if (tag === "if") {
    at("then");
    at("else");
  } else if (tag === "switch") {
    if (isMigrationMap(body.cases)) {
      for (const [key, branch] of Object.entries(body.cases)) out.push({ value: branch, path: [...path, "cases", key] });
    }
    at("default");
  } else {
    at("emit");
  }
  return out;
}

/** A value whose standing values are its branches, recursively. */
function standingValues(value: unknown, path: ValuePath): { value: unknown; path: ValuePath }[] {
  if (!isExpansionSentinel(value)) return [{ value, path }];
  return branchesOf(value, path).flatMap((b) => standingValues(b.value, b.path));
}

interface TypeTarget {
  readonly library: MigratingLibrary;
  readonly type: string;
}

interface Candidate extends TypeTarget {
  readonly path: ValuePath;
  /** A declaration of a kind, rather than a value of a named shape. */
  readonly declaration: boolean;
}

/** Why a node could not be migrated. */
class NodeFailure {
  constructor(
    readonly library: MigratingLibrary,
    readonly code: string,
    readonly cause: string,
  ) {}
}

/** One module's walk: its candidates, and their fixpoints. */
class ModuleStage {
  private readonly ownShapes = new Map<string, TypeTarget>();
  private readonly schemaCache = new Map<string, Record<string, any> | null>();

  constructor(
    private readonly graph: LoadedGraph,
    private readonly mod: LoadedModule,
    private readonly libraries: ReadonlyMap<string, MigratingLibrary>,
    readonly defs: DefinitionRegistry,
  ) {}

  private moduleReferences: readonly ResolvedModuleReference[] | undefined;
  private referenceIndex: Map<string, ResolvedModuleReference> | undefined;

  /** Every `!ref` of the module resolved by position, once: the trees are not
   *  mutated until the module's record is applied. */
  references(): readonly ResolvedModuleReference[] {
    return (this.moduleReferences ??= resolveModuleReferences(this.mod, this));
  }

  /** What the `!ref` at `path` of a document resolves to, found at that very
   *  position or, when a rule moved it, as the same name under `within`. */
  referenceAt(
    file: string,
    document: number,
    path: ValuePath,
    within: ValuePath,
    name: string,
  ): ResolvedModuleReference | undefined {
    if (!this.referenceIndex) {
      this.referenceIndex = new Map(this.references().map((r) => [positionKey(r.file.source, r.document, r.path), r]));
    }
    const exact = this.referenceIndex.get(positionKey(file, document, path));
    if (exact) return exact;
    return this.references().find(
      (r) => r.file.source === file && r.document === document && r.name === name && startsWithPath(r.path, within),
    );
  }

  /** The named-shape lookup the reach reads, so it sees what analysis sees. */
  readonly shapeLookup = (id: string): Record<string, any> | undefined => this.namedShape(id);

  private readonly resolveRef = (ref: string) => {
    const schema = this.namedShape(ref) ?? this.defs.schemaForId(ref);
    return schema ? { schema, root: schema } : undefined;
  };

  private readonly shapes = new Map<string, Record<string, any> | null>();
  private readonly contained = new WeakMap<object, Record<string, any>>();

  /**
   * The named shape `id` (`telo:<module>/<Name>`) names, read off the graph —
   * the stage runs before analysis registers named shapes — with every
   * `telo://<Alias|Self>/<Name>` reference in it made canonical through the
   * declaring module's imports.
   */
  namedShape(id: string): Record<string, any> | undefined {
    if (this.shapes.has(id)) return this.shapes.get(id) ?? undefined;
    this.shapes.set(id, null);
    const parsed = parseCanonicalTypeSchemaId(id);
    const mod = parsed ? [...this.graph.modules.values()].find((m) => moduleNameOf(m) === parsed.moduleName) : undefined;
    const doc = mod
      ? filesOf(mod)
          .flatMap((f) => f.manifests)
          .find((m) => m?.metadata?.name === parsed!.typeName && this.declaresShape(m, mod))
      : undefined;
    const schema = (doc as { schema?: unknown } | undefined)?.schema;
    if (!mod || !schema || typeof schema !== "object") return undefined;
    const canonical = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(canonical);
      if (!node || typeof node !== "object") return node;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const ref = key === "$ref" ? parseTeloTypeRef(child) : null;
        if (ref) {
          const own = ref.authority === "Self" || ref.authority === moduleNameOf(mod);
          const target = own ? mod : importTarget(this.graph, mod, ref.authority);
          const name = target ? moduleNameOf(target) : undefined;
          out[key] = name ? canonicalTypeSchemaId(name, ref.typeName) : child;
        } else out[key] = canonical(child);
      }
      return out;
    };
    const parentId = (parent: unknown): string | undefined => {
      const ref = refSentinelTarget(parent);
      const written = ref ? (ref.alias ? `${ref.alias}.${ref.name}` : ref.name) : parent;
      if (typeof written !== "string") return undefined;
      const typeRef = parseTeloTypeRef(written);
      const dot = written.lastIndexOf(".");
      const alias = typeRef ? typeRef.authority : dot > 0 ? written.slice(0, dot) : undefined;
      const name = typeRef ? typeRef.typeName : dot > 0 ? written.slice(dot + 1) : written;
      const own = alias === undefined || alias === "Self" || alias === moduleNameOf(mod);
      const target = own ? mod : importTarget(this.graph, mod, alias!);
      const moduleName = target ? moduleNameOf(target) : undefined;
      return moduleName ? canonicalTypeSchemaId(moduleName, name) : undefined;
    };
    const read = foldTypeExtends(canonical(schema) as Record<string, any>, (doc as { extends?: unknown }).extends, (parent) => {
      const parent_ = parentId(parent);
      return parent_ ? this.namedShape(parent_) : undefined;
    });
    this.shapes.set(id, read);
    return read;
  }

  /** `schema` with every named shape it reaches inlined under `$defs`, so it
   *  compiles before analysis registers the shapes. */
  selfContained(schema: Record<string, any>): Record<string, any> {
    const known = this.contained.get(schema);
    if (known) return known;
    const defs: Record<string, unknown> = {};
    const keys = new Map<string, string>();
    // A shape's own `#…` references are rebased to where it is inlined.
    const inline = (node: unknown, base: string): unknown => {
      if (Array.isArray(node)) return node.map((item) => inline(item, base));
      if (!node || typeof node !== "object") return node;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const shape = key === "$ref" && typeof child === "string" ? this.namedShape(child) : undefined;
        if (shape) {
          let local = keys.get(child as string);
          if (!local) {
            local = `__libraryMigrationShape${keys.size}`;
            keys.set(child as string, local);
            defs[local] = inline(shape, `/$defs/${local}`);
          }
          out[key] = `#/$defs/${local}`;
        } else if (key === "$ref" && typeof child === "string" && child.startsWith("#") && base !== "") {
          out[key] = `#${base}${child.slice(1)}`;
        } else out[key] = inline(child, base);
      }
      return out;
    };
    const body = inline(schema, "") as Record<string, any>;
    const out = keys.size === 0 ? schema : { ...body, $defs: { ...(body.$defs ?? {}), ...defs } };
    this.contained.set(schema, out);
    return out;
  }

  private readonly gate = schemaReachGate(
    (node) =>
      typeof node.$ref === "string" && this.shapeTarget(node.$ref)
        ? true
        : node["x-telo-ref"] !== undefined || node["x-telo-scope"] !== undefined
          ? true
          : undefined,
    "follow",
  );

  private readonly removed = new Map<MigratingLibrary, Set<string>>();

  /** Whether `library` declares the type `name`: a kind or a named shape. */
  declares(library: MigratingLibrary, name: string): boolean {
    return (
      this.defs.resolve(`${library.name}.${name}`) !== undefined ||
      this.namedShape(canonicalTypeSchemaId(library.name, name)) !== undefined
    );
  }

  /** The types `library`'s rules rewrite as removed kinds. */
  removedKinds(library: MigratingLibrary): ReadonlySet<string> {
    let out = this.removed.get(library);
    if (!out) this.removed.set(library, (out = removedKindNames(library.migrations, (name) => this.declares(library, name))));
    return out;
  }

  /** The migrations whose rules a node of `target` is a candidate of: none for
   *  a type the library neither declares nor rewrites as a removed kind. */
  ruleTargets(target: TypeTarget): readonly LibraryMigration[] {
    return this.declares(target.library, target.type) || this.removedKinds(target.library).has(target.type)
      ? target.library.migrations
      : [];
  }

  /** The library type a named shape id names, when its module migrates. */
  shapeTarget(id: string): TypeTarget | undefined {
    if (this.ownShapes.has(id)) return this.ownShapes.get(id);
    const parsed = parseCanonicalTypeSchemaId(id);
    const library = parsed ? this.libraries.get(parsed.moduleName) : undefined;
    const target = library && parsed ? { library, type: parsed.typeName } : undefined;
    if (target) this.ownShapes.set(id, target);
    return target;
  }

  /** Whether `doc` of `mod` declares a named shape: its kind's capability, own or
   *  inherited, is `Telo.Type`, as analysis reads it. */
  private declaresShape(doc: ResourceManifest, mod: LoadedModule): boolean {
    if (typeof doc.kind !== "string") return false;
    if (doc.kind === "Telo.JsonSchema") return true;
    const identity = this.kindIdentity(doc.kind, mod);
    const definition = identity ? this.defs.resolve(`${identity.moduleName}.${identity.name}`) : undefined;
    return inheritedCapability(definition, (k) => this.defs.resolve(k)) === "Telo.Type";
  }

  /** The canonical identity of a kind as written in `mod` (this module by default). */
  kindIdentity(written: string, mod: LoadedModule = this.mod): { moduleName: string; name: string } | undefined {
    if (written.startsWith("Telo.")) return { moduleName: "Telo", name: written.slice("Telo.".length) };
    const found = kindDocumentIn(this.graph, mod, written);
    if (found && typeof found.doc.metadata?.name === "string") {
      return { moduleName: found.moduleName, name: found.doc.metadata.name };
    }
    const dot = written.indexOf(".");
    if (dot <= 0) return undefined;
    const prefix = written.slice(0, dot);
    const own = prefix === "Self" || prefix === moduleNameOf(mod);
    const target = own ? mod : importTarget(this.graph, mod, prefix);
    const moduleName = target ? moduleNameOf(target) : undefined;
    return moduleName ? { moduleName, name: written.slice(dot + 1) } : undefined;
  }

  /** A type's current schema: a kind's effective schema, or a named shape's. */
  schemaOf(target: { moduleName: string; name: string }): Record<string, any> | undefined {
    const key = `${target.moduleName}.${target.name}`;
    if (!this.schemaCache.has(key)) {
      const definition = this.defs.resolve(key);
      const schema = definition
        ? (this.defs.effectiveSchemaOf(definition) as Record<string, any> | undefined)
        : this.namedShape(canonicalTypeSchemaId(target.moduleName, target.name));
      this.schemaCache.set(key, schema ?? null);
    }
    return this.schemaCache.get(key) ?? undefined;
  }

  /** Every candidate in `value`, a declaration at `path`. */
  declarationCandidates(value: unknown, path: ValuePath): Candidate[] {
    const found = new Map<string, Candidate>();
    this.declaration(value, path, found);
    return [...found.values()];
  }

  /** Every candidate in `value`, a value of `target`'s type at `path`, itself
   *  excluded. */
  innerCandidates(value: unknown, target: TypeTarget, declaration: boolean): Candidate[] {
    const found = new Map<string, Candidate>();
    if (declaration) this.declaration(value, [], found);
    else {
      const schema = this.schemaOf({ moduleName: target.library.name, name: target.type });
      if (schema) this.walk(value, schema, [], found, [{ path: [], library: target.library }]);
      else this.legacyBody(value, [], target.library, found);
    }
    found.delete(pathKey([]));
    return [...found.values()];
  }

  private add(found: Map<string, Candidate>, candidate: Candidate): void {
    const key = pathKey(candidate.path);
    if (!found.has(key)) found.set(key, candidate);
  }

  private declaration(value: unknown, path: ValuePath, found: Map<string, Candidate>, owned: { path: ValuePath; library: MigratingLibrary }[] = []): void {
    for (const standing of standingValues(value, path)) {
      const decl = standing.value;
      if (!isMigrationMap(decl) || typeof decl.kind !== "string") continue;
      const identity = this.kindIdentity(decl.kind);
      if (!identity) continue;
      const library = this.libraries.get(identity.moduleName);
      const own = library ? [...owned, { path: standing.path, library }] : [];
      if (library) this.add(found, { library, type: identity.name, path: standing.path, declaration: true });
      const schema = this.schemaOf(identity);
      if (schema) this.walk(decl, schema, standing.path, found, own);
      else if (library) this.legacyBody(decl, standing.path, library, found);
    }
  }

  /** The body of an own kind no longer declared: every position is legacy. */
  private legacyBody(value: unknown, path: ValuePath, library: MigratingLibrary, found: Map<string, Candidate>): void {
    if (!isMigrationMap(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 0 || (key !== "kind" && key !== "metadata")) this.legacy(child, [...path, key], library, found);
    }
  }

  /** A legacy position: a map naming an own kind is a declaration of it; a
   *  foreign one is carried as written. */
  private legacy(value: unknown, path: ValuePath, library: MigratingLibrary, found: Map<string, Candidate>): void {
    for (const standing of standingValues(value, path)) {
      const at = standing.value;
      if (Array.isArray(at)) {
        at.forEach((item, i) => this.legacy(item, [...standing.path, i], library, found));
        continue;
      }
      if (!isMigrationMap(at)) continue;
      if (typeof at.kind === "string") {
        if (this.kindIdentity(at.kind)?.moduleName === library.name) this.declaration(at, standing.path, found);
        continue;
      }
      for (const [key, child] of Object.entries(at)) this.legacy(child, [...standing.path, key], library, found);
    }
  }

  private walk(
    data: unknown,
    schema: Record<string, any>,
    prefix: ValuePath,
    found: Map<string, Candidate>,
    owned: { path: ValuePath; library: MigratingLibrary }[],
  ): void {
    const own = [...owned];
    const nested: { value: unknown; path: ValuePath }[] = [];
    walkValueSchema(schema, data, {
      resolveRef: this.resolveRef,
      ...(owned.length === 0 ? { reaches: (s: Record<string, any>, root: Record<string, any>) => this.gate(s, root, this.resolveRef) } : {}),
      standing: (value, path) => {
        if (isExpansionSentinel(value)) return branchesOf(value, path);
        return isOpaqueMigrationValue(value) ? [] : undefined;
      },
      visit: (visit) => {
        const path = [...prefix, ...visit.path];
        const ref = visit.node.$ref;
        const target = typeof ref === "string" ? this.shapeTarget(ref) : undefined;
        if (target && !visit.boundary) {
          own.push({ path, library: target.library });
          this.add(found, { ...target, path, declaration: false });
        }
        if (visit.node["x-telo-scope"] !== undefined && Array.isArray(visit.value)) {
          visit.value.forEach((member, i) => nested.push({ value: member, path: [...path, i] }));
          return "stop";
        }
        return undefined;
      },
      referenceSlot: (visit) => {
        if (!visit.boundary) nested.push({ value: visit.value, path: [...prefix, ...visit.path] });
      },
      residualKeys: ({ value, path, keys }) => {
        const full = [...prefix, ...path];
        const owner = own
          .filter((o) => startsWithPath(full, o.path))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!owner) return;
        for (const key of keys) {
          if (value[key] === undefined) continue;
          this.legacy(value[key], [...full, key], owner.library, found);
        }
      },
    });
    const seen = new Set<string>();
    for (const entry of nested) {
      const key = pathKey(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      this.declaration(entry.value, entry.path, found, own);
    }
  }

  /** The kind a `set:` writes, spelled through this module's alias for the
   *  library. */
  spellKind(library: MigratingLibrary, written: string, fileSource: string): KindSpelling {
    const dot = written.indexOf(".");
    if (dot <= 0) return { kind: written };
    const prefix = written.slice(0, dot);
    const name = written.slice(dot + 1);
    const libraryModule = [...this.graph.modules.values()].find((m) => m.owner.source === library.source);
    const reExports = prefix !== "Self" && libraryModule !== undefined && importTarget(this.graph, libraryModule, prefix) !== undefined;
    if (prefix !== "Self" && !reExports) return { kind: written };
    if (moduleNameOf(this.mod) === library.name) return { kind: `Self.${name}` };
    for (const file of filesOf(this.mod)) {
      for (const [alias, edge] of this.graph.importEdges.get(file.source) ?? []) {
        if (edge.targetModuleName === library.name) return { kind: `${alias}.${name}` };
      }
    }
    return {
      failure:
        `it writes the kind ${library.name}.${name}, and ${fileLabel(fileSource)} has no import of ${library.name} to spell it with. ` +
        `Add \`${library.name}: ${importSpelling(fileSource, library.requested)}\` under \`imports:\` and run again`,
    };
  }
}

const fileLabel = (source: string) => source.slice(source.lastIndexOf("/") + 1);

/** How a file at `from` writes an import of a module requested as `target`. */
function importSpelling(from: string, target: string): string {
  if (!target.startsWith("file:") && !target.startsWith("/")) return target;
  const strip = (url: string) => url.replace(/^file:\/\//, "");
  const fromParts = strip(from).split("/").slice(0, -1);
  const targetParts = strip(target).replace(/\/telo\.yaml$/, "").split("/");
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) common++;
  const up = fromParts.length - common;
  const down = targetParts.slice(common).join("/");
  const relative = `${up === 0 ? "./" : "../".repeat(up)}${down}`;
  return relative.endsWith("/") ? relative.slice(0, -1) : relative;
}

/** A node a rule rewrote: its input, and the rule that rewrote it. */
interface RewriteStep {
  readonly input: unknown;
  readonly rule: MigrationRule;
  readonly migration: LibraryMigration;
}

/** A `resolve` entry with `before` read by a rule that fired, at the position it
 *  read. */
interface BeforeRead {
  readonly position: string;
  readonly migration: LibraryMigration;
  readonly type: string;
}

/** A hand-over rule that fired on a referent, pending its group's verdict. */
interface HandOverAttempt {
  readonly key: string;
  readonly library: MigratingLibrary;
  readonly migration: LibraryMigration;
  readonly type: string;
  readonly at: MigrationTreePointer;
}

/** The outcome of one node's fixpoint. */
interface NodeOutcome {
  readonly value: unknown;
  /** The migrations that fired on the node or on content it produced. */
  readonly fired: readonly { library: MigratingLibrary; migration: LibraryMigration }[];
  readonly reads: readonly BeforeRead[];
  readonly attempts: readonly HandOverAttempt[];
}

/** One declaration of a module instance a `!ref` names by its bare name. */
interface NamedDeclaration {
  readonly file: LoadedFile;
  readonly document: number;
}

/** A reference position naming a referent: where it is, and how it reads. */
interface MemberPosition {
  readonly key: string;
  readonly label: string;
  readonly at: MigrationTreePointer;
}

const positionKey = (file: string, document: number, path: readonly (string | number)[]) =>
  JSON.stringify([file, document, path.map(String)]);

/** One document's state within a pass. */
type DocumentState =
  | { readonly status: "running" }
  | { readonly status: "done"; readonly value: unknown; readonly failed: boolean };

/** Why a referent's hand-over did not hold, worded for its fallback-less failure. */
type BlockedHandOvers = ReadonlyMap<string, string>;

/**
 * One pass over one module's files, with the hand-overs `blocked` names withheld.
 * The module is migrated by repeating passes until no hand-over that fired fails
 * its group: each failing one is withheld from the next pass, so the passes stop.
 */
class ModulePass {
  readonly findings: LibraryMigrationFinding[] = [];
  readonly failed: MigrationTreePointer[] = [];
  readonly changed: { file: LoadedFile; document: number; paths: ValuePath[]; working: unknown }[] = [];
  readonly tentative = new Map<string, HandOverAttempt>();
  readonly committed = new Map<string, HandOverAttempt>();
  readonly attemptedReads = new Set<string>();
  readonly keptReads: BeforeRead[] = [];
  readonly failureCause = new Map<string, string>();
  private readonly steps = new WeakMap<object, RewriteStep>();
  private readonly documents = new Map<string, DocumentState>();
  private readonly stack: string[] = [];
  private readonly cycles = new Map<string, string>();
  private readonly settled = new WeakSet<object>();

  constructor(
    private readonly stage: ModuleStage,
    private readonly mod: LoadedModule,
    private readonly libraries: ReadonlyMap<string, MigratingLibrary>,
    private readonly blocked: BlockedHandOvers,
  ) {}

  run(): void {
    for (const file of filesOf(this.mod)) file.manifests.forEach((_doc, document) => this.document(file, document));
  }

  /** The migrated value of one document, migrating it first when it has not been. */
  document(file: LoadedFile, document: number): DocumentState {
    const key = positionKey(file.source, document, []);
    const known = this.documents.get(key);
    if (known) return known;
    this.documents.set(key, { status: "running" });
    this.stack.push(key);
    const state = this.migrateDocument(file, document);
    this.stack.pop();
    this.documents.set(key, state);
    return state;
  }

  private migrateDocument(file: LoadedFile, document: number): DocumentState {
    const doc = file.manifests[document];
    if (!doc) return { status: "done", value: doc, failed: false };
    const candidates = documentCandidates(this.stage, doc);
    if (candidates.length === 0) return { status: "done", value: doc, failed: false };
    let working: unknown = doc;
    let rootFailed = false;
    const changed: ValuePath[] = [];
    for (const candidate of candidates.sort((a, b) => b.path.length - a.path.length)) {
      const at = valueAt(working, candidate.path);
      if (at === undefined) continue;
      if (at !== null && typeof at === "object" && this.settled.has(at)) continue;
      try {
        const outcome = this.fixpoint(file, document, candidate.path, at, candidate, candidate.declaration);
        for (const { library, migration } of outcome.fired) {
          this.report(file, document, candidate.path, {
            code: migration.code,
            severity: migration.severity,
            message: migration.reason,
            library: { module: library.name, source: library.requested },
          });
        }
        for (const read of outcome.reads) this.keptReads.push(read);
        for (const attempt of outcome.attempts) this.committed.set(attempt.key, attempt);
        if (outcome.value !== at) {
          working = replacedAt(working, candidate.path, outcome.value);
          changed.push(candidate.path);
        }
      } catch (error) {
        if (!(error instanceof NodeFailure)) throw error;
        this.failureCause.set(positionKey(file.source, document, candidate.path), error.cause);
        this.report(file, document, candidate.path, {
          code: "MIGRATION_FAILED",
          severity: "error",
          message: `The migration ${error.code} of ${error.library.name} could not be applied: ${error.cause}.`,
          migration: error.code,
          migrations: [error.code],
          cause: error.cause,
          library: { module: error.library.name, source: error.library.requested },
        });
        this.failed.push({ file: file.source, document, path: candidate.path });
        if (candidate.path.length === 0) rootFailed = true;
        if (at !== null && typeof at === "object") this.settled.add(at);
      }
    }
    if (changed.length > 0) this.changed.push({ file, document, paths: changed, working });
    return { status: "done", value: working, failed: rootFailed };
  }

  private report(
    file: LoadedFile,
    document: number,
    path: ValuePath,
    finding: Omit<LibraryMigrationFinding, "at" | "modulePath">,
  ): void {
    this.findings.push({ ...finding, at: { file: file.source, document, path }, modulePath: this.mod.owner.source });
  }

  /** The value `step` chain of `value` holds before `rule` rewrote it, or
   *  undefined when that rule never rewrote it. */
  private before(value: unknown, rule: MigrationRule): unknown {
    let at = value;
    while (at !== null && typeof at === "object") {
      const step = this.steps.get(at);
      if (!step) return undefined;
      if (step.rule === rule) return step.input;
      at = step.input;
    }
    return undefined;
  }

  /**
   * The declaration a `resolve` entry binds: inline at `at`, or the one the
   * `!ref` there names, migrated first. `undefined` when it names nothing this
   * module instance declares (a dependency's, an unknown name) — read nowhere,
   * and a `before` reading of it finds no hand-over.
   */
  private bound(
    file: LoadedFile,
    document: number,
    path: ValuePath,
    node: unknown,
    binding: MigrationBinding,
    library: MigratingLibrary,
    migration: LibraryMigration,
  ): { value: unknown } | { unreadable: string } | undefined {
    const at = migrationPointerSegments(binding.at);
    const written = valueAt(node, at);
    if (written === undefined) return undefined;
    const ref = refSentinelTarget(written);
    if (ref) {
      const own = ref.alias === undefined || ref.alias === "Self" || ref.alias === moduleNameOf(this.mod);
      const resolved =
        own && ref.indexes.length === 0
          ? this.stage.referenceAt(file.source, document, [...path, ...at], path, ref.name)?.target
          : undefined;
      if (resolved && !resolved.topLevel) {
        return {
          unreadable: `reads \`${ref.source}\`, which names a member of a scope or a template body, not a declaration of the module`,
        };
      }
      const declaration: NamedDeclaration | undefined = resolved;
      if (!declaration) {
        return {
          unreadable: `reads \`${ref.source}\`, a declaration of another module instance; content never crosses a module-instance boundary`,
        };
      }
      const key = positionKey(declaration.file.source, declaration.document, []);
      if (this.documents.get(key)?.status === "running") {
        const cycle = this.stack.slice(this.stack.indexOf(key));
        const names = cycle.map((k) => {
          const [f, d] = JSON.parse(k) as [string, number];
          const doc = filesOf(this.mod).find((x) => x.source === f)?.manifests[d];
          return `\`${String(doc?.metadata?.name ?? f)}\``;
        });
        const message = `the \`resolve:\` bindings of ${[...names, names[0]].join(" → ")} read each other, a cycle among binding reads`;
        for (const member of cycle) this.cycles.set(member, message);
        throw new NodeFailure(library, migration.code, message);
      }
      const state = this.document(declaration.file, declaration.document);
      const reader = positionKey(file.source, document, []);
      if (this.cycles.has(reader) && this.cycles.get(reader) === this.cycles.get(key)) {
        throw new NodeFailure(library, migration.code, this.cycles.get(reader)!);
      }
      if (state.status === "done" && state.failed) {
        // A failed referent was left as written, so no hand-over of it is found.
        if (binding.before !== undefined) return undefined;
        throw new NodeFailure(library, migration.code, `the declaration \`${ref.name}\` its binding \`${binding.binding}\` reads could not be migrated`);
      }
      return { value: state.status === "done" ? state.value : undefined };
    }
    if (isMigrationMap(written) && typeof written.kind === "string") return { value: written };
    throw new NodeFailure(
      library,
      migration.code,
      `the binding \`${binding.binding}\` reads ${renderValuePath([...path, ...at]) || "/"}, which holds neither a \`!ref\` nor an inline declaration`,
    );
  }

  /**
   * Whether `rule` recognizes `current`: its `match` holds and every `resolve`
   * entry with `before` finds its referent rewritten by that type's hand-over
   * rule. Returns the bindings it reads, or undefined.
   */
  private recognized(
    file: LoadedFile,
    document: number,
    path: ValuePath,
    current: unknown,
    target: TypeTarget,
    migration: LibraryMigration,
    rule: MigrationRule,
  ): Map<string, BindingReading> | undefined {
    if (!migrationMatchHolds(rule.match, current)) return undefined;
    const bindings = new Map<string, BindingReading>();
    for (const binding of rule.resolve) {
      const bound = this.bound(file, document, path, current, binding, target.library, migration);
      if (binding.before !== undefined) {
        const handOver = handOverRules(migration).get(binding.before);
        const input = bound && "value" in bound && handOver ? this.before(bound.value, handOver) : undefined;
        if (input === undefined) return undefined;
        bindings.set(binding.binding, { value: input });
      } else if (bound) {
        bindings.set(binding.binding, bound);
      }
    }
    return bindings;
  }

  fixpoint(
    file: LoadedFile,
    document: number,
    path: ValuePath,
    value: unknown,
    initial: TypeTarget,
    declaration: boolean,
  ): NodeOutcome {
    const firedRules = new Set<MigrationRule>();
    const firedHere: LibraryMigration[] = [];
    const fired: { library: MigratingLibrary; migration: LibraryMigration }[] = [];
    const reads: BeforeRead[] = [];
    const attempts: HandOverAttempt[] = [];
    const key = positionKey(file.source, document, path);
    let current = value;
    let target = initial;
    let last: { migration: LibraryMigration; rule: MigrationRule } | undefined;
    const rulesFor = (t: TypeTarget) =>
      this.stage.ruleTargets(t).flatMap((migration) =>
        migration.rules.filter((rule) => rule.rewrite === t.type).map((rule) => ({ migration, rule })),
      );
    const withheld = (migration: LibraryMigration, rule: MigrationRule, t: TypeTarget) =>
      handOverRules(migration).get(t.type) === rule && this.blocked.has(key);
    for (;;) {
      let next: { migration: LibraryMigration; rule: MigrationRule; bindings: Map<string, BindingReading> } | undefined;
      for (const { migration, rule } of rulesFor(target)) {
        if (firedRules.has(rule) || withheld(migration, rule, target)) continue;
        const bindings = this.recognized(file, document, path, current, target, migration, rule);
        if (bindings) {
          next = { migration, rule, bindings };
          break;
        }
      }
      if (!next) break;
      const input = current;
      const library = target.library;
      const applied = applyMigrationRule(
        current,
        next.rule,
        (written) => this.stage.spellKind(library, written, file.source),
        next.bindings,
      );
      if ("failure" in applied) throw new NodeFailure(library, next.migration.code, applied.failure);
      firedRules.add(next.rule);
      firedHere.push(next.migration);
      if (!fired.some((f) => f.migration === next!.migration)) fired.push({ library, migration: next.migration });
      for (const binding of next.rule.resolve) {
        if (binding.before === undefined) continue;
        const position = positionKey(file.source, document, [...path, ...migrationPointerSegments(binding.at)]);
        this.attemptedReads.add(position);
        reads.push({ position, migration: next.migration, type: binding.before });
      }
      if (handOverRules(next.migration).get(target.type) === next.rule) {
        const attempt = {
          key,
          library,
          migration: next.migration,
          type: target.type,
          at: { file: file.source, document, path },
        };
        this.tentative.set(key, attempt);
        attempts.push(attempt);
      }
      last = next;
      current = applied.value;
      if (declaration && isMigrationMap(current) && typeof current.kind === "string") {
        const identity = this.stage.kindIdentity(current.kind);
        const owner = identity ? this.libraries.get(identity.moduleName) : undefined;
        if (!identity || !owner) {
          this.remember(current, input, next);
          break;
        }
        target = { library: owner, type: identity.name };
      }
      // Content the rule produced is walked in turn.
      const inner = this.stage
        .innerCandidates(current, target, declaration)
        .sort((a, b) => b.path.length - a.path.length);
      for (const candidate of inner) {
        const at = valueAt(current, candidate.path);
        if (at === undefined || (at !== null && typeof at === "object" && this.settled.has(at))) continue;
        const outcome = this.fixpoint(file, document, [...path, ...candidate.path], at, candidate, candidate.declaration);
        for (const f of outcome.fired) if (!fired.some((g) => g.migration === f.migration)) fired.push(f);
        reads.push(...outcome.reads);
        attempts.push(...outcome.attempts);
        if (outcome.value !== at) current = replacedAt(current, candidate.path, outcome.value);
      }
      this.remember(current, input, next);
    }
    for (const { migration, rule } of rulesFor(target)) {
      if (!this.recognized(file, document, path, current, target, migration, rule)) continue;
      if (withheld(migration, rule, target)) {
        throw new NodeFailure(
          target.library,
          migration.code,
          `${this.blocked.get(key)}, and no later \`rewrite: Self.${target.type}\` rule takes it instead`,
        );
      }
      let cause: string;
      if (last && rule === last.rule) cause = `the result of ${rule.path} still satisfies its match`;
      else {
        const codes = [...new Set([...firedHere.map((m) => m.code), migration.code])];
        cause =
          `${rule.path} still matches once every rule that applies has fired: ` +
          `${codes.length > 1 ? `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]} undo each other` : `${codes[0]} undoes itself`}, ` +
          `a cycle among migrations`;
      }
      throw new NodeFailure(target.library, migration.code, cause);
    }
    if (fired.length > 0) {
      const problem = validateConverged(this.stage, current, target, declaration);
      if (problem) throw new NodeFailure(target.library, fired[fired.length - 1]!.migration.code, problem);
    }
    if (current !== null && typeof current === "object") this.settled.add(current);
    return { value: current, fired, reads, attempts };
  }

  private remember(current: unknown, input: unknown, by: { migration: LibraryMigration; rule: MigrationRule }): void {
    if (current !== null && typeof current === "object") {
      this.steps.set(current, { input, rule: by.rule, migration: by.migration });
    }
  }
}

/** `file:line:col` of a path of one document, as a diagnostic places it. */
function locate(file: LoadedFile, document: number, path: ValuePath): string {
  const rendered = renderValuePath(path);
  const range = file.positions[document]?.positionIndex.get(rendered);
  const at = range ? `${fileLabel(file.source)}:${range.start.line + 1}:${range.start.character + 1}` : fileLabel(file.source);
  return `${at} (\`${rendered || "/"}\`)`;
}

/**
 * Every reference position of `mod` that resolves to its top-level declaration
 * `name` — each `!ref` at any depth of any document, a slot of any kind or shape
 * or none, resolved as analysis resolves it (scope first, innermost out, a
 * template body's entries first), so a `!ref` a `with:` member or body entry of
 * the same name shadows is none — and each `exports.resources` entry naming it.
 * A CEL read of `resources.<name>` is none.
 */
function referenceMembers(stage: ModuleStage, mod: LoadedModule, name: string): MemberPosition[] {
  const out: MemberPosition[] = [];
  for (const ref of stage.references()) {
    const target = ref.target;
    if (!target || !target.topLevel || target.name !== name) continue;
    out.push({
      key: positionKey(ref.file.source, ref.document, ref.path),
      label: locate(ref.file, ref.document, ref.path),
      at: { file: ref.file.source, document: ref.document, path: ref.path },
    });
  }
  for (const file of filesOf(mod)) {
    file.manifests.forEach((doc, document) => {
      if (!doc || document >= file.documents.length) return;
      if (typeof doc.kind !== "string" || !isModuleKind(doc.kind)) return;
      const exported = (doc as { exports?: { resources?: unknown } }).exports?.resources;
      if (!Array.isArray(exported)) return;
      exported.forEach((entry, i) => {
        if (entry === name || entry === `Self.${name}`) {
          const path = ["exports", "resources", i];
          out.push({ key: positionKey(file.source, document, path), label: locate(file, document, path), at: { file: file.source, document, path } });
        }
      });
    });
  }
  return out;
}

/** The hand-overs of `pass` that do not hold as a group, each with why. */
function judgeHandOvers(stage: ModuleStage, pass: ModulePass, mod: LoadedModule): Map<string, string> {
  const out = new Map<string, string>();
  const fileOf = (source: string) => filesOf(mod).find((f) => f.source === source)!;
  for (const attempt of pass.tentative.values()) {
    const file = fileOf(attempt.at.file);
    const doc = file.manifests[attempt.at.document];
    const name = attempt.at.path.length === 0 ? doc?.metadata?.name : undefined;
    const label =
      typeof name === "string" ? `\`${name}\`` : `the inline declaration at ${locate(file, attempt.at.document, attempt.at.path)}`;
    if (!pass.committed.has(attempt.key)) {
      const cause = pass.failureCause.get(attempt.key);
      out.set(attempt.key, `the hand-over of ${label} cannot fire, since its rewrite could not be kept${cause ? ` (${cause})` : ""}`);
      continue;
    }
    const members =
      typeof name === "string"
        ? referenceMembers(stage, mod, name)
        : [{ key: attempt.key, label: locate(file, attempt.at.document, attempt.at.path), at: attempt.at }];
    if (members.length === 0) {
      out.set(
        attempt.key,
        `the hand-over of ${label} cannot fire: nothing in its module references it, so no node would take over what its hand-over rule drops`,
      );
      continue;
    }
    const missing = members.find(
      (member) =>
        !pass.keptReads.some(
          (read) => read.position === member.key && read.migration === attempt.migration && read.type === attempt.type,
        ),
    );
    if (!missing) continue;
    const reason = pass.attemptedReads.has(missing.key)
      ? "a reference whose reading rule could not be applied"
      : `a reference no rule of ${attempt.migration.code} reads`;
    out.set(attempt.key, `the hand-over of ${label} cannot fire because of ${missing.label}, ${reason}`);
  }
  return out;
}

/** The hand-overs of the final pass, each as its group. */
function heldHandOvers(stage: ModuleStage, pass: ModulePass, mod: LoadedModule): LibraryHandOver[] {
  const out: LibraryHandOver[] = [];
  const fileOf = (source: string) => filesOf(mod).find((f) => f.source === source)!;
  for (const attempt of pass.committed.values()) {
    const file = fileOf(attempt.at.file);
    const doc = file.manifests[attempt.at.document];
    const name = attempt.at.path.length === 0 ? doc?.metadata?.name : undefined;
    const members =
      typeof name === "string" ? referenceMembers(stage, mod, name).map((m) => m.at) : [attempt.at];
    out.push({
      modulePath: mod.owner.source,
      migration: attempt.migration.code,
      library: attempt.library.name,
      referent: attempt.at,
      label: typeof name === "string" ? `\`${name}\`` : "the inline declaration",
      members,
    });
  }
  return out;
}

/** What a removed kind is retyped to, or why it cannot be. */
type Replacement =
  | { readonly kind: string; readonly by: readonly { migration: LibraryMigration; rule: MigrationRule }[] }
  | { readonly failure: string; readonly code: string };

/**
 * The replacement of the removed kind `type` of `library`: the kind every rule
 * of it that is not a hand-over rule writes at its root, followed onward while
 * that kind is itself removed, until a declared kind. The order of migration
 * codes decides no kind.
 */
function replacementOf(stage: ModuleStage, library: MigratingLibrary, type: string, written: string): Replacement {
  const visited = [type];
  const by: { migration: LibraryMigration; rule: MigrationRule }[] = [];
  let current = type;
  for (;;) {
    const writers = library.migrations.flatMap((migration) => {
      const handOver = handOverRules(migration).get(current);
      return migration.rules
        .filter((rule) => rule.rewrite === current && rule !== handOver && rootKindWritten(rule) !== undefined)
        .map((rule) => ({ migration, rule, kind: rootKindWritten(rule)! }));
    });
    const codeOf = () =>
      writers[0]?.migration.code ??
      library.migrations.find((m) => m.rules.some((r) => r.rewrite === current))?.code ??
      library.migrations[0]!.code;
    if (writers.length === 0) {
      return {
        code: codeOf(),
        failure: `\`${written}\` has no replacement, since no rule of ${library.name} other than a hand-over rule writes the kind of \`Self.${current}\``,
      };
    }
    const kinds = [...new Set(writers.map((w) => w.kind))];
    if (kinds.length > 1) {
      return {
        code: codeOf(),
        failure: `\`${written}\` has no single replacement: ${writers.map((w) => `${w.rule.path} writes \`${w.kind}\``).join(", ")}`,
      };
    }
    by.push(...writers);
    const next = selfTypeName(kinds[0]);
    if (next === undefined || stage.declares(library, next)) return { kind: kinds[0]!, by };
    if (visited.includes(next)) {
      return {
        code: codeOf(),
        failure: `the replacements of \`${written}\` form a cycle: ${[...visited, next].map((t) => `Self.${t}`).join(" → ")}`,
      };
    }
    if (!stage.removedKinds(library).has(next)) {
      return { code: codeOf(), failure: `\`${written}\` is replaced by \`Self.${next}\`, which ${library.name} does not declare` };
    }
    visited.push(next);
    current = next;
  }
}

/**
 * A Library's kind-only declarations — its `resources:` and `needs:` entries —
 * naming a kind their module no longer declares, retyped to its replacement in
 * the declaring module's alias.
 */
function retypeKindOnlyDeclarations(
  stage: ModuleStage,
  mod: LoadedModule,
  libraries: ReadonlyMap<string, MigratingLibrary>,
  findings: LibraryMigrationFinding[],
  failed: MigrationTreePointer[],
): { file: LoadedFile; document: number; paths: ValuePath[]; working: unknown } | undefined {
  const file = mod.owner;
  const document = file.manifests.findIndex((m) => m?.kind === "Telo.Library");
  const doc = file.manifests[document];
  if (!doc) return undefined;
  let working: unknown = doc;
  const paths: ValuePath[] = [];
  for (const block of ["resources", "needs"] as const) {
    const entries = (doc as Record<string, unknown>)[block];
    if (!isMigrationMap(entries)) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (!isMigrationMap(entry) || typeof entry.kind !== "string") continue;
      const identity = stage.kindIdentity(entry.kind);
      const library = identity ? libraries.get(identity.moduleName) : undefined;
      if (!identity || !library || stage.declares(library, identity.name)) continue;
      if (!stage.removedKinds(library).has(identity.name)) continue;
      const path: ValuePath = [block, name];
      const at = { file: file.source, document, path };
      const report = (finding: Omit<LibraryMigrationFinding, "at" | "modulePath" | "library">) =>
        findings.push({ ...finding, at, modulePath: mod.owner.source, library: { module: library.name, source: library.requested } });
      const replacement = replacementOf(stage, library, identity.name, entry.kind);
      const spelled = "kind" in replacement ? stage.spellKind(library, replacement.kind, file.source) : undefined;
      if ("failure" in replacement || (spelled && "failure" in spelled)) {
        const code = "failure" in replacement ? replacement.code : replacement.by[0]!.migration.code;
        const cause = "failure" in replacement ? replacement.failure : (spelled as { failure: string }).failure;
        const codes =
          "failure" in replacement
            ? [replacement.code]
            : [...new Set(replacement.by.map((b) => b.migration.code))].sort();
        report({
          code: "MIGRATION_FAILED",
          severity: "error",
          message: `The migration ${code} of ${library.name} could not be applied: ${cause}.`,
          migration: code,
          migrations: codes,
          cause,
        });
        failed.push(at);
        continue;
      }
      for (const migration of [...new Set(replacement.by.map((b) => b.migration))]) {
        report({ code: migration.code, severity: migration.severity, message: migration.reason });
      }
      working = replacedAt(working, path, { ...entry, kind: (spelled as { kind: string }).kind });
      paths.push(path);
    }
  }
  return paths.length > 0 ? { file, document, paths, working } : undefined;
}

/** One module's migration: passes until its hand-overs hold, then the kind-only
 *  declarations, recorded as one edit record. */
function migrateModule(
  graph: LoadedGraph,
  mod: LoadedModule,
  libraries: ReadonlyMap<string, MigratingLibrary>,
  defs: DefinitionRegistry,
  findings: LibraryMigrationFinding[],
  rewritten: MigrationTreePointer[],
  failed: MigrationTreePointer[],
  handOvers: LibraryHandOver[],
): ModuleMigrationRecord | undefined {
  const stage = new ModuleStage(graph, mod, libraries, defs);
  const blocked = new Map<string, string>();
  let pass: ModulePass;
  for (;;) {
    pass = new ModulePass(stage, mod, libraries, blocked);
    pass.run();
    const failing = judgeHandOvers(stage, pass, mod);
    if (failing.size === 0) break;
    for (const [key, cause] of failing) blocked.set(key, cause);
  }
  findings.push(...pass.findings);
  failed.push(...pass.failed);
  handOvers.push(...heldHandOvers(stage, pass, mod));
  const changed = [...pass.changed];
  const retyped = retypeKindOnlyDeclarations(stage, mod, libraries, findings, failed);
  if (retyped) changed.push(retyped);

  const index = migrationTreeIndex(filesOf(mod).map((file) => [file.source, file.manifests]));
  const entries: MigrationRecordEntry[] = [];
  const read = new Set<string>();
  for (const { file, document, paths, working } of changed) {
    const outermost = paths.filter((path) => !paths.some((other) => other !== path && other.length < path.length && startsWithPath(path, other)));
    for (const path of outermost) {
      const anchor = { file: file.source, document, path };
      entries.push({ anchor, node: encodeMigratedNode(valueAt(working, path), index, read) });
      rewritten.push(anchor);
      read.add(file.source);
    }
  }
  if (entries.length === 0) return undefined;
  const files: Record<string, string> = {};
  for (const file of filesOf(mod)) if (read.has(file.source)) files[file.source] = migrationTextDigest(file.text);
  return { module: mod.owner.source, files, entries };
}

/** Every candidate of one top-level document. */
function documentCandidates(stage: ModuleStage, doc: ResourceManifest): Candidate[] {
  const kind = doc.kind;
  if (typeof kind === "string" && (isModuleKind(kind) || kind === "Telo.Import")) return [];
  if (isKindDocument(doc)) {
    const out: Candidate[] = [];
    const resources = (doc as Record<string, unknown>).resources;
    const covered = new Set(templateBodyEntries(doc).map((entry) => entry.index));
    if (Array.isArray(resources)) {
      for (const entry of templateBodyEntries(doc)) {
        out.push(...stage.declarationCandidates(entry.manifest, ["resources", entry.index]));
      }
      resources.forEach((entry, i) => {
        if (!covered.has(i) && isExpansionSentinel(entry)) out.push(...stage.declarationCandidates(entry, ["resources", i]));
      });
    }
    const targets = (doc as Record<string, unknown>).targets;
    if (Array.isArray(targets)) {
      targets.forEach((item, i) => out.push(...stage.declarationCandidates(item, ["targets", i])));
    }
    return out;
  }
  return stage.declarationCandidates(doc, []);
}

/** Why a converged node fails its type's current schema, when it does. */
function validateConverged(stage: ModuleStage, value: unknown, target: TypeTarget, declaration: boolean): string | undefined {
  const identity =
    declaration && isMigrationMap(value) && typeof value.kind === "string"
      ? stage.kindIdentity(value.kind)
      : { moduleName: target.library.name, name: target.type };
  const schema = identity ? stage.schemaOf(identity) : undefined;
  if (!schema) return undefined;
  let data = value;
  if (declaration && isMigrationMap(value)) {
    const { kind: _kind, metadata: _metadata, ...rest } = value;
    data = rest;
  }
  const issues = stage.defs.validateResourceConfig(data, stage.selfContained(schema)).filter((issue) => {
    const segments = (issue.pointer ?? "").split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    let at: unknown = data;
    for (let i = 0; i <= segments.length; i++) {
      if (isOpaqueMigrationValue(at)) return false;
      if (i > 0 && isMigrationMap(at) && typeof at.kind === "string") return false;
      if (i === segments.length || at === null || typeof at !== "object") break;
      at = (at as Record<string, unknown>)[segments[i]!];
    }
    return true;
  });
  if (issues.length === 0) return undefined;
  const issue = issues[0]!;
  const pointer = issue.additionalProperty !== undefined
    ? `${issue.pointer ?? ""}/${issue.additionalProperty.replace(/~/g, "~0").replace(/\//g, "~1")}`
    : issue.pointer || "/";
  return `the result fails the current schema at ${pointer}: ${issue.message}`;
}

/** Modules in import post-order: a library before everything importing it. */
function postOrder(graph: LoadedGraph): LoadedModule[] {
  const order: LoadedModule[] = [];
  const seen = new Set<string>();
  const visit = (source: string) => {
    if (seen.has(source)) return;
    seen.add(source);
    const mod = graph.modules.get(source);
    if (!mod) return;
    for (const file of filesOf(mod)) {
      for (const edge of graph.importEdges.get(file.source)?.values() ?? []) visit(edge.targetSource);
      for (const edge of graph.scopedImportEdges?.get(file.source) ?? []) visit(edge.targetSource);
    }
    order.push(mod);
  };
  visit(graph.rootSource);
  for (const source of graph.modules.keys()) visit(source);
  return order;
}

/**
 * Runs the stage over `graph`, whose copies {@link takeLibraryMigrationCopies}
 * took: finds every candidate, migrates it, applies each module's record to the
 * copies and returns the outcome, which the caller sets on the graph.
 */
export function runLibraryMigrationStage(
  graph: LoadedGraph,
  pending: PendingLibraryMigrations,
  defs: DefinitionRegistry,
): LibraryMigrationOutcome {
  const records = new Map<string, ModuleMigrationRecord>();
  const findings: LibraryMigrationFinding[] = [];
  const rewritten: MigrationTreePointer[] = [];
  const failed: MigrationTreePointer[] = [];
  const handOvers: LibraryHandOver[] = [];
  for (const mod of postOrder(graph)) {
    if (!pending.originals.has(mod.owner.source)) continue;
    const record = migrateModule(graph, mod, pending.libraries, defs, findings, rewritten, failed, handOvers);
    if (!record) continue;
    records.set(mod.owner.source, record);
    const documents = new Map(filesOf(mod).map((file) => [file.source, file.manifests as unknown[]]));
    applyLibraryMigrationRecord(record, (file) => documents.get(file));
  }
  findings.sort((a, b) => SEVERITY_ORDER(a.at.file, b.at.file) || a.at.document - b.at.document);
  return { records, findings, originals: pending.originals, rewritten, failed, handOvers };
}
