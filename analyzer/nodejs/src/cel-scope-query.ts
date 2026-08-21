/**
 * **Ask what a CEL site sees, from outside the analysis pass.**
 *
 * The pass resolves a scope per expression as it walks. An IDE has no walk: it
 * has a cursor, and needs the same answer for one address — often for an
 * expression the last analysis never saw, because the user is typing it. So the
 * query is driven by (manifest, path) rather than by a visitor event, and the
 * `x-telo-context` match is recomputed here exactly as the visitor computes it
 * (`extractContextsFromSchema` + `pathMatchesScope`, the same two functions).
 *
 * The scope RULE itself is not re-implemented — {@link CelScopeResolver} is the
 * one that answers, here and in the pass. What this module adds is the way in.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { Environment } from "@marcbachmann/cel-js";
import { AliasResolver, type ModuleScopes } from "./alias-resolver.js";
import { buildCelEnvironment } from "./cel-environment.js";
import { CelScopeResolver, type CelScope } from "./cel-scope.js";
import { DefinitionRegistry } from "./definition-registry.js";
import { buildKernelGlobalsIndex } from "./kernel-globals.js";
import { isModuleKind } from "./module-kinds.js";
import { navigateConcretePath } from "./manifest-path.js";
import { findManifest } from "./find-manifest.js";
import { resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import {
  buildObservedStateIndex,
  buildObservedStateResourcesSchema,
} from "./validate-observed-state.js";
import {
  extractContextsFromSchema,
  getManifestItem,
  pathMatchesScope,
} from "./validate-cel-context.js";

/** Where a CEL context binding was declared: the manifest that declares it,
 *  by identity, plus the concrete path within it. Identity rather than the
 *  object because a host locates a manifest in its own loaded files, which is
 *  what carries the source ranges. */
export interface ContextDeclarationSite {
  kind: string;
  name: string;
  path: string;
}

/** Join a concrete path segment, tolerating an empty base (the manifest root). */
function joinPath(base: string, segment: string): string {
  return base ? `${base}.${segment}` : segment;
}

/** The concrete path of the array ITEM an `x-telo-context` scope matched — the
 *  path half of `getManifestItem`, which returns only the value. Empty when the
 *  scope is not per-item. */
function manifestItemPath(exprPath: string, scope: string | undefined): string {
  if (!scope) return "";
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  const wildcard = stripped.indexOf("[*]");
  if (wildcard === -1) return "";
  const arrayProp = stripped.slice(0, wildcard);
  const match = exprPath.match(new RegExp(`^${arrayProp}\\[(\\d+)\\]`));
  return match ? `${arrayProp}[${match[1]}]` : "";
}

/** The analyzer state a query resolves against — what an `AnalysisRegistry`
 *  already holds, plus the manifest set the caller analyzed. */
export interface CelScopeQueryContext {
  defs: DefinitionRegistry;
  aliases: AliasResolver;
  aliasesByModule: Map<string, AliasResolver>;
}

/**
 * A reusable scope query over one manifest set.
 *
 * Built once per analysis rather than per keystroke: the observed-state index
 * and the kernel globals are a function of the whole set, and rebuilding them
 * for every cursor move would put a full-set walk on the hover path.
 */
export class CelScopeQuery {
  private readonly resolver: CelScopeResolver;
  /** The resource the resolver is currently entered on — `enterResource` is the
   *  per-resource half of the rule, so re-entering per query is only needed when
   *  the cursor moves to a different resource. */
  private entered: ResourceManifest | undefined;
  /** Resolved scopes, keyed by resource and path. A context-matched site builds
   *  a fresh typed environment by design (a clone plus a re-registration of
   *  every variable), which is affordable once per site in a batch pass and not
   *  once per site per KEYSTROKE — which is what a whole-file colourizer asks
   *  for. The lifetime is this query's, which is the analysis's. */
  private readonly scopeCache = new Map<ResourceManifest, Map<string, CelScope>>();

  constructor(
    private readonly manifests: ResourceManifest[],
    ctx: CelScopeQueryContext,
    celEnv?: Environment,
  ) {
    const { defs, aliases, aliasesByModule } = ctx;
    const rootModules = new Set<string>();
    for (const m of manifests) {
      if (isModuleKind(m.kind) && m.metadata?.name) rootModules.add(m.metadata.name as string);
    }
    const scopes: ModuleScopes = { aliasesByModule, rootModules };
    const observedState = buildObservedStateIndex(manifests, defs, aliases, scopes);
    const reportsObservedState = [...observedState.values()].some((r) => r.status);

    this.resolver = new CelScopeResolver({
      celEnv: celEnv ?? buildCelEnvironment(),
      defs,
      aliases,
      scopes,
      allManifests: manifests,
      kernelGlobals: buildKernelGlobalsIndex(manifests, observedState),
      moduleManifest:
        manifests.find((mm) => mm.kind === "Telo.Application") ??
        manifests.find((mm) => mm.kind === "Telo.Library"),
      observedStateContext: reportsObservedState
        ? {
            type: "object",
            additionalProperties: true,
            properties: { resources: buildObservedStateResourcesSchema(observedState, true) },
          }
        : null,
    });
    this.ctx = ctx;
  }

