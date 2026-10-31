/**
 * `x-telo-text-catalog-set` at `telo check` — the static half of the kernel's
 * judgement before a holder's `create()` (`text-catalog-set.ts` is the reader
 * both halves share).
 *
 * - **At the kind**: a mark whose value is not `true` (`SCHEMA_VIOLATION`), one
 *   reaching neither a text catalog nor a reference slot, or one nested under
 *   another (`TEXT_CATALOG_SET_INVALID`) — at the definition for the entry's own
 *   modules, and for every imported library's — exported or not, read from its
 *   full documents — at the `imports:` entry reaching it, since the kernel refuses
 *   the definition when it registers it.
 * - **At a resource**: one text and context translated twice in one language
 *   across its set (`MESSAGE_ENTRY_DUPLICATE`), at the reference — or inline
 *   catalog — bringing in the later occurrence. Entry-module-scoped: a
 *   dependency's resources are refused by the kernel when they are created.
 *   References resolve through the projection scope. A library's resource input
 *   is a stand-in its own pass cannot read, so a set reaching one is judged
 *   without it there, and again at each `imports:` entry of the entry's modules
 *   that supplies it, against the declaration supplied — reporting what the
 *   input brings in.
 *
 * - **Where a set is written but not declared at the top level**: a member of a
 *   `with:` scope at any depth — anchored at the member inside the resource
 *   declaring the scope, its references resolving among its scope's members
 *   first, as the kernel resolves them — and an entry of a template body, or a
 *   member of a scope an entry declares, judged at the `Telo.Definition`
 *   declaring the body, its references resolving as the template's child context
 *   resolves them (`template-body-lookup.ts`): a sibling entry, or an export
 *   through the defining module's imports. What a consumer forwards into an
 *   entry with a bare `self.<path>` is judged on the forward view, together with
 *   what the entry writes itself — the set the entry gathers at creation — and
 *   reported at the consumer's own path.
 *
 * Linear in the catalogs' entries. Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isKindDocument } from "./kind-declaration.js";
import type { LibraryDeclarations } from "./library-declarations.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { importAnchoredDiagnostic, type ReachingImport } from "./reaching-import.js";
import type { ReachSite } from "./reference-reach.js";
import { isInlineDeclaration } from "./resolved-reference.js";
import { isInjectedDeclaration, readSuppliedResources } from "./resource-input.js";
import { readProjectionRef, type ProjectionScope, type ProjectionTrail } from "./schema-projection.js";
import {
  declaresTextCatalogSet,
  textCatalogSetDuplicates,
  textCatalogSetMembers,
  textCatalogSetProblems,
  type NamedShapeResolver,
  type TextCatalogSetHost,
} from "./text-catalog-set.js";
import { declaredScopes, isScopeMember } from "./scope-declarations.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import { ScopedNameResolver } from "./scoped-name-resolver.js";
import { declaringScopeOf, isScopeMemberDeclaration } from "./scope-members.js";
import { templateBodyEntries } from "./template-body.js";
import { templateBodyReference, type TemplateBodyScope } from "./template-body-lookup.js";
import { templateForwardsOf, type TemplateForwardViews } from "./template-forward.js";
import { renderValuePath } from "./text-slot.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

export interface TextCatalogSetInput {
  /** The flattened set the analysis runs over. */
  readonly manifests: readonly ResourceManifest[];
  readonly rootModules: ReadonlySet<string>;
  /** The configuration schema a declaration's kind declares, resolved in the
   *  module that declared it. */
  readonly schemaOf: (manifest: ResourceManifest) => Record<string, any> | undefined;
  readonly resolveRef: NamedShapeResolver;
  readonly sitesOf: (manifest: ResourceManifest) => readonly ReachSite[];
  readonly scope: ProjectionScope;
  readonly libraries?: LibraryDeclarations;
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** True for a catalog value the `TextCatalog` fragment accepts. */
  readonly accepts: (catalog: unknown) => boolean;
  readonly isExpression: (value: unknown) => boolean;
  /** The `imports:` entry through which a dependency's module is first reached. */
  readonly reachOf: (module: string) => ReachingImport | undefined;
  /** The template forward views the analysis carries. */
  readonly forwards?: TemplateForwardViews;
}

