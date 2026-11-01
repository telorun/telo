/**
 * **`CALLABLE_REFERENCE_NOT_DATA`** — what a native function's data site may
 * hold, the static half of the kernel's delivery at creation.
 *
 * At `create()` a native callable's data site (`callable-data-slot.ts`) is
 * handed the referent's configuration as its controller received it, every
 * reference inside replaced the same way. That configuration is data only when
 * nothing in it is still to be produced: an expression evaluated after creation
 * (a runtime-eval field, a CEL region, a step or function body), a scope whose
 * resources its controller creates later, a need — supplied from outside the
 * manifest when the application loads — or a reference cycle, which would make
 * the configuration contain itself. Each is refused at the callable's slot. An
 * accessor field is data: what it holds is a binding.
 *
 * Entry-module-scoped and anchored at the callable instance's slot — inside the
 * resource declaring its scope for a `with:` member, whose references resolve
 * among its scope's members first, as the kernel resolves them — the
 * `X_TELO_REF_UNRESOLVED` posture: a dependency's callable is that dependency's
 * own `telo check`, and the kernel refuses it at boot. Referents resolve through
 * the projection scope — the flat set, then a library's own documents, then a
 * resource input continued to what the import supplies. A library's resource
 * input is a stand-in its own pass cannot judge, so it is skipped there and
 * judged at each `imports:` entry of the entry's modules that supplies it,
 * against the declaration supplied.
 *
 * A native function written as an entry of a template body is judged at the
 * `Telo.Definition` declaring the body, against what the template's child
 * context gives it (`template-body-lookup.ts`): a sibling entry and an export
 * through the defining module's imports are judged as referents; a resource of
 * the defining module is refused, since the body does not reach it; an
 * expression the template evaluates before the entry is created is data. What
 * a consumer forwards with a bare `self.<path>` is the consumer's: judged in
 * the consumer's pass, on the forward views (`template-forward.ts`), where it
 * lands at the function itself or in a sibling the function holds.
 *
 * Linear: a declaration is judged once per pass.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import {
  callableReferenceNotDataMessage,
  isDataSite,
  isNativeCallableKind,
  type NotData,
} from "./callable-data-slot.js";
import { celEvalModeAt, governedCelEvalSites, type NamedShapeLookup } from "./eval-paths.js";
import type { DefResolver } from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isKindDocument } from "./kind-declaration.js";
import type { LibraryDeclarations } from "./library-declarations.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { injectedNeedOf, needTypeOf, readNeeds } from "./need-type.js";
import { importAnchoredDiagnostic } from "./reaching-import.js";
import type { ReachSite } from "./reference-reach.js";
import { isInlineDeclaration } from "./resolved-reference.js";
import { computedValue } from "./ref-slot-computed.js";
import { isInjectedDeclaration, readSuppliedResources } from "./resource-input.js";
import { declaredScopes, isScopeMember, type DeclaredScope } from "./scope-declarations.js";
import { templateBodyEntries } from "./template-body.js";
import {
  expandedAtTemplateInit,
  templateBodyReference,
  type TemplateBodyScope,
} from "./template-body-lookup.js";
import type { TemplateForwardViews } from "./template-forward.js";
import {
  readProjectionRef,
  type ProjectionScope,
  type ProjectionTrail,
} from "./schema-projection.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { scopeAddress, type ScopeAddress, type ScopeSite } from "./scope-address.js";
import { ScopedNameResolver } from "./scoped-name-resolver.js";
import { declaringScopeOf, isScopeMemberDeclaration } from "./scope-members.js";

const SOURCE = "telo-analyzer";
const CODE = "CALLABLE_REFERENCE_NOT_DATA";

export interface CallableDataInput {
  /** The flattened set the analysis runs over. */
  readonly manifests: readonly ResourceManifest[];
  readonly rootModules: ReadonlySet<string>;
  /** A kind resolved in the module that declared the document it is read off. */
  readonly resolveDef: DefResolver;
  /** The named-shape lookup the eval-site walk takes. */
  readonly shapes: NamedShapeLookup;
  /** The concrete reference and scope sites of a declaration, its kind resolved
   *  in its own module. */
  readonly sitesOf: (manifest: ResourceManifest) => readonly ReachSite[];
  readonly scope: ProjectionScope;
  readonly libraries?: LibraryDeclarations;
  readonly moduleDocuments: readonly ModuleDocuments[];
  /** The analysis's template forward views — what a consumer hands a template
   *  body, judged at the consumer's own paths. */
  readonly forwards?: TemplateForwardViews;
}

