import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel, walkCelExpressions } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  isRefEntry,
  isSchemaFromEntry,
  isScopeEntry,
  resolveFieldEntries,
  resolveFieldValues,
  type RefFieldEntry,
  type SchemaFromFieldEntry,
} from "./reference-field-map.js";
import { extractContextsFromSchema, pathMatchesScope } from "./validate-cel-context.js";

/**
 * One descent surface over a manifest's resources, emitting the annotation
 * sites every analyzer pass needs. It replaces the iteration scaffolding that
 * `validate-references`, `dependency-graph`, and the analyzer's CEL walk each
 * reimplemented (field-map fetch, scope collection, ref/schema-from iteration,
 * CEL expression walk + context matching).
 *
 * Two discovery mechanics ride one per-resource pass:
 *
 * - **Path-driven** — ref / scope / schema-from sites come from the resource's
 *   per-kind field map (`RefSite`, `ScopeBoundary`, `SchemaFromSite`). This is
 *   map iteration resolved against the resource value, not a node-by-node tree
 *   descent; the field map already unifies all three annotation types.
 * - **Value-tree-driven** — compiled `${{...}}` / `!cel` nodes are found by
 *   scanning the resource value tree (`CelSite`). CEL can sit in any string
 *   field, including ones the field map never lists, so its discovery is
 *   fundamentally not path-driven; the field map only supplies the matched
 *   `x-telo-context` schema at the enclosing path.
 *
 * Handlers are optional (Babel-style): the walker computes and emits only what
 * the visitor subscribes to, and skips the work behind absent handlers.
 *
 * **Scope is per-resource.** `ScopeBoundary` is emitted once per resource at
 * enter time, before that resource's `RefSite`s, carrying both the source
 * enclosure prefixes (for refs written *inside* a scope) and the enclosed
 * resource-name set (for consumers that drop edges to scoped targets). No
 * cross-resource ordering or global enclosed-name union is implied — every
 * consumer's scope decision is local to the resource being visited, matching
 * the semantics each pass had before this walker existed.
 */

export interface ResourceEnterEvent {
  source: ResourceManifest;
  /** Resolved definition for the resource's kind, or undefined when unknown. */
  definition?: ResourceDefinition;
}

export interface ResourceExitEvent {
  source: ResourceManifest;
}

export interface ScopeBoundaryEvent {
  source: ResourceManifest;
  /** Dot-form prefixes of every `x-telo-scope` field on this resource. */
  scopePrefixes: string[];
  /** Scope-field JSON Pointer → manifests declared within that scope. */
  manifestsByPointer: Map<string, ResourceManifest[]>;
  /** Names of every resource declared inside this resource's scopes. Used by
   *  the dependency graph to drop boot edges to scoped (on-demand) targets. */
  enclosedNames: Set<string>;
}

export interface RefSiteEvent {
  source: ResourceManifest;
  /** Field-map path with `[]` / `{}` markers (e.g. `steps[].invoke`). */
  fieldPath: string;
  /** Concrete path with `[N]` / map keys, matching `buildPositionIndex` keys. */
  concretePath: string;
  /** The ref value at this concrete site (sentinel, string, or `{kind,name}`). */
  value: unknown;
  /** The ref constraint (`refs[]`, `isArray`, optional `context`). */
  entry: RefFieldEntry;
  /** True when `fieldPath` falls within one of this resource's scope prefixes —
   *  source enclosure, used to scope a ref's candidate set. */
  inScope: boolean;
  /** Scope manifests visible to this ref path (non-empty only when `inScope`). */
  visibleScopeManifests: ResourceManifest[];
  /** True when the site was found by value-tree scanning rather than the field
   *  map (only when `discoverNestedRefs` is set) — a ref nested behind a `$ref`
   *  the field map doesn't descend (e.g. `Run.Sequence` `steps[].invoke`).
   *  Nested sites carry no x-telo-ref constraint (`entry.refs` is empty) and no
   *  scope info; `concretePath` still points at the exact location, so consumers
   *  can anchor to it. */
  nested?: boolean;
}

export interface SchemaFromSiteEvent {
  source: ResourceManifest;
  /** Field-map path of the `x-telo-schema-from` slot. */
  fieldPath: string;
  entry: SchemaFromFieldEntry;
}