/** A declaration as the walk holds it: the trail its references continue
 *  through, and whether it was reached through a library's resource input. */
interface Held {
  readonly manifest: ResourceManifest;
  readonly trail?: ProjectionTrail;
  readonly throughInput: boolean;
}

/** A template body: its entries as the template creates them, and the lookup
 *  their references resolve through. */
interface Body {
  readonly byName: ReadonlyMap<string, ResourceManifest>;
  readonly scope: TemplateBodyScope;
}

interface BodyEntry {
  readonly kind: string;
  readonly prefix: string;
  /** The entry, stamped as a declaration of the defining module. */
  readonly view: ResourceManifest;
}

type Segments = readonly (string | number)[];

function valueAtSegments(root: unknown, at: Segments): unknown {
  let node = root;
  for (const segment of at) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

/** `root` with every container on the way to each path copied, so a value set
 *  there leaves `root` as it was. */
function cloneAlong(root: unknown, paths: readonly Segments[]): unknown {
  const copy = (node: unknown): unknown =>
    Array.isArray(node) ? [...node] : node && typeof node === "object" ? { ...(node as object) } : node;
  const out = copy(root);
  for (const path of paths) {
    let node = out as Record<string | number, unknown>;
    for (const segment of path.slice(0, -1)) {
      const child = copy(node[segment]);
      if (!child || typeof child !== "object") break;
      node[segment] = child;
      node = child as Record<string | number, unknown>;
    }
  }
  return out;
}

function setAtSegments(root: unknown, at: Segments, value: unknown): void {
  const holder = valueAtSegments(root, at.slice(0, -1));
  if (holder && typeof holder === "object") (holder as Record<string | number, unknown>)[at[at.length - 1]!] = value;
}

const moduleOf = (manifest: unknown): string | undefined => {
  const meta = (manifest as { metadata?: { module?: unknown; declaringModule?: unknown } } | undefined)?.metadata;
  const module = meta?.declaringModule ?? meta?.module;
  return typeof module === "string" ? module : undefined;
};

const nameOf = (manifest: unknown): string =>
  String((manifest as { metadata?: { name?: unknown } } | undefined)?.metadata?.name ?? "<inline>");

const sourceOf = (manifest: ResourceManifest): string | undefined =>
  (manifest.metadata as { source?: string } | undefined)?.source;

function isInstanceDocument(manifest: ResourceManifest): boolean {
  return (
    typeof manifest.kind === "string" &&
    !isModuleKind(manifest.kind) &&
    manifest.kind !== "Telo.Import" &&
    !isKindDocument(manifest)
  );
}

/** How a message names a body entry — never an extraction's generated name. */
function entryLabelOf(kind: string, entry: ResourceManifest): string {
  const meta = (entry.metadata ?? {}) as { name?: unknown; xTeloOrigin?: unknown };
  return meta.xTeloOrigin !== undefined ? `the inline ${kind}` : `the ${kind} entry '${String(meta.name)}'`;
}

export function validateTextCatalogSets(input: TextCatalogSetInput): AnalysisDiagnostic[] {
  const { manifests, rootModules, scope, libraries } = input;
  const diagnostics: AnalysisDiagnostic[] = [];

  // The kinds: each definition once, wherever it is forwarded from.
  const judgedKinds = new Set<string>();
  const kindDocuments = [...manifests, ...input.moduleDocuments.flatMap((library) => library.manifests)];
  for (const definition of kindDocuments) {
    if (definition.kind !== "Telo.Definition" && definition.kind !== "Telo.Abstract") continue;
    const module = moduleOf(definition);
    const kindName = nameOf(definition);
    const id = `${module ?? ""}\0${kindName}`;
    if (judgedKinds.has(id)) continue;
    judgedKinds.add(id);
    const via = module !== undefined && !rootModules.has(module) ? input.reachOf(module) : undefined;
    if (module !== undefined && !rootModules.has(module) && !via) continue;
    for (const problem of textCatalogSetProblems(kindName, definition.schema, input.resolveRef)) {
      const message = `${definition.kind} ${problem.message}`;
      diagnostics.push(
        via
          ? importAnchoredDiagnostic(problem.code, module!, via, message)
          : {
              severity: DiagnosticSeverity.Error,
              code: problem.code,
              source: SOURCE,
              message,
              data: {
                resource: { kind: definition.kind, name: kindName },
                filePath: sourceOf(definition),
                path: problem.path,
              },
            },
      );
    }
  }

  const inputs = new Set<string>();
  for (const manifest of manifests) {
    if (isInjectedDeclaration(manifest)) inputs.add(scopeAddress(moduleOf(manifest), nameOf(manifest)).key);
  }
  const isInput = (module: string | undefined, name: string): boolean =>
    inputs.has(scopeAddress(module, name).key) || (module !== undefined && !!libraries?.isInput(module, name));

  const identities = new WeakMap<object, unknown>();
  // A `with:` scope member, and the scope it is declared in: a reference it
  // writes resolves through that scope's members, then each enclosing scope's.
  const scopeNames = new ScopedNameResolver<ResourceManifest>(
    manifests.filter(isScopeMemberDeclaration),
    { nameOf, moduleOf, scopeOf: declaringScopeOf },
  );
  const memberScope = new WeakMap<object, ScopeSite>();
  // A declaration written in a template body, and the body it is created in.
  const placements = new WeakMap<object, Body>();
  // A value a consumer forwarded into a body entry, and the view it resolves in.
  const forwardedFrom = new WeakMap<object, ResourceManifest>();
  const markForwarded = (value: unknown, view: ResourceManifest): void => {
    if (!value || typeof value !== "object" || forwardedFrom.has(value)) return;
    forwardedFrom.set(value, view);
    for (const child of Object.values(value as Record<string, unknown>)) markForwarded(child, view);
  };
  const host: TextCatalogSetHost<Held> = {
    isExpression: input.isExpression,
    schemaOf: (held) => {
      const schema = input.schemaOf(held.manifest);
      return schema ? { schema, resolveRef: input.resolveRef } : undefined;
    },
    configurationOf: (held) => held.manifest,
    referenceSites: (held) =>
      input
        .sitesOf(held.manifest)
        .filter((site) => site.refs.length > 0)
        .map((site) => ({ keys: site.keys, data: site.data })),
    resolve: (held, value) => {
      const origin = value && typeof value === "object" ? forwardedFrom.get(value) : undefined;
      if (origin && origin !== held.manifest) return host.resolve({ manifest: origin, throughInput: held.throughInput }, value);
      if (value && typeof value === "object" && !Array.isArray(value) && isInlineDeclaration(value)) {
        const module = moduleOf(held.manifest);
        const inline = {
          ...(value as Record<string, unknown>),
          metadata: { ...((value as { metadata?: object }).metadata ?? {}), ...(module ? { module } : {}) },
        } as unknown as ResourceManifest;
        identities.set(inline, value);
        const body = placements.get(held.manifest);
        if (body) placements.set(inline, body);
        const site = memberScope.get(held.manifest) ?? declaringScopeOf(held.manifest);
        if (site) memberScope.set(inline, site);
        return { manifest: inline, trail: held.trail, throughInput: held.throughInput };
      }
      const ref = readProjectionRef(value);
      if (!ref) return undefined;
      const local = !ref.alias || ref.alias === "Self";
      const body = placements.get(held.manifest);
      // A scope run's lookup reaches its own members first, then the lookup of
      // the context the scope opened in — in a template body, the body's.
      const site = memberScope.get(held.manifest) ?? declaringScopeOf(held.manifest);
      const scoped =
        site && (!ref.alias || (body && local))
          ? scopeNames.resolve(ref.name, moduleOf(held.manifest), site)
          : undefined;
      if (scoped) return { manifest: scoped, trail: held.trail, throughInput: held.throughInput };
      if (body) {
        const target = templateBodyReference(ref, body.scope);
        if (target.kind === "sibling") {
          return { manifest: body.byName.get(target.name)!, throughInput: held.throughInput };
        }
        // A resource of the defining module is not reached from a body.
        if (target.kind !== "import") return undefined;
      }
      const throughInput = held.throughInput || (local && isInput(moduleOf(held.manifest), ref.name));
      // A reference naming nothing, or several, is the reference check's to
      // report; a stand-in no import supplies here is judged where one does.
      const lookup = scope.resolveManifest(value, held.manifest, held.trail);
      if (!lookup || !("manifest" in lookup)) return undefined;
      const manifest = lookup.manifest as ResourceManifest;
      if (isInjectedDeclaration(manifest)) return undefined;
      return { manifest, trail: lookup.trail, throughInput };
    },
    identityOf: (held) => {
      if (
        placements.has(held.manifest) ||
        memberScope.has(held.manifest) ||
        isScopeMemberDeclaration(held.manifest)
      ) {
        return held.manifest;
      }
      const module = moduleOf(held.manifest);
      const name = held.manifest.metadata?.name;
      return typeof name === "string" && module !== undefined
        ? scopeAddress(module, name).key
        : (identities.get(held.manifest) ?? held.manifest);
    },
    labelOf: (held) => `${held.manifest.kind}/${nameOf(held.manifest)}`,
    accepts: input.accepts,
  };

  const holds = (manifest: ResourceManifest): boolean => declaresTextCatalogSet(input.schemaOf(manifest));

  /** Every duplicate of `declaration`'s set, reported on `root` — the resource
   *  or definition holding it — at `prefix` before the set's own path. */
  const judgeHolder = (root: ResourceManifest, declaration: ResourceManifest, prefix: string, label?: string): void => {
    if (!holds(declaration)) return;
    const holder: Held = { manifest: declaration, throughInput: false };
    for (const duplicate of textCatalogSetDuplicates(textCatalogSetMembers(holder, host), host)) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "MESSAGE_ENTRY_DUPLICATE",
        source: SOURCE,
        message: label ? `${label}: ${duplicate.message}` : duplicate.message,
        data: {
          resource: { kind: root.kind, name: nameOf(root) },
          filePath: sourceOf(root),
          path: `${prefix}${renderValuePath(duplicate.at)}`,
        },
      });
    }
  };

  /** The members of every scope `declaration` declares, at any depth, each with
   *  the names its scope run sees, judged on `root` at the member's path. */
  const visitScopes = (
    root: ResourceManifest,
    declaration: ResourceManifest,
    address: ScopeAddress,
    module: string | undefined,
    prefix: string,
    body: Body | undefined,
    label: (member: ResourceManifest) => string,
  ): void => {
    for (const scope of declaredScopes(input.sitesOf(declaration))) {
      const site: ScopeSite = { holder: address, field: scope.path };
      const members = scope.declarations.map((entry) =>
        isScopeMember(entry)
          ? ((module !== undefined ? { ...entry, metadata: { ...entry.metadata, module } } : entry) as ResourceManifest)
          : undefined,
      );
      scopeNames.declareScope(
        site,
        members.filter((m): m is ResourceManifest => m !== undefined),
      );
      members.forEach((member) => {
        if (!member || isKindDocument(member)) return;
        memberScope.set(member, site);
        if (body) placements.set(member, body);
      });
      members.forEach((member, index) => {
        if (!member || isKindDocument(member)) return;
        const at = `${prefix}${scope.path}[${index}]`;
        judgeHolder(root, member, `${at}.`, label(member));
        visitScopes(root, member, scopeAddress(site, nameOf(member)), module, `${at}.`, body, label);
      });
    }
  };

  // A forward view's set is judged over its body entry with the forwards filled
  // in, below — never over the forwarded members alone.
  const views = new Set<ResourceManifest>(input.forwards?.manifests ?? []);
  const mergedViews = new Set<ResourceManifest>();

  // Every resource a module declares, by name — what a template body of that
  // module does not reach.
  const declared = new Set<string>();
  for (const manifest of manifests) {
    if (!isInstanceDocument(manifest)) continue;
    const name = manifest.metadata?.name;
    if (typeof name === "string") declared.add(`${moduleOf(manifest) ?? ""}\0${name}`);
  }

  /** A template body's entries, each a declaration of the defining module, and
   *  the lookup they resolve references through. */
  const bodies = new Map<object, { body: Body; entries: BodyEntry[] } | null>();
  const bodyOf = (definition: ResourceManifest): { body: Body; entries: BodyEntry[] } | undefined => {
    const memo = bodies.get(definition);
    if (memo !== undefined) return memo ?? undefined;
    const module = moduleOf(definition);
    const entries = templateBodyEntries(definition).map((entry) => ({
      kind: entry.kind,
      prefix: entry.prefix,
      view: {
        ...entry.manifest,
        metadata: { ...(entry.manifest.metadata ?? {}), ...(module !== undefined ? { module } : {}) },
      } as ResourceManifest,
    }));
    if (entries.length === 0) {
      bodies.set(definition, null);
      return undefined;
    }
    const written = (definition as { resources?: unknown[] }).resources ?? [];
    const byName = new Map<string, ResourceManifest>();
    for (const entry of entries) {
      const name = entry.view.metadata?.name;
      if (typeof name === "string") byName.set(name, entry.view);
    }
    const body: Body = {
      byName,
      scope: {
        siblings: new Set(byName.keys()),
        dynamicSiblings: written.some((entry) => {
          const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
          return name !== undefined && typeof name !== "string";
        }),
        moduleDeclares: (name) => declared.has(`${module ?? ""}\0${name}`),
      },
    };
    for (const entry of entries) placements.set(entry.view, body);
    const built = { body, entries };
    bodies.set(definition, built);
    return built;
  };

  // What a consumer forwards into a body entry, judged together with what the
  // entry writes itself: the entry as written, each bare `self.<path>` holding
  // the view's value there. Reported on the view, at a forwarded path — the
  // later occurrence's, else the earlier one's — which the views move to the
  // consumer's own path; a duplicate the body writes alone is the defining
  // module's finding.
  const judgeForwarded = (view: ResourceManifest, entry: ResourceManifest, body: Body): void => {
    const forwards = templateForwardsOf(entry);
    if (forwards.length === 0) return;
    mergedViews.add(view);
    const merged = cloneAlong(entry, forwards.map((forward) => forward.at)) as ResourceManifest;
    for (const forward of forwards) {
      const value = valueAtSegments(view, forward.at);
      if (value === undefined) continue;
      setAtSegments(merged, forward.at, value);
      markForwarded(value, view);
    }
    placements.set(merged, body);
    const forwarded = (path: readonly (string | number)[]): boolean =>
      forwards.some((forward) => forward.at.every((segment, index) => path[index] === segment));
    const holder: Held = { manifest: merged, throughInput: false };
    for (const duplicate of textCatalogSetDuplicates(textCatalogSetMembers(holder, host), host)) {
      const at = forwarded(duplicate.at) ? duplicate.at : forwarded(duplicate.first.at) ? duplicate.first.at : undefined;
      if (!at) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: "MESSAGE_ENTRY_DUPLICATE",
        source: SOURCE,
        message: duplicate.message,
        data: {
          resource: { kind: view.kind, name: nameOf(view) },
          filePath: sourceOf(view),
          path: renderValuePath(at),
        },
      });
    }
  };
  if (input.forwards) {
    for (const [holder, runner] of input.forwards.holders()) {
      const built = bodyOf(runner as unknown as ResourceManifest);
      if (!built) continue;
      for (const entry of built.entries) {
        const name = entry.view.metadata?.name;
        const view = typeof name === "string" ? input.forwards.viewFor(holder, name) : undefined;
        if (view) judgeForwarded(view, entry.view, built.body);
      }
    }
  }

  // The entry's own resources, scope members included — reported at
  // themselves, which the analysis moves inside the resource declaring the scope.
  for (const manifest of manifests) {
    const module = moduleOf(manifest);
    if (module !== undefined && !rootModules.has(module)) continue;
    if (!isInstanceDocument(manifest) || isInjectedDeclaration(manifest) || isForwardedDeclaration(manifest)) continue;
    if (!views.has(manifest) || !mergedViews.has(manifest)) judgeHolder(manifest, manifest, "");
  }

  // The entries of each template body the entry's own modules define, and the
  // members of the scopes they declare, at the definition declaring the body.
  for (const definition of manifests) {
    if (definition.kind !== "Telo.Definition") continue;
    const module = moduleOf(definition);
    if (module !== undefined && !rootModules.has(module)) continue;
    const built = bodyOf(definition);
    if (!built) continue;
    const { body, entries } = built;
    const prefix = `${definition.kind}/${nameOf(definition)}`;
    for (const entry of entries) {
      const entryLabel = entryLabelOf(entry.kind, entry.view);
      judgeHolder(definition, entry.view, `${entry.prefix}.`, `${prefix}: ${entryLabel}`);
      // An entry is addressed by its place in the body, which no resource
      // name can spell.
      visitScopes(
        definition,
        entry.view,
        scopeAddress(module, `${nameOf(definition)}.${entry.prefix}`),
        module,
        `${entry.prefix}.`,
        body,
        (member) => `${prefix}: the ${member.kind} '${nameOf(member)}' declared in ${entryLabel}`,
      );
    }
  }

  // A library's sets reaching one of its resource inputs, at each import of the
  // entry's own modules that supplies it.
  for (const entry of manifests) {
    if (entry.kind !== "Telo.Import") continue;
    const owner = moduleOf(entry);
    if (owner !== undefined && !rootModules.has(owner)) continue;
    const meta = entry.metadata as { name?: unknown; resolvedModuleName?: unknown; source?: string };
    const target = meta.resolvedModuleName;
    if (typeof target !== "string" || typeof meta.name !== "string") continue;
    if (Object.keys(readSuppliedResources(entry)).length === 0) continue;
    const library = input.moduleDocuments.find((documents) => documents.module === target);
    if (!library) continue;
    const trail: ProjectionTrail = new Map([[target, entry as Record<string, any>]]);
    const anchor = { alias: meta.name, filePath: meta.source, path: `imports.${meta.name}` };
    for (const manifest of library.manifests) {
      if (!isInstanceDocument(manifest) || isInjectedDeclaration(manifest) || !holds(manifest)) continue;
      const holder: Held = { manifest, trail, throughInput: false };
      for (const duplicate of textCatalogSetDuplicates(textCatalogSetMembers(holder, host), host)) {
        if (!duplicate.member.owner.throughInput && !duplicate.first.owner.throughInput) continue;
        diagnostics.push(
          importAnchoredDiagnostic(
            "MESSAGE_ENTRY_DUPLICATE",
            target,
            anchor,
            `${manifest.kind}/${nameOf(manifest)}: ${duplicate.message}`,
          ),
        );
      }
    }
  }

  return diagnostics;
}
