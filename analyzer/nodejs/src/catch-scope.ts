/**
 * The catch ladder: which `catches:` entry renders a code at one dispatch site.
 *
 * A catch list is one rung of a SCOPE LADDER — a route's, its router's, its
 * server's — and every question over those lists reads this one model: the
 * coverage pass derives `UNCOVERED_THROW_CODE` / `UNBOUNDED_UNION_NEEDS_CATCHALL`
 * from it, and the outline states each rung's answer. Per list and code the
 * answer is the first entry PROVEN to render the code (a coverage-proving
 * `when:` naming it, or a catch-all), or none, and the entries before it whose
 * `when:` the analyzer cannot read — any of them may take the code first. A
 * site is covered when its own list answers, or its resource's scope list
 * does, or EVERY scope enclosing that resource covers it.
 *
 * Browser-safe: no Node built-ins.
 */
import type { CelEnvironment, CelNode } from "@telorun/cel";
import { CEL_ENGINE, isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { scopeResolverForModule, type AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isKindDocument } from "./kind-declaration.js";
import { visitManifest } from "./manifest-visitor.js";
import { forEachDrivenSlot } from "./schema-walk.js";
import {
  createResolveCtx,
  resolveRefManifest,
  resolveScopeUnion,
  resolveThrowsUnion,
  type ResolveCtx,
  type ThrowsCodeMeta,
  type ThrowsUnion,
} from "./resolve-throws-union.js";

/** One entry of an outcome list, as written. */
export interface OutcomeEntry {
  /** A `!cel` TaggedSentinel. */
  when?: unknown;
  body?: unknown;
  headers?: Record<string, unknown>;
  status?: number;
  schema?: Record<string, unknown>;
}

/** What one entry proves: a catch-all renders every code; a coverage-proving
 *  `when:` renders exactly `codes`; any other `when:` is undecided. */
export interface CatchEntryReading {
  catchAll: boolean;
  proven: boolean;
  codes: ReadonlySet<string>;
}

/** One list's answer for one code: the first entry proven to render it, and the
 *  entries before it a `when:` the analyzer cannot read decides. */
export interface CatchListAnswer {
  entry?: number;
  undecided: number[];
}

/** One `catches:` list in one manifest. */
export interface CatchList {
  manifest: ResourceManifest;
  definition: ResourceDefinition;
  /** Named in the MESSAGE — the resource whose list this is. */
  resource: { kind: string; name: string };
  /** Named in `data.resource`, which is how position lookup finds a document:
   *  it searches TOP-LEVEL docs by (kind, name), so a scoped resource routes
   *  through its owner while the message still names the scoped one. */
  routing: { kind: string; name: string };
  filePath: string | undefined;
  entries: OutcomeEntry[];
  readings: CatchEntryReading[];
  /** Concrete path of the list, prefixed for a scoped declaration with its
   *  position in its owner. */
  arrayPath: string;
  /** Concrete path of the list in its own resource. */
  ownPath: string;
  scopeResolver: AliasResolver | undefined;
  /** The handler value this list renders throws for; undefined for a scope list. */
  handler: unknown;
  /** Concrete path of that handler in the resource (`routes[0].handler`). */
  handlerPath?: string;
  /** `x-telo-catches-for: ""` — the list covers everything its resource drives
   *  and owes coverage of nothing on its own. */
  isScope: boolean;
}

/** What every scope enclosing a resource renders for one code. */
export interface ScopeRung {
  resource: ResourceManifest;
  /** The resource's own scope list, when it declares one. */
  list?: CatchList;
  answer?: CatchListAnswer;
  /** One rung per resource enclosing this one through a `throwsThrough` slot. */
  enclosers: ScopeRung[];
  /** The scope list answers, or every encloser covers the code. */
  covered: boolean;
}

/** One dispatch site's ladder for one code — `null` for any code its union
 *  cannot enumerate. */
export interface SiteLadder {
  code: string | null;
  own?: CatchListAnswer;
  scope: ScopeRung;
  covered: boolean;
}

/** A declaration inside another resource's `x-telo-scope` array, kept with the
 *  resource that encloses it and the path it is written at in that resource's
 *  document. Both are needed: the owner is the only place its kind's alias scope
 *  can be found, and the only document position lookup can reach. */
export interface ScopedManifest {
  manifest: ResourceManifest;
  owner: ResourceManifest;
  /** Concrete owner-relative path of the declaration (`with[0]`). */
  path: string;
}

/** Every `with:`-scoped declaration in the set, once each.
 *
 *  Scoped resources are absent from the flat manifest list, so every check that
 *  iterates it skips them — and standing a server up around a test is exactly
 *  that shape, so the sanctioned pattern was the one the pass could not see.
 *  Discovered through the shared visitor rather than a second scope walk. */
export function collectScopedManifests(
  manifests: ResourceManifest[],
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver>,
  rootModules: Set<string>,
): ScopedManifest[] {
  const scoped: ScopedManifest[] = [];
  visitManifest(
    manifests,
    defs,
    {
      onScope: (event) => {
        for (const { manifest, path } of event.declarations) {
          if (!manifest?.kind || !manifest.metadata?.name) continue;
          scoped.push({ manifest, owner: event.source, path });
        }
      },
    },
    { aliases, aliasesByModule, rootModules },
  );
  return scoped;
}

/** Walk a kind's schema and a resource in tandem, reporting every array the
 *  schema annotates `x-telo-outcome-list`: a `returns` list, and a `catches`
 *  list with the sibling its `x-telo-catches-for` names (the EMPTY pointer for a
 *  scope list). */
export function collectOutcomeLists(
  manifest: ResourceManifest,
  schema: Record<string, any> | undefined,
  onReturns: (entries: OutcomeEntry[], arrayPath: string) => void,
  onCatches: (
    entries: OutcomeEntry[],
    arrayPath: string,
    siblingData: Record<string, any>,
    parentPath: string,
    catchesFor: string,
  ) => void,
): void {
  if (!schema) return;
  walkSchemaData(schema, manifest as Record<string, any>, "", onReturns, onCatches);
}

function walkSchemaData(
  schema: Record<string, any>,
  data: unknown,
  path: string,
  onReturns: (entries: OutcomeEntry[], arrayPath: string) => void,
  onCatches: (
    entries: OutcomeEntry[],
    arrayPath: string,
    siblingData: Record<string, any>,
    parentPath: string,
    catchesFor: string,
  ) => void,
): void {
  if (!schema || typeof schema !== "object") return;

  const outcomeKind = schema["x-telo-outcome-list"] as "returns" | "catches" | undefined;
  if (outcomeKind && Array.isArray(data)) {
    // A top-level outcome list has no sibling to read; never occurs in practice.
    if (outcomeKind === "returns") onReturns(data as OutcomeEntry[], path);
    return;
  }

  if (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const dataObj = data as Record<string, unknown>;
    for (const [key, propSchema] of Object.entries(schema.properties as Record<string, any>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const child = dataObj[key];
      const outcome = propSchema["x-telo-outcome-list"] as "returns" | "catches" | undefined;
      if (outcome) {
        const entries = Array.isArray(child) ? (child as OutcomeEntry[]) : [];
        if (outcome === "returns") {
          // Only present arrays — a missing `returns` is the schema's to report.
          if (Array.isArray(child)) onReturns(entries, nextPath);
        } else {
          const catchesFor = propSchema["x-telo-catches-for"] as string | undefined;
          // The EMPTY pointer names the resource the list is written on, so the
          // test is presence, never truthiness. Reported even when absent, so a
          // site whose union is non-empty but whose list is missing is judged.
          if (catchesFor !== undefined) onCatches(entries, nextPath, dataObj, path, catchesFor);
        }
        continue;
      }
      if (child !== undefined) walkSchemaData(propSchema, child, nextPath, onReturns, onCatches);
    }
  }

  if (schema.items && Array.isArray(data)) {
    for (const [i, item] of data.entries()) {
      walkSchemaData(schema.items, item, `${path}[${i}]`, onReturns, onCatches);
    }
  }
}

/** Parse a `when:` CEL expression and extract the set of `error.code` literals
 *  it covers. Recognised forms: `error.code == 'FOO'`, a disjunction of those
 *  (`||`, parenthesised nestings flattened), and `error.code in ['FOO', 'BAR']`.
 *  Any non-matching sub-expression forfeits coverage for the whole `when:`. */
export function extractCoveredCodes(
  whenExpr: unknown,
  env: CelEnvironment,
): { proven: boolean; codes: Set<string> } {
  const source =
    isTaggedSentinel(whenExpr) && whenExpr.engine === CEL_ENGINE ? whenExpr.source : undefined;
  if (!source) return { proven: false, codes: new Set() };
  const parsed = env.parse(source.trim());
  if (parsed.diagnostics.length > 0) return { proven: false, codes: new Set() };
  const codes = new Set<string>();
  const proven = extractFromNode(parsed.root, codes);
  return { proven, codes };
}

function extractFromNode(node: CelNode, codes: Set<string>): boolean {
  if (node.kind !== "binary") return false;
  if (node.operator === "||") {
    return extractFromNode(node.left, codes) && extractFromNode(node.right, codes);
  }
  if (node.operator === "==") {
    const lit = readErrorCodeEq(node.left, node.right) ?? readErrorCodeEq(node.right, node.left);
    if (lit === null) return false;
    codes.add(lit);
    return true;
  }
  if (node.operator === "in") {
    if (!isErrorCodeRef(node.left) || node.right.kind !== "list") return false;
    for (const element of node.right.elements) {
      const text = stringLiteral(element.value);
      if (text === null) return false;
      codes.add(text);
    }
    return true;
  }
  return false;
}

function stringLiteral(node: CelNode): string | null {
  if (node.kind !== "literal" || node.literal.type !== "string") return null;
  return node.literal.value;
}

function readErrorCodeEq(ref: CelNode, lit: CelNode): string | null {
  return isErrorCodeRef(ref) ? stringLiteral(lit) : null;
}

function isErrorCodeRef(node: CelNode): boolean {
  if (node.kind !== "select" || node.field !== "code") return false;
  return node.operand.kind === "ident" && node.operand.name === "error";
}

/** What each entry of a list proves. */
export function readCatchEntries(entries: OutcomeEntry[], env: CelEnvironment): CatchEntryReading[] {
  return entries.map((entry) => {
    if (!entry) return { catchAll: false, proven: true, codes: new Set<string>() };
    if (!entry.when) return { catchAll: true, proven: true, codes: new Set<string>() };
    const { proven, codes } = extractCoveredCodes(entry.when, env);
    return { catchAll: false, proven, codes };
  });
}

/** The first entry of a list proven to render `code` — `null` asking for a
 *  code no `when:` can name, which only a catch-all renders — and the entries
 *  before it whose `when:` decides at run time. */
export function answerFor(readings: readonly CatchEntryReading[], code: string | null): CatchListAnswer {
  const undecided: number[] = [];
  for (let i = 0; i < readings.length; i++) {
    const reading = readings[i]!;
    if (reading.catchAll) return { entry: i, undecided };
    if (!reading.proven) {
      undecided.push(i);
      continue;
    }
    if (code !== null && reading.codes.has(code)) return { entry: i, undecided };
  }
  return { undecided };
}

/** Which resources each resource's scope list encloses, along the slots that
 *  declare `throwsThrough` — one fact stated once, since the edge a throws
 *  closure crosses is the edge a catch scope encloses through. */
function buildEnclosers(
  manifests: ResourceManifest[],
  definitionOf: (m: ResourceManifest) => { schema?: Record<string, any> } | undefined,
  moduleOf: (m: ResourceManifest) => string | undefined,
  ctx: ResolveCtx,
): Map<ResourceManifest, ResourceManifest[]> {
  const enclosers = new Map<ResourceManifest, ResourceManifest[]>();
  for (const manifest of manifests) {
    const definition = definitionOf(manifest);
    if (!definition?.schema) continue;
    forEachDrivenSlot(definition.schema, manifest, (driven) => {
      if (driven.kind !== "ref" || !driven.slots.some(({ slot }) => slot.throwsThrough)) return;
      const target = resolveRefManifest(driven.data, ctx, moduleOf(manifest));
      if (!target || target === manifest) return;
      const list = enclosers.get(target);
      if (list) list.push(manifest);
      else enclosers.set(target, [manifest]);
    });
  }
  return enclosers;
}

/** Read a handler named by a sibling field as `{kind, name}`: a resolved
 *  reference, or a kind string. */
function handlerRefOf(sibling: unknown): { kind: string; name?: string } | null {
  if (!sibling) return null;
  if (typeof sibling === "string") return { kind: sibling };
  if (typeof sibling === "object") {
    const obj = sibling as { kind?: unknown; name?: unknown };
    if (typeof obj.kind === "string") {
      return { kind: obj.kind, name: typeof obj.name === "string" ? obj.name : undefined };
    }
  }
  return null;
}

/**
 * Every catch list of a manifest set — `with:`-scoped declarations included —
 * with the ladder each dispatch site climbs.
 */
export class CatchLadder {
  /** Every list, scope lists included, in declaration order. */
  readonly lists: CatchList[] = [];
  /** The manifests the ladder reads: the flat set, then the scoped ones. */
  readonly allManifests: ResourceManifest[];
  readonly resolveCtx: ResolveCtx;
  /** The scoped declarations, by manifest. */
  readonly scopedBy = new Map<ResourceManifest, ScopedManifest>();
  private readonly scopeOf = new Map<ResourceManifest, CatchList>();
  /** Each dispatch site's own list, by manifest and handler path. */
  private readonly sites = new Map<ResourceManifest, Map<string, CatchList>>();
  private readonly enclosers: Map<ResourceManifest, ResourceManifest[]>;
  private readonly rungs = new Map<string | null, Map<ResourceManifest, ScopeRung>>();
  private readonly unions = new Map<CatchList, ThrowsUnion>();

  constructor(
    manifests: ResourceManifest[],
    private readonly defs: DefinitionRegistry,
    private readonly aliases: AliasResolver,
    env: CelEnvironment,
    private readonly aliasesByModule: Map<string, AliasResolver> = new Map(),
    private readonly rootModules: Set<string> = new Set(),
    /** Each imported library's full document set, so a union follows an
     *  exported entry point into the siblings it invokes. */
    moduleManifests: Map<string, ResourceManifest[]> = new Map(),
  ) {
    const scoped = collectScopedManifests(manifests, defs, aliases, aliasesByModule, rootModules);
    for (const s of scoped) this.scopedBy.set(s.manifest, s);
    this.allManifests = [...manifests, ...scoped.map((s) => s.manifest)];
    this.resolveCtx = createResolveCtx(
      this.allManifests,
      defs,
      aliases,
      aliasesByModule,
      rootModules,
      moduleManifests,
    );
    this.enclosers = buildEnclosers(
      this.allManifests,
      (m) => this.definitionOf(m),
      (m) => this.moduleOf(m),
      this.resolveCtx,
    );

    for (const manifest of this.allManifests) {
      if (!manifest.kind || !manifest.metadata?.name) continue;
      if (isKindDocument(manifest)) continue;
      const definition = this.definitionOf(manifest);
      if (!definition?.schema) continue;
      // A scoped declaration is reported against the document it is WRITTEN
      // in — its owner's — at its own position inside that owner's scope array,
      // because position lookup finds a TOP-LEVEL doc by (kind, name).
      const enclosing = this.scopedBy.get(manifest);
      const anchor = enclosing?.owner ?? manifest;
      const pathPrefix = enclosing ? `${enclosing.path}.` : "";
      const resource = { kind: manifest.kind, name: manifest.metadata.name as string };
      const routing = enclosing ? { kind: anchor.kind, name: anchor.metadata!.name as string } : resource;
      const filePath = (anchor.metadata as { source?: string } | undefined)?.source;
      collectOutcomeLists(
        manifest,
        definition.schema,
        () => {},
        (entries, arrayPath, siblingData, parentPath, catchesFor) => {
          const isScope = catchesFor === "";
          const list: CatchList = {
            manifest,
            definition,
            resource,
            routing,
            filePath,
            entries,
            readings: readCatchEntries(entries, env),
            arrayPath: `${pathPrefix}${arrayPath}`,
            ownPath: arrayPath,
            scopeResolver: this.scopeResolverOf(anchor),
            handler: isScope ? undefined : siblingData[catchesFor],
            ...(isScope ? {} : { handlerPath: parentPath ? `${parentPath}.${catchesFor}` : catchesFor }),
            isScope,
          };
          this.lists.push(list);
          if (isScope) this.scopeOf.set(manifest, list);
          else {
            const byPath = this.siteListsOf(manifest);
            if (!byPath.has(list.handlerPath!)) byPath.set(list.handlerPath!, list);
          }
        },
      );
    }
  }

  /** The list rendering what the handler at `handlerPath` of `manifest` throws. */
  siteAt(manifest: ResourceManifest, handlerPath: string): CatchList | undefined {
    return this.sites.get(manifest)?.get(handlerPath);
  }

  private siteListsOf(manifest: ResourceManifest): Map<string, CatchList> {
    let byPath = this.sites.get(manifest);
    if (!byPath) this.sites.set(manifest, (byPath = new Map()));
    return byPath;
  }

  /** A dispatch site's ladder for `code`: its own list's answer (when it has a
   *  list), then every scope enclosing its resource. */
  ladderFor(manifest: ResourceManifest, site: CatchList | undefined, code: string | null): SiteLadder {
    const own = site ? answerFor(site.readings, code) : undefined;
    const scope = this.scopeRung(manifest, code);
    return {
      code,
      ...(own ? { own } : {}),
      scope,
      covered: own?.entry !== undefined || scope.covered,
    };
  }

  /**
   * What every scope enclosing a resource renders for one code.
   *
   * **Across enclosers this INTERSECTS**: coverage claims a throw cannot escape
   * unrendered, so it holds only when EVERY path to the site renders it — a
   * router mounted on a public server with a catch-all and an internal one
   * without is covered on one path and bare on the other. A resource with no
   * encloser contributes nothing rather than everything: treating "no paths" as
   * "all paths agree" would assert coverage no list provides. An encloser met
   * again along a `throwsThrough` cycle is a rung that covers nothing: a cycle
   * never makes the answer larger.
   */
  scopeRung(manifest: ResourceManifest, code: string | null): ScopeRung {
    let byManifest = this.rungs.get(code);
    if (!byManifest) this.rungs.set(code, (byManifest = new Map()));
    return this.rungOf(manifest, code, byManifest, new Set());
  }

  private rungOf(
    manifest: ResourceManifest,
    code: string | null,
    memo: Map<ResourceManifest, ScopeRung>,
    walking: Set<ResourceManifest>,
  ): ScopeRung {
    const cached = memo.get(manifest);
    if (cached) return cached;
    const list = this.scopeOf.get(manifest);
    const answer = list ? answerFor(list.readings, code) : undefined;
    walking.add(manifest);
    const enclosers = (this.enclosers.get(manifest) ?? []).map((e) =>
      walking.has(e)
        ? { resource: e, enclosers: [], covered: false }
        : this.rungOf(e, code, memo, walking),
    );
    walking.delete(manifest);
    const rung: ScopeRung = {
      resource: manifest,
      ...(list ? { list, answer } : {}),
      enclosers,
      covered:
        answer?.entry !== undefined ||
        (enclosers.length > 0 && enclosers.every((e) => e.covered)),
    };
    memo.set(manifest, rung);
    return rung;
  }

  /** What a list is checked against: everything its resource drives for a
   *  scope list, the handler's union for a site's. */
  unionOf(list: CatchList): ThrowsUnion {
    let union = this.unions.get(list);
    if (!union) {
      union = list.isScope
        ? resolveScopeUnion(list.manifest, list.definition, this.resolveCtx)
        : this.handlerUnion(list.handler, this.moduleOf(list.manifest), list.scopeResolver);
      this.unions.set(list, union);
    }
    return union;
  }

  /** A handler's effective throw union. Prefers the named manifest (so an
   *  `inherit: true` handler exposes its transitive union); falls back to the
   *  kind's own declared codes when no name is given. */
  private handlerUnion(
    handler: unknown,
    ownerModule: string | undefined,
    scopeResolver: AliasResolver | undefined,
  ): ThrowsUnion {
    const ctx = this.resolveCtx;
    if (isRefSentinel(handler)) {
      const target = resolveRefManifest(handler, ctx, ownerModule);
      return target ? resolveThrowsUnion(target, ctx) : { codes: new Map(), unbounded: false };
    }
    const handlerRef = handlerRefOf(handler);
    if (!handlerRef) return { codes: new Map(), unbounded: false };
    if (handlerRef.name) {
      const resolvedKind = scopeResolver?.resolveKind(handlerRef.kind) ?? ctx.aliases.resolveKind(handlerRef.kind);
      const targetManifest = ctx.allManifests.find(
        (m) =>
          m.metadata?.name === handlerRef.name &&
          (m.kind === handlerRef.kind ||
            m.kind === resolvedKind ||
            scopeResolver?.resolveKind(m.kind) === handlerRef.kind ||
            ctx.aliases.resolveKind(m.kind) === handlerRef.kind),
      );
      if (targetManifest) return resolveThrowsUnion(targetManifest, ctx);
    }
    const resolved = scopeResolver?.resolveKind(handlerRef.kind) ?? ctx.aliases.resolveKind(handlerRef.kind);
    const def = ctx.defs.resolve(handlerRef.kind) ?? (resolved ? ctx.defs.resolve(resolved) : undefined);
    if (!def?.throws) return { codes: new Map(), unbounded: false };
    const codes = new Map<string, ThrowsCodeMeta>();
    for (const [c, meta] of Object.entries(def.throws.codes ?? {})) {
      codes.set(c, { data: (meta as { data?: Record<string, any> }).data });
    }
    const unbounded = def.throws.passthrough === true || def.throws.inherit === true;
    return { codes, unbounded };
  }

  /** A manifest's definition — a scoped declaration's kind is written in the
   *  alias scope of the module that declared the ENCLOSING resource. */
  definitionOf(manifest: ResourceManifest): ResourceDefinition | undefined {
    const anchor = this.scopedBy.get(manifest)?.owner ?? manifest;
    const scopeResolver = this.scopeResolverOf(anchor);
    const resolvedKind = scopeResolver?.resolveKind(manifest.kind) ?? this.aliases.resolveKind(manifest.kind);
    return this.defs.resolve(manifest.kind) ?? (resolvedKind ? this.defs.resolve(resolvedKind) : undefined);
  }

  private moduleOf(manifest: ResourceManifest): string | undefined {
    return ((this.scopedBy.get(manifest)?.owner ?? manifest).metadata as { module?: string } | undefined)
      ?.module;
  }

  private scopeResolverOf(manifest: ResourceManifest): AliasResolver | undefined {
    return scopeResolverForModule(
      (manifest.metadata as { module?: string } | undefined)?.module,
      this.rootModules,
      this.aliasesByModule,
    );
  }
}