/** A refusal, whether the walk reached it through a library's resource input —
 *  what decides which pass reports it — and where in the declaration first
 *  judged the walk left it. */
interface Found extends NotData {
  readonly viaInput: boolean;
  readonly at: string;
}

/** One entry of a template body, as the template creates it: in the defining
 *  module. */
interface BodyEntry {
  readonly view: ResourceManifest;
  readonly prefix: string;
  /** Its literal name; undefined for one named by an expression. */
  readonly name: string | undefined;
  /** How a message names it — never an extraction's generated name. */
  readonly display: string;
  readonly label: string;
}

/** Where a declaration sits in a template body: its body, the entry holding
 *  it, and its path inside that entry — empty for the entry itself, the path to
 *  it for a member of a scope the entry declares. */
interface Placement {
  readonly body: Body;
  readonly entry: BodyEntry;
  readonly within: string;
}

/** A template body: its entries and the lookup they resolve references through. */
interface Body {
  readonly entries: readonly BodyEntry[];
  readonly byName: ReadonlyMap<string, BodyEntry>;
  readonly scope: TemplateBodyScope;
}

const moduleOf = (manifest: unknown): string | undefined => {
  const meta = (manifest as { metadata?: { module?: unknown; declaringModule?: unknown } } | undefined)
    ?.metadata;
  const module = meta?.declaringModule ?? meta?.module;
  return typeof module === "string" ? module : undefined;
};

const nameOf = (manifest: unknown): string =>
  String((manifest as { metadata?: { name?: unknown } } | undefined)?.metadata?.name ?? "<inline>");

const key = (module: string | undefined, name: string): string => scopeAddress(module, name).key;

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isInstanceDocument(manifest: ResourceManifest): boolean {
  return (
    typeof manifest.kind === "string" &&
    !isModuleKind(manifest.kind) &&
    manifest.kind !== "Telo.Import" &&
    !isKindDocument(manifest)
  );
}