  private readonly ctx: CelScopeQueryContext;

  /** The manifest a cursor's document addresses — {@link findManifest}, the one
   *  implementation `ManifestAnalysis` also answers from. */
  resourceFor(kind: string | undefined, name: string | undefined): ResourceManifest | undefined {
    return findManifest(this.manifests, kind, name);
  }

  /**
   * What CEL at `path` in `resource` is typed against.
   *
   * `path` is the CONCRETE path, indices and all (`routes[0].handler.url`) —
   * an `x-telo-context` region, an error-bearing branch and a step's identity
   * are each addressed per item, so an index-erased path resolves the wrong
   * scope or none.
   */
  scopeAt(resource: ResourceManifest, path: string): CelScope {
    let byPath = this.scopeCache.get(resource);
    if (!byPath) this.scopeCache.set(resource, (byPath = new Map()));
    const cached = byPath.get(path);
    if (cached) return cached;
    if (this.entered !== resource) {
      this.resolver.enterResource(resource, this.definitionFor(resource));
      this.entered = resource;
    }
    const { contextSchema, matchedScope } = this.matchContext(resource, path);
    const scope = this.resolver.scopeFor({ source: resource, path, contextSchema, matchedScope });
    byPath.set(path, scope);
    return scope;
  }

  /**
   * Where a CEL context binding was DECLARED — the manifest node the
   * `x-telo-context-*` annotation derived it from.
   *
   * The mirror of {@link scopeAt}: that one resolves the annotation into a
   * schema and the provenance is gone by the time it returns, while
   * go-to-declaration wants the path and not the schema. Re-walking the
   * annotation is what keeps `CelScope` free of an origin field every type
   * consumer would have to ignore.
   *
   * Generic over the annotation, so `request.query` lands on the route's own
   * `request.schema.query`, `self.<field>` on the definition's `schema`, and
   * `result.<field>` on the INVOKED resource's `outputType` — one walk, no
   * transport and no resource kind named here.
   *
   * Every candidate path is checked against the manifest before it is returned,
   * so a binding the author never declared (a context annotation's static
   * fallback properties) resolves to nothing rather than to a guessed node.
   */
  contextDeclarationSite(
    resource: ResourceManifest,
    sitePath: string,
    parts: string[],
  ): ContextDeclarationSite | undefined {
    if (parts.length < 2) return undefined;
    const { contextSchema, matchedScope } = this.matchContext(resource, sitePath);
    const annotated = contextSchema?.properties?.[parts[0]] as Record<string, any> | undefined;
    if (!annotated) return undefined;

    const origin = this.originOf(annotated, resource, sitePath, matchedScope);
    if (!origin) return undefined;

    // The ORIGIN decides the shape rather than positional fallthrough. A
    // property-map origin holds the names themselves, so its first hop is direct
    // and ONLY direct — trying `properties` there would let an author's own
    // `properties:` key win over the name they wrote. Every deeper hop, and
    // every hop of a JSON-Schema origin, goes through `properties`, with the
    // inline `{ kind, schema }` wrapper as the one alternative a type field is
    // routinely written as.
    let base = origin.path;
    for (let i = 1; i < parts.length; i++) {
      const candidates =
        i === 1 && origin.propertyMap
          ? [joinPath(base, parts[i])]
          : [
              joinPath(joinPath(base, "properties"), parts[i]),
              joinPath(joinPath(joinPath(base, "schema"), "properties"), parts[i]),
            ];
      const hit = candidates.find(
        (candidate) => navigateConcretePath(origin.manifest, candidate) !== undefined,
      );
      if (!hit) return undefined;
      base = hit;
    }

    const metadata = origin.manifest.metadata as { name?: string } | undefined;
    if (!origin.manifest.kind || !metadata?.name) return undefined;
    return { kind: origin.manifest.kind, name: metadata.name, path: base };
  }

