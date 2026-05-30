import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { walkCelExpressions } from "@telorun/templating";
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
  const { aliases, aliasesByModule, skipKinds, expand } = options;

  const wantsRefs = !!visitor.onRef;
  const wantsScope = !!visitor.onScope;
  const wantsSchemaFrom = !!visitor.onSchemaFrom;
  const wantsCel = !!visitor.onCel;

  for (const r of resources) {
    if (!r.metadata?.name || !r.kind) continue;
    if (skipKinds?.has(r.kind)) continue;

    const resolvedKind = aliases?.resolveKind(r.kind);
    const definition =
      registry.resolve(r.kind) ??
      (resolvedKind ? registry.resolve(resolvedKind) : undefined);

    visitor.onResourceEnter?.({ source: r, definition });

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