export function validateCallableData(input: CallableDataInput): AnalysisDiagnostic[] {
  const { manifests, rootModules, resolveDef, sitesOf, scope, libraries, shapes } = input;

  // Every need a module declares, by the name a reference in that module writes.
  const needs = new Set<string>();
  for (const manifest of manifests) {
    if (isInjectedDeclaration(manifest) && injectedNeedOf(manifest)) {
      needs.add(key(moduleOf(manifest), nameOf(manifest)));
    }
  }
  for (const library of input.moduleDocuments) {
    for (const manifest of library.manifests) {
      if (!isModuleKind(manifest.kind)) continue;
      for (const need of readNeeds(manifest)) needs.add(key(library.module, need.name));
    }
  }
  const inputs = new Set<string>();
  for (const manifest of manifests) {
    if (isInjectedDeclaration(manifest) && !injectedNeedOf(manifest)) {
      inputs.add(key(moduleOf(manifest), nameOf(manifest)));
    }
  }
  const isInput = (module: string | undefined, name: string): boolean =>
    inputs.has(key(module, name)) || (module !== undefined && !!libraries?.isInput(module, name));
  // Every resource a module declares, by name — what a template body of that
  // module does not reach.
  const declared = new Set<string>();
  for (const manifest of manifests) {
    if (typeof manifest.kind !== "string" || isModuleKind(manifest.kind)) continue;
    if (manifest.kind === "Telo.Import" || isKindDocument(manifest)) continue;
    const name = manifest.metadata?.name;
    if (typeof name === "string") declared.add(key(moduleOf(manifest), name));
  }

  // Each body's entries, built once per definition; each entry → its body.
  const bodies = new WeakMap<object, Body | null>();
  const placements = new WeakMap<object, Placement>();
  // Where the template evaluates CEL in each entry, by its kind.
  const entrySites = new WeakMap<BodyEntry, ReturnType<typeof governedCelEvalSites> | null>();
  const sitesOfEntry = (entry: BodyEntry) => {
    if (!entrySites.has(entry)) {
      const definition = resolveDef(entry.view.kind, entry.view as unknown as ResourceDefinition);
      entrySites.set(entry, definition ? governedCelEvalSites(definition, resolveDef, shapes) ?? null : null);
    }
    return entrySites.get(entry) ?? undefined;
  };
  const bodyOf = (definition: ResourceManifest): Body | undefined => {
    const memo = bodies.get(definition);
    if (memo !== undefined) return memo ?? undefined;
    const module = moduleOf(definition);
    const raw = (definition as { resources?: unknown }).resources;
    const written = Array.isArray(raw) ? raw : [];
    const entries: BodyEntry[] = templateBodyEntries(definition).map(({ prefix, manifest, kind }) => {
      const meta = (manifest.metadata ?? {}) as { name?: unknown; xTeloOrigin?: unknown };
      const name = typeof meta.name === "string" ? meta.name : undefined;
      const extracted = meta.xTeloOrigin !== undefined;
      return {
        view: {
          ...manifest,
          metadata: { ...(manifest.metadata ?? {}), ...(module !== undefined ? { module } : {}) },
        } as ResourceManifest,
        prefix,
        name,
        display: extracted || name === undefined ? "<inline>" : name,
        label: extracted ? `the inline ${kind}` : `the ${kind} entry '${name ?? prefix}'`,
      };
    });
    if (entries.length === 0) {
      bodies.set(definition, null);
      return undefined;
    }
    const byName = new Map<string, BodyEntry>();
    for (const entry of entries) if (entry.name !== undefined) byName.set(entry.name, entry);
    const body: Body = {
      entries,
      byName,
      scope: {
        siblings: new Set(byName.keys()),
        dynamicSiblings: written.some((entry) => {
          const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
          return name !== undefined && typeof name !== "string";
        }),
        moduleDeclares: (name) => declared.has(key(module, name)),
      },
    };
    for (const entry of entries) placements.set(entry.view, { body, entry, within: "" });
    bodies.set(definition, body);
    return body;
  };

  // One verdict per declaration for a walk entering it through no input.
  const judged = new Map<object, Found | null>();
  // A `with:` scope member, and the scope it is declared in: a reference it
  // writes resolves through that scope's members, then each enclosing scope's,
  // before the module's.
  const scopeNames = new ScopedNameResolver<ResourceManifest>(
    manifests.filter(isScopeMemberDeclaration),
    { nameOf, moduleOf, scopeOf: declaringScopeOf },
  );
  const memberScope = new WeakMap<object, ScopeSite>();
  const memberAddress = new WeakMap<object, ScopeAddress>();
  /** Record what `declaration`'s scopes declare; each member with its own scope. */
  const declareScopes = (
    holder: ScopeAddress,
    scope: DeclaredScope,
    members: readonly (ResourceManifest | undefined)[],
  ): void => {
    const site: ScopeSite = { holder, field: scope.path };
    const declared = members.filter((m): m is ResourceManifest => m !== undefined);
    scopeNames.declareScope(site, declared);
    for (const member of declared) {
      memberScope.set(member, site);
      memberAddress.set(member, scopeAddress(site, nameOf(member)));
    }
  };

  const judgeValue = (
    value: unknown,
    holder: Record<string, any>,
    trail: ProjectionTrail | undefined,
    stack: readonly object[],
    viaInput: boolean,
  ): Found | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = judgeValue(item, holder, trail, stack, viaInput);
        if (found) return found;
      }
      return undefined;
    }
    if (isPlainContainer(value) && isInlineDeclaration(value)) {
      const module = moduleOf(holder);
      const inline = {
        ...(value as Record<string, unknown>),
        metadata: { ...((value as { metadata?: object }).metadata ?? {}), ...(module ? { module } : {}) },
      } as unknown as ResourceManifest;
      return judgeDeclaration(inline, "<inline>", trail, stack, viaInput);
    }
    const ref = readProjectionRef(value);
    if (!ref) return undefined;
    const module = moduleOf(holder);
    const local = !ref.alias || ref.alias === "Self";
    const placement = placements.get(holder);
    // A scope run's lookup reaches its own members first, then the lookup of
    // the context the scope opened in — in a template body, the body's.
    const site = memberScope.get(holder) ?? declaringScopeOf(holder);
    const scoped =
      site && (!ref.alias || (placement && local))
        ? scopeNames.resolve(ref.name, module, site)
        : undefined;
    if (scoped) return judgeDeclaration(scoped, ref.name, trail, stack, viaInput);
    if (placement) return judgeInBody(value, ref, placement.body, holder, trail, stack, viaInput);
    if (local && needs.has(key(module, ref.name))) {
      return { chain: [ref.name], reason: { kind: "need" }, viaInput, at: "" };
    }
    const throughInput = viaInput || (local && isInput(module, ref.name));
    const lookup = scope.resolveManifest(value, holder, trail);
    // A reference that names nothing, or several, is the reference check's to
    // report; a stand-in no import supplies here is judged where one does.
    if (!lookup || !("manifest" in lookup)) return undefined;
    return judgeDeclaration(
      lookup.manifest as ResourceManifest,
      ref.name,
      lookup.trail,
      stack,
      throughInput,
    );
  };

  /** True when the template's `init()` evaluates an expression a body
   *  declaration holds at `path`: its entry's kind does not defer the path, or
   *  the expression reads only `self`. */
  const expandedBeforeCreation = (
    placement: Placement,
    path: string,
    computed: { tag: string; source: string },
  ): boolean => {
    const inEntry = placement.within === "" ? path : `${placement.within}.${path}`;
    const sites = sitesOfEntry(placement.entry);
    const mode = sites ? celEvalModeAt(sites, inEntry) : null;
    return (mode !== "runtime" && mode !== "accessor") || expandedAtTemplateInit(computed);
  };

  /** A reference a template body entry writes, resolved as the template's
   *  child context resolves it. */
  const judgeInBody = (
    value: unknown,
    ref: { name: string; alias?: string },
    body: Body,
    holder: Record<string, any>,
    trail: ProjectionTrail | undefined,
    stack: readonly object[],
    viaInput: boolean,
  ): Found | undefined => {
    const target = templateBodyReference(ref, body.scope);
    switch (target.kind) {
      case "sibling": {
        const entry = body.byName.get(target.name)!;
        return judgeDeclaration(entry.view, entry.display, undefined, stack, viaInput);
      }
      case "import": {
        const lookup = scope.resolveManifest(value, holder, trail);
        if (!lookup || !("manifest" in lookup)) return undefined;
        return judgeDeclaration(
          lookup.manifest as ResourceManifest,
          ref.name,
          lookup.trail,
          stack,
          viaInput,
        );
      }
      case "module":
        return { chain: [target.name], reason: { kind: "module" }, viaInput, at: "" };
      default:
        return undefined;
    }
  };

  const judgeDeclaration = (
    manifest: ResourceManifest,
    name: string,
    trail: ProjectionTrail | undefined,
    stack: readonly object[],
    viaInput: boolean,
  ): Found | undefined => {
    if (stack.includes(manifest)) {
      return { chain: [name], reason: { kind: "cycle" }, viaInput, at: "" };
    }
    const memo = !viaInput && (!trail || trail.size === 0);
    if (memo && judged.has(manifest)) {
      const found = judged.get(manifest);
      return found ? { ...found, viaInput: viaInput || found.viaInput } : undefined;
    }
    const found = judgeFresh(manifest, name, trail, stack, viaInput);
    if (memo && found?.reason.kind !== "cycle") judged.set(manifest, found ?? null);
    return found;
  };

  const judgeFresh = (
    manifest: ResourceManifest,
    name: string,
    trail: ProjectionTrail | undefined,
    stack: readonly object[],
    viaInput: boolean,
  ): Found | undefined => {
    const definition = resolveDef(manifest.kind, manifest as unknown as ResourceDefinition);
    if (needTypeOf(definition)) return { chain: [name], reason: { kind: "need" }, viaInput, at: "" };
    // A kind that resolves to nothing is reported where it is written.
    if (!definition) return undefined;

    const sites = sitesOf(manifest);
    const referencePaths = new Set<string>();
    for (const site of sites) {
      if (site.scopes.length > 0 && site.data !== undefined) {
        return {
          chain: [name],
          reason: { kind: "scope", path: site.path },
          viaInput,
          at: site.path,
        };
      }
      if (site.refs.length > 0) referencePaths.add(site.path);
    }

    // A declaration in a template body is created after the template's
    // `init()` has evaluated every expression its entry's kind does not defer;
    // one deferred there reaches the declaration's own creation compiled.
    const placement = placements.get(manifest);
    const evalSites = governedCelEvalSites(definition, resolveDef, input.shapes);
    const expression = (node: unknown, path: string): Found | undefined => {
      if (referencePaths.has(path)) return undefined;
      const computed = computedValue(node);
      if (computed) {
        if (input.forwards?.evaluatedBefore(manifest, path)) return undefined;
        const mode = evalSites ? celEvalModeAt(evalSites, path) : null;
        const createdAsData = mode === "compile" || mode === "accessor";
        const data = placement ? expandedBeforeCreation(placement, path, computed) || createdAsData : createdAsData;
        return data
          ? undefined
          : {
              chain: [name],
              reason: { kind: "expression", path, tag: computed.tag },
              viaInput,
              at: path,
            };
      }
      if (!isPlainContainer(node)) return undefined;
      if (Array.isArray(node)) {
        for (let index = 0; index < node.length; index++) {
          const found = expression(node[index], `${path}[${index}]`);
          if (found) return found;
        }
        return undefined;
      }
      if (path !== "" && isInlineDeclaration(node)) return undefined;
      for (const [field, child] of Object.entries(node)) {
        if (path === "" && (field === "kind" || field === "metadata")) continue;
        const found = expression(child, path === "" ? field : `${path}.${field}`);
        if (found) return found;
      }
      return undefined;
    };
    const own = expression(manifest, "");
    if (own) return own;

    const inner = [...stack, manifest];
    for (const site of sites) {
      if (site.refs.length === 0) continue;
      const found = judgeValue(site.data, manifest as Record<string, any>, trail, inner, viaInput);
      if (found) return { ...found, chain: [name, ...found.chain], at: site.path };
    }
    return undefined;
  };

  /** Every sibling entry a value written in a body entry reaches through
   *  sibling references alone, with the names followed to it. */
  const siblingsHeld = (value: unknown, body: Body): { entry: BodyEntry; via: string[] }[] => {
    const out: { entry: BodyEntry; via: string[] }[] = [];
    const seen = new Set<BodyEntry>();
    const visit = (node: unknown, via: readonly string[]): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item, via);
        return;
      }
      const ref = readProjectionRef(node);
      if (!ref) return;
      const target = templateBodyReference(ref, body.scope);
      if (target.kind !== "sibling") return;
      const entry = body.byName.get(target.name)!;
      if (seen.has(entry)) return;
      seen.add(entry);
      const path = [...via, entry.display];
      out.push({ entry, via: path });
      for (const site of sitesOf(entry.view)) {
        if (site.refs.length > 0) visit(site.data, path);
      }
    };
    visit(value, []);
    return out;
  };

  /** Every data site of a native callable instance, with what each holds. */
  const dataSites = (manifest: ResourceManifest): ReachSite[] => {
    const definition = resolveDef(manifest.kind, manifest as unknown as ResourceDefinition);
    if (!isNativeCallableKind(definition, resolveDef)) return [];
    return sitesOf(manifest).filter((site) => isDataSite(site, manifest));
  };

  const diagnostics: AnalysisDiagnostic[] = [];
  const label = (manifest: ResourceManifest) => `${manifest.kind}/${nameOf(manifest)}`;

  // The entry's own callables, at the slot — a scope member's included, which
  // the analysis reports at its place inside the resource declaring the scope.
  for (const manifest of manifests) {
    const module = moduleOf(manifest);
    if (module !== undefined && !rootModules.has(module)) continue;
    if (!isInstanceDocument(manifest) || isInjectedDeclaration(manifest)) continue;
    if (isForwardedDeclaration(manifest)) continue;
    for (const site of dataSites(manifest)) {
      // A body entry's sibling, as one consumer instantiates it, is judged
      // below, where that consumer wrote what it holds.
      if (input.forwards?.holdsSiblingReference(manifest, site.path)) continue;
      const found = judgeValue(site.data, manifest as Record<string, any>, undefined, [manifest], false);
      if (!found) continue;
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        code: CODE,
        source: SOURCE,
        message: callableReferenceNotDataMessage(label(manifest), site.path, found),
        data: {
          resource: { kind: manifest.kind, name: nameOf(manifest) },
          filePath: (manifest.metadata as { source?: string } | undefined)?.source,
          path: site.path,
        },
      });
    }
  }

  // A native function written as an entry of a template body, at the definition
  // declaring the body.
  for (const definition of manifests) {
    if (definition.kind !== "Telo.Definition") continue;
    const module = moduleOf(definition);
    if (module !== undefined && !rootModules.has(module)) continue;
    const body = bodyOf(definition);
    if (!body) continue;
    const judgeInBodyAt = (declaration: ResourceManifest, holder: string, at: string): void => {
      for (const site of dataSites(declaration)) {
        const found = judgeValue(site.data, declaration as Record<string, any>, undefined, [declaration], false);
        if (!found) continue;
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          code: CODE,
          source: SOURCE,
          message: `${label(definition)}: ${callableReferenceNotDataMessage(holder, site.path, found)}`,
          data: {
            resource: { kind: definition.kind, name: nameOf(definition) },
            filePath: (definition.metadata as { source?: string } | undefined)?.source,
            path: `${at}.${site.path}`,
          },
        });
      }
    };
    // A member of a scope an entry declares, at any depth, anchored at the
    // member inside the entry.
    const visitBodyScopes = (
      entry: BodyEntry,
      declaration: ResourceManifest,
      address: ScopeAddress,
      within: string,
    ): void => {
      for (const declared of declaredScopes(sitesOf(declaration))) {
        const members = declared.declarations.map((member) =>
          isScopeMember(member)
            ? ({
                ...member,
                metadata: { ...member.metadata, ...(module !== undefined ? { module } : {}) },
              } as ResourceManifest)
            : undefined,
        );
        declareScopes(address, declared, members);
        const at = (index: number) => `${within === "" ? "" : `${within}.`}${declared.path}[${index}]`;
        members.forEach((member, index) => {
          if (!member) return;
          placements.set(member, { body, entry, within: at(index) });
        });
        members.forEach((member, index) => {
          if (!member || isKindDocument(member)) return;
          judgeInBodyAt(
            member,
            `the ${member.kind} '${nameOf(member)}' declared in ${entry.label}`,
            `${entry.prefix}.${at(index)}`,
          );
          visitBodyScopes(entry, member, memberAddress.get(member)!, at(index));
        });
      }
    };
    for (const entry of body.entries) {
      judgeInBodyAt(entry.view, entry.label, entry.prefix);
      // An entry is addressed by its place in the body, which no resource
      // name can spell.
      visitBodyScopes(
        entry,
        entry.view,
        scopeAddress(module, `${nameOf(definition)}.${entry.prefix}`),
        "",
      );
    }
  }

  // What a consumer forwards into a sibling a body's native function holds —
  // the function's own forwards are its view's, judged above as any function.
  // Reported on the sibling's view, at the forwarded path, which the views move
  // to the consumer's own path.
  if (input.forwards) {
    const reported = new Set<string>();
    for (const [holder, runner] of input.forwards.holders()) {
      const body = bodyOf(runner as unknown as ResourceManifest);
      if (!body) continue;
      for (const fn of body.entries) {
        for (const site of dataSites(fn.view)) {
          for (const { entry, via } of siblingsHeld(site.data, body)) {
            if (entry === fn || entry.name === undefined) continue;
            const view = input.forwards.viewFor(holder, entry.name);
            if (!view) continue;
            const found = judgeDeclaration(view, entry.display, undefined, [], false);
            if (!found) continue;
            const identity = `${nameOf(view)}\0${found.at}\0${fn.prefix}`;
            if (reported.has(identity)) continue;
            reported.add(identity);
            diagnostics.push({
              severity: DiagnosticSeverity.Error,
              code: CODE,
              source: SOURCE,
              message: callableReferenceNotDataMessage(fn.label, site.path, {
                chain: [...via, ...found.chain.slice(1)],
                reason: found.reason,
              }),
              data: {
                resource: { kind: view.kind, name: nameOf(view) },
                filePath: (view.metadata as { source?: string } | undefined)?.source,
                path: found.at,
              },
            });
          }
        }
      }
    }
  }

  // A library's callables reaching one of its resource inputs, at each import
  // of the entry's own modules that supplies it.
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
      if (!isInstanceDocument(manifest)) continue;
      for (const site of dataSites(manifest)) {
        const found = judgeValue(site.data, manifest as Record<string, any>, trail, [manifest], false);
        if (!found?.viaInput) continue;
        diagnostics.push(
          importAnchoredDiagnostic(
            CODE,
            target,
            anchor,
            callableReferenceNotDataMessage(label(manifest), site.path, found),
          ),
        );
      }
    }
  }

  return diagnostics;
}