  /** The manifest and path an annotated context property is derived from, and
   *  whether that node holds a property MAP (names directly) or a JSON Schema. */
  private originOf(
    annotated: Record<string, any>,
    resource: ResourceManifest,
    sitePath: string,
    matchedScope: string | undefined,
  ): { manifest: Record<string, any>; path: string; propertyMap: boolean } | undefined {
    const root = resource as Record<string, any>;

    // Per-scope: the annotation navigates the enclosing ARRAY ITEM, so the path
    // it yields is relative to that item rather than to the resource.
    const from = annotated["x-telo-context-from"];
    if (typeof from === "string") {
      const itemPath = manifestItemPath(sitePath, matchedScope);
      return { manifest: root, path: joinPath(itemPath, from.split("/").join(".")), propertyMap: true };
    }

    const fromRoot = annotated["x-telo-context-from-root"];
    if (typeof fromRoot === "string") {
      return { manifest: root, path: fromRoot.split("/").join("."), propertyMap: false };
    }

    // Cross-manifest: the binding is declared by whatever this slot REFERENCES,
    // which is the node a reader wants when a result's members do not resolve.
    const refFrom = annotated["x-telo-context-ref-from"];
    if (typeof refFrom === "string") {
      const slash = refFrom.indexOf("/");
      if (slash === -1) return undefined;
      const item = matchedScope
        ? getManifestItem(sitePath, matchedScope, root)
        : root;
      const ref = item[refFrom.slice(0, slash)] as { kind?: string; name?: string } | undefined;
      if (!ref?.kind || !ref.name) return undefined;
      const target = this.manifests.find(
        (m) => m.kind === ref.kind && (m.metadata as { name?: string } | undefined)?.name === ref.name,
      ) as Record<string, any> | undefined;
      if (!target) return undefined;
      return { manifest: target, path: refFrom.slice(slash + 1).split("/").join("."), propertyMap: false };
    }

    // A kind's own declaration: the target is the `Telo.Definition` document,
    // which is an ordinary manifest in the set.
    const fromRefKind = annotated["x-telo-context-from-ref-kind"];
    const first = Array.isArray(fromRefKind) ? fromRefKind[0] : fromRefKind;
    if (typeof first === "string") {
      const hash = first.indexOf("#");
      if (hash <= 0) return undefined;
      const kindValue = navigateConcretePath(root, first.slice(0, hash).split("/").join("."));
      if (typeof kindValue !== "string") return undefined;
      const canonical = this.ctx.aliases.resolveKind(kindValue) ?? kindValue;
      const suffix = canonical.slice(canonical.indexOf(".") + 1);
      const target = this.manifests.find(
        (m) =>
          (m.kind === "Telo.Definition" || m.kind === "Telo.Abstract") &&
          (m.metadata as { name?: string } | undefined)?.name === suffix,
      ) as Record<string, any> | undefined;
      if (!target) return undefined;
      return { manifest: target, path: first.slice(hash + 1), propertyMap: false };
    }

    // `x-telo-context-element-from` / `-collection-from` type a binding from an
    // EXPRESSION, so there is no declaration to navigate to.
    return undefined;
  }

  /**
   * Where the step named `stepName` is declared in `resource`, as a concrete
   * path (`steps[2]`), or undefined when the resource declares no step body or
   * holds no such step.
   *
   * For go-to-declaration on `steps.<name>.result`, which is the one CEL scope
   * whose members ARE written somewhere in the manifest but are reached through
   * no reference slot. Driven by the kind's own step-body annotation and the
   * shared nesting walk, so a step inside a `try:` inside a `catch:` is found
   * and no resource kind is named here.
   */
  stepDeclarationPath(resource: ResourceManifest, stepName: string): string | undefined {
    const schema = this.definitionFor(resource)?.schema as Record<string, any> | undefined;
    const props = schema?.properties as Record<string, any> | undefined;
    if (!schema || !props) return undefined;
    for (const [fieldName, fieldSchema] of Object.entries(props)) {
      if (!readStepSlot(fieldSchema)) continue;
      const steps = (resource as Record<string, any>)[fieldName];
      if (!Array.isArray(steps)) continue;
      const itemSchema = resolveLocalRef(
        (fieldSchema as Record<string, any>).items as Record<string, any> | undefined,
        schema,
      );
      let found: string | undefined;
      walkStepArray(steps, itemSchema, schema, fieldName, (step, stepPath) => {
        if (found === undefined && step.name === stepName) found = stepPath;
      });
      if (found) return found;
    }
    return undefined;
  }

  private definitionFor(resource: ResourceManifest): ResourceDefinition | undefined {
    const { defs, aliases } = this.ctx;
    const canonical = aliases.resolveKind(resource.kind);
    return defs.resolve(resource.kind) ?? (canonical ? defs.resolve(canonical) : undefined);
  }

  /** The `x-telo-context` region this path falls in, matched exactly as the
   *  manifest visitor matches it for an expression it walked onto. */
  private matchContext(
    resource: ResourceManifest,
    path: string,
  ): { contextSchema?: Record<string, any>; matchedScope?: string } {
    const schema = this.definitionFor(resource)?.schema as Record<string, any> | undefined;
    if (!schema) return {};
    for (const ctx of extractContextsFromSchema(schema)) {
      if (pathMatchesScope(path, ctx.scope)) {
        return { contextSchema: ctx.schema, matchedScope: ctx.scope };
      }
    }
    return {};
  }
}