export interface CelSiteEvent {
  source: ResourceManifest;
  /** Concrete dotted path of the expression (from `walkCelExpressions`). */
  path: string;
  /** The CEL source expression. */
  expr: string;
  /** Engine that owns the expression (`cel`, `literal`, …). */
  engineName: string;
  /** Raw `x-telo-context` schema matched at the enclosing path, if any. The
   *  consumer resolves `x-telo-context-*` annotations and merges its own
   *  globals — the walker only does the path → context match. */
  contextSchema?: Record<string, any>;
  /** Scope of the matched context (e.g. `$.routes[*].handler`), if matched. */
  matchedScope?: string;
}

export interface ManifestVisitor {
  onResourceEnter?(e: ResourceEnterEvent): void;
  onScope?(e: ScopeBoundaryEvent): void;
  onRef?(e: RefSiteEvent): void;
  onSchemaFrom?(e: SchemaFromSiteEvent): void;
  onCel?(e: CelSiteEvent): void;
  onResourceExit?(e: ResourceExitEvent): void;
}

export interface VisitOptions {
  aliases?: AliasResolver;
  aliasesByModule?: Map<string, AliasResolver>;
  /** Resource kinds to skip entirely (kind blueprints, import metadata, …). */
  skipKinds?: ReadonlySet<string>;
  /** When true, ref / scope sites come from the schema-from-expanded field map
   *  so refs nested behind `x-telo-schema-from` are surfaced. `SchemaFromSite`
   *  events are always emitted from the base map regardless of this flag. */
  expand?: boolean;
  /** When true, additionally discover refs by scanning each resource's value
   *  tree for `!ref` sentinels and `{kind, name}` reference objects — surfacing
   *  refs the field map never lists because they sit behind a `$ref` it doesn't
   *  descend (notably `Run.Sequence` step `invoke`s). Emitted as `RefSite`s with
   *  `nested: true`, deduped against the field-map sites by concrete path.
   *  Opt-in: the validators / dependency graph must NOT enable it (those refs
   *  are runtime-resolved, not boot dependencies). */
  discoverNestedRefs?: boolean;
}

/** Synthetic entry for a value-tree-discovered ref — these carry no declared
 *  x-telo-ref constraint. */
const NESTED_REF_ENTRY: RefFieldEntry = { refs: [], isArray: false };

/** Scans a value tree for ref-shaped values, emitting each with its concrete
 *  path. Recognizes `!ref <name>` sentinels and named `{kind, name}` reference
 *  objects. Other tagged sentinels (`!cel`, `!literal`) and precompiled nodes
 *  are leaves. Path format matches `resolveFieldEntries` / `walkCelExpressions`
 *  (`a.b[0].c`).
 *
 *  Stops at every `{kind, …}` resource boundary: a named ref is emitted, an
 *  inline resource (`{kind}` with no name) is left alone, and **neither is
 *  descended into**. A nested resource's own refs belong to its inner topology,
 *  not the enclosing node — e.g. an inline `Sql.Exec` step's `connection` is the
 *  Exec's dependency, not the surrounding `Run.Sequence`'s. The scan is started
 *  per top-level field (not on the resource object) so the resource's own
 *  `kind` doesn't trip this boundary. */
function walkRefValues(
  value: unknown,
  path: string,
  cb: (value: unknown, path: string) => void,
): void {
  if (isRefSentinel(value)) {
    cb(value, path);
    return;
  }
  if (isTaggedSentinel(value)) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkRefValues(v, `${path}[${i}]`, cb));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if ((value as { __compiled?: unknown }).__compiled) return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.kind === "string") {
    // Resource boundary — emit if it's a named ref, then stop descending.
    if (typeof obj.name === "string") cb(value, path);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    walkRefValues(v, path ? `${path}.${k}` : k, cb);
  }
}

const scopePrefixOf = (pointer: string): string =>
  pointer.replace(/^\//, "").replace(/\//g, ".");

const pathUnderPrefix = (fieldPath: string, prefix: string): boolean =>
  fieldPath === prefix ||
  fieldPath.startsWith(prefix + ".") ||
  fieldPath.startsWith(prefix + "[");

export function visitManifest(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  visitor: ManifestVisitor,
  options: VisitOptions = {},
): void {
  const { aliases, aliasesByModule, skipKinds, expand, discoverNestedRefs } = options;

  const wantsRefs = !!visitor.onRef;
  const wantsScope = !!visitor.onScope;
  const wantsSchemaFrom = !!visitor.onSchemaFrom;
  const wantsCel = !!visitor.onCel;
  const wantsNested = wantsRefs && !!discoverNestedRefs;

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind) continue;
    if (skipKinds?.has(r.kind)) continue;

    const resolvedKind = aliases?.resolveKind(r.kind);
    const definition =
      registry.resolve(r.kind) ??
      (resolvedKind ? registry.resolve(resolvedKind) : undefined);

    visitor.onResourceEnter?.({ source: r, definition });

    // Concrete paths emitted from the field map — so the value-tree scan below
    // doesn't re-emit a ref the field map already covered.
    const emittedRefPaths = wantsNested ? new Set<string>() : null;

    if (wantsRefs || wantsScope || wantsSchemaFrom) {
      const baseMap = aliases
        ? registry.getFieldMapForKind(r.kind, aliases)
        : registry.getFieldMap(r.kind);

      // Expanded map drives ref/scope sites when requested; schema-from sites
      // come from the base map (expansion replaces them with nested refs).
      const refScopeMap =
        expand && aliases && aliasesByModule
          ? registry.expandedFieldMapForResource(r, aliases, aliasesByModule)
          : baseMap;

      if (refScopeMap && (wantsRefs || wantsScope)) {
        const manifestsByPointer = new Map<string, ResourceManifest[]>();
        for (const [fieldPath, entry] of refScopeMap) {
          if (!isScopeEntry(entry)) continue;
          const raw = resolveFieldValues(r, fieldPath)
            .flatMap((v) => (Array.isArray(v) ? v : [v]))
            .filter((v): v is ResourceManifest => !!v && typeof v === "object");
          const pointers = Array.isArray(entry.scope) ? entry.scope : [entry.scope];
          for (const pointer of pointers) manifestsByPointer.set(pointer, raw);
        }
        const scopePrefixes = Array.from(manifestsByPointer.keys()).map(scopePrefixOf);

        if (wantsScope) {
          const enclosedNames = new Set<string>();
          for (const manifests of manifestsByPointer.values()) {
            for (const m of manifests) {
              const name = m.metadata?.name;
              if (typeof name === "string") enclosedNames.add(name);
            }
          }
          visitor.onScope!({ source: r, scopePrefixes, manifestsByPointer, enclosedNames });
        }

        if (wantsRefs) {
          for (const [fieldPath, entry] of refScopeMap) {
            if (!isRefEntry(entry)) continue;

            const inScope = scopePrefixes.some((prefix) => pathUnderPrefix(fieldPath, prefix));
            const visibleScopeManifests: ResourceManifest[] = [];
            if (inScope) {
              for (const [pointer, manifests] of manifestsByPointer) {
                if (pathUnderPrefix(fieldPath, scopePrefixOf(pointer))) {
                  visibleScopeManifests.push(...manifests);
                }
              }
            }

            for (const { value, path: concretePath } of resolveFieldEntries(r, fieldPath)) {
              if (!value) continue;
              emittedRefPaths?.add(concretePath);
              visitor.onRef!({
                source: r,
                fieldPath,
                concretePath,
                value,
                entry,
                inScope,
                visibleScopeManifests,
              });
            }
          }
        }
      }

      if (wantsSchemaFrom && baseMap) {
        for (const [fieldPath, entry] of baseMap) {
          if (!isSchemaFromEntry(entry)) continue;
          visitor.onSchemaFrom!({ source: r, fieldPath, entry });
        }
      }
    }

    // Value-tree-driven nested ref discovery — refs the field map can't reach
    // because they sit behind a `$ref` it doesn't descend (e.g. Run.Sequence
    // step `invoke`s). Deduped against the field-map sites by concrete path.
    // Scanned per top-level field so the resource's own `kind` isn't treated as
    // a resource boundary by `walkRefValues`.
    if (wantsNested) {
      const emitNested = (value: unknown, path: string) => {
        if (emittedRefPaths!.has(path)) return;
        visitor.onRef!({
          source: r,
          fieldPath: path,
          concretePath: path,
          value,
          entry: NESTED_REF_ENTRY,
          inScope: false,
          visibleScopeManifests: [],
          nested: true,
        });
      };
      for (const [key, value] of Object.entries(r as Record<string, unknown>)) {
        walkRefValues(value, key, emitNested);
      }
    }

    if (wantsCel) {
      const contexts = definition?.schema ? extractContextsFromSchema(definition.schema) : [];
      walkCelExpressions(r, "", (expr, path, engineName) => {
        let contextSchema: Record<string, any> | undefined;
        let matchedScope: string | undefined;
        for (const ctx of contexts) {
          if (pathMatchesScope(path, ctx.scope)) {
            contextSchema = ctx.schema;
            matchedScope = ctx.scope;
            break;
          }
        }
        visitor.onCel!({ source: r, path, expr, engineName, contextSchema, matchedScope });
      });
    }

    visitor.onResourceExit?.({ source: r });
  }
}
