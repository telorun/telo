import { inlineStepTargetName, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import { inheritSchemaPlace } from "./schema-provenance.js";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  controllerBearingAncestor,
  hasOwnControllerOrTemplate,
  type DefResolver,
} from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import {
  stampLabel,
  withoutStamps,
  writtenMetadataStamps,
  writtenNestedStamps,
  type WrittenStampPlace,
} from "./metadata-stamps.js";
import { definitionInScope } from "./module-alias-scope.js";
import {
  asResolvedReference,
  declaresNameField,
  isInlineDeclaration,
  isLegacyReferenceForm,
  resolvedReference,
} from "./resolved-reference.js";
import { isValueAtSlot, type ValueBranchOutcome } from "./reference-field-map.js";
import { siteRefEntry, type ConditionedReachSite, type ReachSite } from "./reference-reach.js";
import { gatherPropertySchemas } from "./schema-walk.js";
import {
  declaredScopes,
  keysUnder,
  outsideScopesOf,
  scopeEncloses,
  scopeMembers,
  type DeclaredScope,
  type OutsideScope,
} from "./scope-declarations.js";
import { forEachStep, stepBodiesOf } from "./step-bodies.js";
import { readStepSlot } from "./step-slot.js";

const SYSTEM_KINDS = new Set([
  "Telo.Definition",
  "Telo.Application",
  "Telo.Library",
  "Telo.Import",
]);

/**
 * System kinds are excluded from inline extraction by default, but a single slot
 * may opt back in with `x-telo-inline: true` — `Telo.Application.logging.sinks`
 * is the case this exists for.
 *
 * The opt-in is per slot rather than per kind because this pass runs *upstream*
 * of schema validation on both the analyzer and runtime paths. Admitting the
 * whole Application document would rewrite an inline `{kind, ...}` in `targets`
 * into a valid `{kind, name}` before AJV ever saw it, silently converting a
 * deliberate rejection into a working feature.
 */
export function acceptsInline(resourceKind: string, entry: { inline?: boolean }): boolean {
  return !SYSTEM_KINDS.has(resourceKind) || entry.inline === true;
}

/** Replaces characters outside [a-zA-Z0-9_] with underscores. */
function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Deep-clones a manifest value tree so the in-place rewrites this module and
 *  `resolveRefSentinels` perform never reach caller-owned objects. Compiled-CEL
 *  nodes (`{__compiled, source, call?}`) are opaque leaves carrying functions —
 *  copied by reference, never descended into — matching how `resolveRefSentinels`
 *  and `manifest-visitor` short-circuit on `__compiled`. */
export function cloneForMutation(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if ((value as { __compiled?: unknown }).__compiled) return value;
  // A copy is written where its source is (`schema-provenance.ts`).
  if (Array.isArray(value)) return inheritSchemaPlace(value.map(cloneForMutation), value);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = cloneForMutation((value as Record<string, unknown>)[key]);
  }
  return inheritSchemaPlace(out, value);
}

type NamedManifest = ResourceManifest & { metadata: { name: string } };

/** What an extraction inherits from the declaration it was written in: the
 *  module its kinds are written in, whether it is a dependency's code, and the
 *  declaring module's config contract its CEL is typed against. */
interface Provenance {
  module: string | undefined;
  forwarded: boolean;
  moduleGlobals: unknown;
  /** The module instance a dependency's copy belongs to (`metadata.importPath`). */
  importPath: unknown;
}

/** Where a declaration is written: the top-level document (or template
 *  definition) holding it, and its place there (`""` for the document itself). */
interface WrittenPlace {
  root: ResourceManifest;
  path: string;
}

/** The nearest declaration enclosing a nested one whose name the author wrote —
 *  what a refusal about the nested one is labelled by — and its place. */
interface Labelling {
  label: string;
  at: string;
}

const joinPath = (prefix: string, rest: string): string =>
  !prefix ? rest : rest.startsWith("[") ? `${prefix}${rest}` : `${prefix}.${rest}`;

/** A declaration waiting to have its inline slots extracted. */
interface Declaration extends Provenance {
  manifest: NamedManifest;
  written: WrittenPlace;
  labelling: Labelling;
  /** The set it is declared in — the module's top level (undefined), or the
   *  `x-telo-scope` array holding it. What it declares inline joins the same set
   *  unless the slot lies in a region of a scope it declares itself. */
  home: unknown[] | undefined;
  /** Scopes it is lexically inside and not created in — see {@link OutsideScope}.
   *  Whatever it declares inline is created where it is, so inherits them. */
  outside: OutsideScope[];
  /** A template body entry, or an extraction from one. A `use: schema` slot is
   *  left inline there: a shape is resolved where it is written, never looked up
   *  as a sibling. */
  inBody?: true;
  /** For a template body entry: the definition and the entry's index in it. */
  bodyOf?: { definition: ResourceManifest; index: number };
  /** Where it holds, over classes — absent wherever its holder holds. */
  presence?: unknown;
}

/** What `metadata.xTeloOrigin` records: where an extracted declaration was
 *  written, so a diagnostic about it anchors in its author's document. */
interface Origin {
  parentKind: string;
  parentName: string;
  /** Concrete dotted path with `[N]` indices, matching `buildPositionIndex` keys
   *  (e.g. `routes[0].handler`). */
  pathFromParent: string;
  /** The same place as its keys and indices — exact for a key holding a dot.
   *  Absent on a step's dispatch target, which is identified by name. */
  keysFromParent?: (string | number)[];
  /** Set on a step's dispatch target, whose identity is its path-derived name
   *  alone — see `inlineStepTargetName`. */
  stepTarget?: true;
  /** Set on a step's dispatch target whose name the author wrote; every other
   *  extraction's name is generated, so no message lists it and no expression
   *  reads it. */
  named?: true;
  outsideScopes?: OutsideScope[];
}

/**
 * Phase 2 — Inline resource normalization.
 *
 * Every inline declaration (a `{kind, …config}` that is not a resolved reference —
 * `resolved-reference.ts`) is extracted as a first-class manifest under a
 * deterministic name and replaced in place with a resolved reference to it. Two
 * kinds of slot carry one:
 *
 *  - a REFERENCE slot, at a concrete site of the kind's reach
 *    (`reference-reach.ts`), named
 *    `{parentName}_{pathSegment}[_{itemName|index}]_{fieldName}`
 *    (`TestBasicAddition_steps_AddTwoNumbers_invoke`);
 *  - a STEP's dispatch target, at any nesting depth of a step body, named by
 *    `inlineStepTargetName` — the name the step engine has always registered it
 *    under, which is durable identity and so must not move with the extraction.
 *
 * Step slots are found through the kind's step-body annotation and walked with
 * `walkStepArray`: the reach stops at a step body, since a step's target
 * resolves at dispatch rather than by Phase-5 substitution.
 *
 * The legacy `{ kind, name }` reference form — an object whose kind declares no
 * top-level `name` field — at either kind of slot is no inline declaration: it
 * is marked in place as the resolved reference it means (`resolved-reference.ts`)
 * and never extracted. Published artifacts carry the spelling, so a dependency's
 * keeps working; the entry's own modules are refused for writing it
 * (`INVALID_REFERENCE_FORM`, judged on the raw set before this pass).
 *
 * Every extracted manifest is queued in turn, so an inline declaration nested in
 * another's slots — a handler inside an inline step target — is extracted too.
 * So is every member of an `x-telo-scope` array, which is a declaration of its
 * own.
 *
 * WHERE an extraction is created:
 *
 *  - a reference slot lying in a region of a scope its owner declares (a
 *    sequence's `targets:`) resolves against that scope, so its declaration
 *    joins the scope's array and is created per scope run;
 *  - a step target is created where its owner is — the module's top level, or
 *    the scope array holding a scope member — and never in a scope the owner
 *    declares, because that would make every step target of a sequence with a
 *    `with:` block a scoped resource and move its durable identity;
 *  - any other extraction is created where its owner is.
 *
 * A declaration written inside a scope's region and created outside it records
 * the scope (`xTeloOrigin.outsideScopes`), and `validateScopedNameReach` reports
 * a reference from it to a name that scope declares.
 *
 * An extraction out of a dependency's forwarded manifest is that dependency's
 * code: it is stamped `forwardedInternal` (see `isForwardedDeclaration`) and
 * carries the declaring module's `moduleGlobals`, as its parent does.
 *
 * Every stamp of an extraction or a scope member is its holder's; one its
 * author wrote is dropped. With `onWrittenStamp`, each stamp an author wrote on
 * an inline declaration or a scope member is reported at its written place,
 * labelled by the nearest enclosing declaration its author named; a scoped
 * `Telo.Import` is the loader's to judge, and a template body entry
 * `bodyEntryStamps`'.
 *
 * Returns a new array of deep-cloned manifests (the rewrites land on the clones)
 * plus every top-level extraction. The caller's manifests — array and elements —
 * are never mutated; this is the analyzer's immutability boundary.
 */
export function normalizeInlineResources(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
  /** The name of an inline declaration an EMITTED item of a template body holds,
   *  by the definition, the body entry's index and the declaration's place in the
   *  entry; undefined leaves the name the position gives (`emittedIdentity`). */
  emittedName?: (definition: ResourceManifest, entry: number, keys: readonly (string | number)[]) => string | undefined,
  onWrittenStamp?: (stamp: WrittenStampPlace) => void,
): ResourceManifest[] {
  return normalizeAll(resources, registry, aliases, aliasesByModule, emittedName, onWrittenStamp, undefined).manifests;
}

/** How a normalization over the classes of the varying named shapes reads a
 *  reference site some classes declare: conditions over the configurations,
 *  and each way the site's reference items are decided. */
export interface ClassCuts<C> {
  readonly always: C;
  and(a: C, b: C): C;
  or(a: C, b: C): C;
  not(a: C): C;
  isNever(condition: C): boolean;
  /** Each way of deciding `site`'s reference items: the indices it keeps, in
   *  the order a walk of such a configuration reaches them, and where. */
  refSides(site: ConditionedReachSite<C>): readonly { readonly kept: readonly number[]; readonly condition: C }[];
}

/** A cut point written into a normalization over classes: where `condition`
 *  holds, the place `key` of `holder` holds `value` instead of what is written
 *  there. */
export interface CutPoint<C> {
  readonly holder: object;
  readonly key: string | number;
  readonly condition: C;
  readonly value: unknown;
}

/** A normalization over classes: the manifests with every cut point's place
 *  as written, each cut point, and where each declaration it drew out holds —
 *  one it drew out at a cut point only where the cut point takes it. */
export interface ClassNormalization<C> {
  readonly manifests: ResourceManifest[];
  readonly cuts: readonly CutPoint<C>[];
  /** Every declaration not holding wherever its holder does: a top-level one,
   *  or one placed in a scope's or a template body's list. */
  readonly presence: ReadonlyMap<object, C>;
}

/**
 * {@link normalizeInlineResources} read through the conditioned reach of the
 * varying named shapes (the registry's reach while `withConditionedReach`
 * runs): a reference slot only some classes declare is a CUT POINT written
 * once with every side — where a side holding an extraction is taken, the
 * declaration drawn out holds and the slot holds a reference to it; where
 * none is, the value stays as written — so a declaration is normalized once
 * whatever its cut points decide.
 */
export function normalizeInlineResourcesOverClasses<C>(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  emittedName: ((definition: ResourceManifest, entry: number, keys: readonly (string | number)[]) => string | undefined) | undefined,
  classes: ClassCuts<C>,
): ClassNormalization<C> {
  return normalizeAll(resources, registry, aliases, aliasesByModule, emittedName, undefined, classes);
}

function normalizeAll<C>(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  emittedName: ((definition: ResourceManifest, entry: number, keys: readonly (string | number)[]) => string | undefined) | undefined,
  onWrittenStamp: ((stamp: WrittenStampPlace) => void) | undefined,
  classes: ClassCuts<C> | undefined,
): ClassNormalization<C> {
  const cuts: CutPoint<C>[] = [];
  const presence = new Map<object, C>();
  // Deep-clone the input so this pass — and `resolveRefSentinels`, which runs on
  // this output — never mutate caller-owned manifests. The extractions rewrite
  // slots in place, so without cloning we'd corrupt shared state such as the
  // editor's `LoadedFile.manifests` parse cache (a reused sentinel would be
  // rewritten to a resolved reference, which the raw stage refuses as authored).
  const result = resources.map(cloneForMutation) as ResourceManifest[];
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope<ResourceDefinition>(registry, kind, from?.metadata, aliases, aliasesByModule);

  // System kinds join the queue too: their inline-accepting slots are filtered
  // per entry below, so a system document is walked but only its opted-in slots
  // are extracted from.
  const queue: Declaration[] = result
    .filter((r): r is NamedManifest => typeof r.metadata?.name === "string" && !!r.kind)
    .map((manifest) => ({
      manifest,
      written: { root: manifest, path: "" },
      labelling: { label: stampLabel(manifest), at: "" },
      home: undefined,
      outside: outsideScopesOf(manifest),
      ...provenanceOf(manifest, undefined),
    }));

  /** Reports each stamp `declaration` was written with, at `written`, labelled
   *  by `labelling`; the stamps it holds that its holder's replace. */
  const judge = (declaration: unknown, written: WrittenPlace, labelling: Labelling): string[] => {
    for (const field of onWrittenStamp ? writtenMetadataStamps(declaration) : []) {
      onWrittenStamp!({
        root: written.root,
        path: joinPath(written.path, `metadata.${field}`),
        field,
        label: labelling.label,
        labelAt: labelling.at,
      });
    }
    return writtenNestedStamps(declaration);
  };

  // A template body's entries are declarations too, created in the template's
  // own child context — so what one declares inline joins the same `resources:`
  // list, where the kernel creates it with its siblings.
  for (const definition of result) {
    if (definition.kind !== "Telo.Definition") continue;
    const body = (definition as { resources?: unknown }).resources;
    if (!Array.isArray(body)) continue;
    const provenance = provenanceOf(definition, undefined);
    body.forEach((entry, index) => {
      const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (typeof name !== "string") return;
      if (typeof (entry as { kind?: unknown }).kind !== "string") return;
      queue.push({
        manifest: entry as NamedManifest,
        written: { root: definition, path: `resources[${index}]` },
        labelling: { label: stampLabel(entry as ResourceManifest), at: `resources[${index}]` },
        home: body,
        outside: [],
        inBody: true,
        bodyOf: { definition, index },
        ...provenance,
      });
    });
  }

  const place = (
    manifest: ResourceManifest,
    written: WrittenPlace,
    labelling: Labelling,
    into: unknown[] | undefined,
    module?: string,
    inBody?: true,
    held?: unknown,
  ) => {
    if (into) into.push(manifest);
    else result.push(manifest);
    if (classes && held !== undefined && held !== classes.always) presence.set(manifest, held as C);
    queue.push({
      manifest: manifest as NamedManifest,
      written,
      labelling,
      home: into,
      outside: outsideScopesOf(manifest),
      ...(inBody ? { inBody } : {}),
      ...(held !== undefined ? { presence: held } : {}),
      ...provenanceOf(manifest, module),
    });
  };

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const { manifest: resource, home, outside } = current;
    // The registry reads a kind's alias table off `metadata.module`; a nested
    // declaration is looked up through a view carrying its holder's.
    const view =
      current.module !== undefined && moduleOf(resource) !== current.module
        ? ({ ...resource, metadata: { ...resource.metadata, module: current.module } } as NamedManifest)
        : resource;
    // The concrete sites, schema-from slots expanded — so an inline encoder
    // inside an Acme.Outcomes/$defs/Returns sub-schema reaches
    // extraction — and recursion unrolled as deep as the data goes.
    const sites = registry.referenceSites(view, aliases, aliasesByModule, resource);

    const parentName = resource.metadata.name;
    const parentModule = moduleOf(view);
    const inherit: Provenance = {
      module: parentModule,
      forwarded: current.forwarded,
      moduleGlobals: current.moduleGlobals,
      importPath: current.importPath,
    };

    const scopes = declaredScopes(sites);
    // Queued BEFORE anything is extracted into these arrays: an extraction
    // queues itself, and must not be walked twice. A member is created inside
    // this resource's scope, which is itself created where this resource is.
    for (const scope of scopes) {
      for (const member of scopeMembers(scope)) {
        const written = {
          root: current.written.root,
          path: joinPath(current.written.path, `${scope.path}[${scope.declarations.indexOf(member)}]`),
        };
        const labelling = { label: stampLabel(member), at: written.path };
        if (member.kind !== "Telo.Import") {
          const fields = judge(member, written, labelling);
          if (fields.length > 0) member.metadata = withoutStamps(member.metadata, fields) as NamedManifest["metadata"];
        }
        queue.push({ manifest: member, written, labelling, home: scope.declarations, outside, ...inherit, ...(current.presence !== undefined ? { presence: current.presence } : {}) });
      }
    }
    const outsideAt = (slotKeys: readonly (string | number)[], createdIn?: DeclaredScope): OutsideScope[] => [
      ...outside,
      ...scopes
        .filter((scope) => scope !== createdIn && scopeEncloses(scope, slotKeys))
        .map((scope) => ({
          ownerKind: resource.kind,
          ownerName: parentName,
          field: scope.path,
          names: scopeMembers(scope).map((member) => member.metadata.name),
        }))
        .filter((scope) => scope.names.length > 0),
    ];

    // Whether a kind spelled in this declaration's module declares a `name`
    // field — what tells the legacy `{ kind, name }` reference from an inline
    // declaration of a kind that has one.
    const legacyReference = (value: unknown) =>
      isLegacyReferenceForm(value, (kind) => {
        const definition = definitionInScope<ResourceDefinition>(
          registry,
          kind,
          view.metadata,
          aliases,
          aliasesByModule,
        );
        return definition ? declaresNameField(definition, resolveDef) : undefined;
      });

    const extractedAt: (readonly (string | number)[])[] = [];
    /** Where a cut point draws a declaration out, beneath which a site is the
     *  holder's only where it does not. */
    const cutAt: { keys: readonly (string | number)[]; condition: C }[] = [];
    for (const site of sites) {
      if (site.refs.length === 0) continue;
      if (classes && (site as Partial<ConditionedReachSite<C>>).holding) {
        cutSite(current, view, inherit, scopes, outsideAt, site as ConditionedReachSite<C>, classes, cutAt);
        continue;
      }
      const valueOutcome = valueOutcomeAt(site, registry);
      // A value whose branch could not finish validating is neither a reference nor
      // a declaration: the slot's own finding is the one report.
      if (typeof valueOutcome === "object") continue;
      if (site.holder && site.key !== undefined && legacyReference(site.data) && valueOutcome === "refuses") {
        (site.holder as Record<string | number, unknown>)[site.key] = asResolvedReference(site.data);
        continue;
      }
      const entry = siteRefEntry(site);
      if (!acceptsInline(resource.kind, entry)) continue;
      if (current.inBody && entry.uses.includes("schema")) continue;
      // A site below one already extracted belongs to that declaration now.
      if (extractedAt.some((at) => at.length < site.keys.length && keysUnder(site.keys, at))) {
        continue;
      }
      const scope = scopes.find((s) => scopeEncloses(s, site.keys));
      const written = { root: current.written.root, path: joinPath(current.written.path, site.path) };
      if (isInlineDeclaration(site.data)) judge(site.data, written, current.labelling);
      const manifest = extractInlineAt(
        resource,
        site,
        parentName,
        resource.kind,
        inherit,
        outsideAt(site.keys, scope),
        entry.context,
        current.bodyOf ? emittedName?.(current.bodyOf.definition, current.bodyOf.index, site.keys) : undefined,
      );
      if (!manifest) continue;
      extractedAt.push(site.keys);
      place(manifest, written, current.labelling, scope?.declarations ?? home, parentModule, current.inBody);
    }

    if (SYSTEM_KINDS.has(resource.kind)) continue;
    extractStepTargets(resource, view, registry, aliases, aliasesByModule, inherit, outsideAt, legacyReference, (m, at, inline) => {
      const written = { root: current.written.root, path: joinPath(current.written.path, at) };
      // A step target named by its author is its own label; any other is its holder's.
      const labelling = (m.metadata as { xTeloOrigin?: Origin }).xTeloOrigin?.named
        ? { label: stampLabel(m), at: written.path }
        : current.labelling;
      judge(inline, written, labelling);
      place(m, written, labelling, home, parentModule, current.inBody, current.presence);
    });
  }

  return { manifests: result, cuts, presence };

  /**
   * The reference site `site` of `current`, read over classes: each way of
   * deciding its reference items gives what a configuration deciding it so
   * writes there — the value as written, the legacy reference marked, or the
   * inline declaration drawn out — and where more than one is given, the
   * place is a cut point holding each where it is taken.
   */
  function cutSite(
    current: Declaration,
    view: NamedManifest,
    inherit: Provenance,
    scopes: readonly DeclaredScope[],
    outsideAt: (slotKeys: readonly (string | number)[], createdIn?: DeclaredScope) => OutsideScope[],
    site: ConditionedReachSite<C>,
    ops: ClassCuts<C>,
    cutAt: { keys: readonly (string | number)[]; condition: C }[],
  ): void {
    const { manifest: resource, home } = current;
    // A site below one drawn out belongs to that declaration where it is.
    let under = ops.always;
    for (const at of cutAt) {
      if (at.keys.length < site.keys.length && keysUnder(site.keys, at.keys)) under = ops.and(under, ops.not(at.condition));
    }
    // A legacy reference is marked whatever encloses it, as the loop marks it.
    const beneathDrawnOut = ops.isNever(under);
    const held = current.presence === undefined ? under : ops.and(current.presence as C, under);
    const outcomes = new Map<string, { condition: C; outcome: SiteOutcome }>();
    for (const side of ops.refSides(site)) {
      const refs = side.kept.map((i) => site.refs[i]!);
      const outcome = siteOutcome(current, view, { ...site, refs }, registry, aliases, aliasesByModule);
      const key = outcome.kind === "extract" ? `extract\0${JSON.stringify(outcome.context ?? null)}` : outcome.kind;
      const known = outcomes.get(key);
      outcomes.set(key, { condition: known ? ops.or(known.condition, side.condition) : side.condition, outcome });
    }
    const parentName = resource.metadata.name;
    const parentModule = moduleOf(view);
    const scope = scopes.find((s) => scopeEncloses(s, site.keys));
    const written = { root: current.written.root, path: joinPath(current.written.path, site.path) };
    const only = outcomes.size === 1;
    let drawnOut: C | undefined;
    for (const { condition, outcome } of outcomes.values()) {
      if (outcome.kind === "written") continue;
      if (outcome.kind === "legacy") {
        const marked = asResolvedReference(site.data as Record<string, unknown> & { kind: string; name: string });
        if (only) (site.holder as Record<string | number, unknown>)[site.key!] = marked;
        else if (!beneathDrawnOut) cuts.push({ holder: site.holder!, key: site.key!, condition, value: marked });
        continue;
      }
      if (beneathDrawnOut) continue;
      const inline = only ? (site.data as Record<string, unknown>) : (cloneForMutation(site.data) as Record<string, unknown>);
      const drawn = inlineManifestAt(
        resource,
        { ...site, data: inline },
        parentName,
        resource.kind,
        inherit,
        outsideAt(site.keys, scope),
        outcome.context,
        current.bodyOf ? emittedName?.(current.bodyOf.definition, current.bodyOf.index, site.keys) : undefined,
      );
      if (only) (site.holder as Record<string | number, unknown>)[site.key!] = drawn.reference;
      else cuts.push({ holder: site.holder!, key: site.key!, condition, value: drawn.reference });
      drawnOut = drawnOut === undefined ? condition : ops.or(drawnOut, condition);
      const where = only ? held : ops.and(held, condition);
      place(drawn.manifest, written, current.labelling, scope?.declarations ?? home, parentModule, current.inBody, where);
    }
    if (drawnOut !== undefined) cutAt.push({ keys: site.keys, condition: only ? ops.always : drawnOut });
  }
}

/** Whether the object at `site` is a value its slot accepts, refuses, or could
 *  not finish judging; nothing for a scalar or a tag. */
function valueOutcomeAt(site: ReachSite, registry: DefinitionRegistry): ValueBranchOutcome | undefined {
  return site.data !== null && typeof site.data === "object" && !isTaggedSentinel(site.data)
    ? isValueAtSlot(site.data, site.refs, registry)
    : undefined;
}

/** What one way of deciding a site's reference items writes there. */
type SiteOutcome = { kind: "written" } | { kind: "legacy" } | { kind: "extract"; context: Record<string, any> | undefined };

/** What a configuration keeping exactly `site.refs` writes at `site` of
 *  `current` — the decision the loop of {@link normalizeAll} makes. */
function siteOutcome(
  current: Declaration,
  view: NamedManifest,
  site: ReachSite,
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
): SiteOutcome {
  if (site.refs.length === 0) return { kind: "written" };
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope<ResourceDefinition>(registry, kind, from?.metadata, aliases, aliasesByModule);
  const legacy = isLegacyReferenceForm(site.data, (kind) => {
    const definition = definitionInScope<ResourceDefinition>(registry, kind, view.metadata, aliases, aliasesByModule);
    return definition ? declaresNameField(definition, resolveDef) : undefined;
  });
  const valueOutcome = valueOutcomeAt(site, registry);
  if (typeof valueOutcome === "object") return { kind: "written" };
  if (site.holder && site.key !== undefined && legacy && valueOutcome === "refuses") return { kind: "legacy" };
  const entry = siteRefEntry(site);
  if (!acceptsInline(current.manifest.kind, entry)) return { kind: "written" };
  if (current.inBody && entry.uses.includes("schema")) return { kind: "written" };
  const inline = site.data;
  if (!inline || typeof inline !== "object" || Array.isArray(inline) || !site.holder || !isInlineDeclaration(inline)) return { kind: "written" };
  return { kind: "extract", context: entry.context };
}

const moduleOf = (manifest: ResourceManifest): string | undefined => {
  const module = (manifest.metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
};

function provenanceOf(manifest: ResourceManifest, module: string | undefined): Provenance {
  return {
    module: moduleOf(manifest) ?? module,
    forwarded: isForwardedDeclaration(manifest),
    moduleGlobals: (manifest.metadata as { moduleGlobals?: unknown } | undefined)?.moduleGlobals,
    importPath: (manifest.metadata as { importPath?: unknown } | undefined)?.importPath,
  };
}

/**
 * Extract every inline dispatch target of every step in `resource`'s step
 * bodies, at any nesting depth, into a named manifest.
 *
 * The name is the step engine's, so it names what the RUNTIME owner passes it:
 *
 *  - the owner kind is the kind whose CONTROLLER runs the body — the kind
 *    itself, or for an `extends` child that inherits its controller, the
 *    ancestor that supplies it;
 *  - the path's first segment is the field the controller reads its body from.
 *    For a `base:`-form child that is the PARENT's field the body is mapped onto,
 *    which is taken from a pure `self.<field>` mapping; a body `base:` reshapes any
 *    other way is left inline, for the runtime to name exactly as it always has;
 *  - an inline declaration stating its own `metadata.name` keeps it, as
 *    `ensureKindRef` always has.
 */
function extractStepTargets(
  resource: NamedManifest,
  view: NamedManifest,
  registry: DefinitionRegistry,
  aliases: AliasResolver | undefined,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  inherit: Provenance,
  outsideAt: (slotKeys: readonly (string | number)[]) => OutsideScope[],
  legacyReference: (value: unknown) => value is Record<string, unknown> & { kind: string; name: string },
  /** The extraction, its place in `resource`, and the inline declaration as written. */
  emit: (manifest: ResourceManifest, at: string, inline: Record<string, unknown>) => void,
): void {
  const definition = definitionInScope<ResourceDefinition>(
    registry,
    view.kind,
    view.metadata,
    aliases,
    aliasesByModule,
  );
  if (!definition) return;
  const schema = registry.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  if (!schema) return;
  const resolveDef: DefResolver = (kind, from) =>
    definitionInScope<ResourceDefinition>(registry, kind, from?.metadata, aliases, aliasesByModule);
  const runner = hasOwnControllerOrTemplate(definition)
    ? definition
    : (controllerBearingAncestor(definition, resolveDef) ?? definition);
  const owner = { kind: runner.metadata.name, resourceName: resource.metadata.name };
  const base = runner !== definition ? (definition as { base?: unknown }).base : undefined;

  for (const body of stepBodiesOf(resource, schema)) {
    const root = base === undefined ? body.field : mappedStepField(base, body.field, runner, registry);
    if (root === undefined) continue;
    const outsideScopes = outsideAt([body.field]);

    forEachStep(body, schema, (step, stepPath) => {
      const target = step[body.invokeField];
      if (!target || typeof target !== "object" || Array.isArray(target)) return;
      if (legacyReference(target)) {
        step[body.invokeField] = asResolvedReference(target);
        return;
      }
      if (!isInlineDeclaration(target)) return;
      // The step grammar requires a name, and a target is named after it; a step
      // without one is reported by schema validation and left as written.
      if (typeof step.name !== "string") return;
      const inline = target as Record<string, unknown>;
      const declared = (inline.metadata as { name?: unknown } | undefined)?.name;
      const name =
        typeof declared === "string"
          ? declared
          : inlineStepTargetName(owner, [root, ...stepPathSegments(stepPath).slice(1)], step.name);
      step[body.invokeField] = resolvedReference(inline.kind as string, name);
      emit(
        buildManifest(
          inline,
          name,
          {
            parentKind: resource.kind,
            parentName: resource.metadata.name,
            pathFromParent: `${stepPath}.${body.invokeField}`,
            stepTarget: true,
            ...(typeof declared === "string" ? { named: true as const } : {}),
            ...(outsideScopes.length > 0 ? { outsideScopes } : {}),
          },
          inherit,
        ),
        `${stepPath}.${body.invokeField}`,
        inline,
      );
    });
  }
}

/** The runner's step field a `base:` mapping forwards `field` into, when it does
 *  so verbatim (`steps: !cel "self.<field>"`); undefined otherwise. */
function mappedStepField(
  base: unknown,
  field: string,
  runner: ResourceDefinition,
  registry: DefinitionRegistry,
): string | undefined {
  if (!base || typeof base !== "object" || Array.isArray(base)) return undefined;
  const runnerSchema = registry.effectiveSchemaOf(runner) as Record<string, any> | undefined;
  if (!runnerSchema) return undefined;
  const runnerSteps = new Set(
    gatherPropertySchemas(runnerSchema)
      .filter(([, schema]) => readStepSlot(schema) !== undefined)
      .map(([key]) => key),
  );
  for (const [target, value] of Object.entries(base as Record<string, unknown>)) {
    if (runnerSteps.has(target) && pureSelfField(value) === field) return target;
  }
  return undefined;
}

/** `f` for a CEL value that is exactly `self.f`, in any spelling it arrives in. */
function pureSelfField(value: unknown): string | undefined {
  let source: string | undefined;
  if (isTaggedSentinel(value)) {
    if (value.engine === "cel") source = value.source;
  } else if (value && typeof value === "object" && (value as { __compiled?: unknown }).__compiled) {
    const compiled = (value as { source?: unknown }).source;
    if (typeof compiled === "string") source = compiled;
  }
  return source === undefined ? undefined : /^self\.([A-Za-z_$][\w$]*)$/.exec(source.trim())?.[1];
}

/** `steps[1].cases.a[0]` → `["steps", "1", "cases", "a", "0"]`. Exact even for a
 *  case key holding punctuation: the name keeps only alphanumeric runs, so
 *  splitting inside a key cannot change it. */
function stepPathSegments(path: string): string[] {
  return path.split(/[.[\]]/).filter((segment) => segment.length > 0);
}

/**
 * Extracts the inline declaration a reference site holds, replacing it in place
 * with a resolved reference to it. The name follows the site: each key, and each array
 * item's own `name` (its index when it has none).
 */
function extractInlineAt(
  resource: ResourceManifest,
  site: ReachSite,
  parentName: string,
  parentKind: string,
  inherit: Provenance,
  outsideScopes: OutsideScope[],
  invocationContext?: Record<string, any>,
  givenName?: string,
): ResourceManifest | undefined {
  const inline = site.data;
  if (!inline || typeof inline !== "object" || Array.isArray(inline) || !site.holder) return undefined;
  if (!isInlineDeclaration(inline)) return undefined;
  const drawn = inlineManifestAt(resource, site, parentName, parentKind, inherit, outsideScopes, invocationContext, givenName);
  (site.holder as Record<string | number, unknown>)[site.key!] = drawn.reference;
  return drawn.manifest;
}

/** The declaration the inline one `site` holds is drawn out as, and the
 *  reference to it that takes its place; nothing is written. */
function inlineManifestAt(
  resource: ResourceManifest,
  site: ReachSite,
  parentName: string,
  parentKind: string,
  inherit: Provenance,
  outsideScopes: OutsideScope[],
  invocationContext?: Record<string, any>,
  givenName?: string,
): { manifest: ResourceManifest; reference: unknown } {
  const inline = site.data as Record<string, unknown> & { kind: string };
  const nameParts: string[] = [];
  let value: unknown = resource;
  for (const key of site.keys) {
    value = (value as Record<string | number, unknown>)[key];
    if (typeof key === "number") {
      const itemName = (value as Record<string, unknown> | undefined)?.name;
      nameParts.push(typeof itemName === "string" ? itemName : String(key));
    } else {
      nameParts.push(key);
    }
  }
  const name = givenName ?? sanitizeName([parentName, ...nameParts].join("_"));
  return {
    reference: resolvedReference(inline.kind, name),
    manifest: buildManifest(
      inline,
      name,
      {
        parentKind,
        parentName,
        pathFromParent: site.path,
        keysFromParent: [...site.keys],
        ...(outsideScopes.length > 0 ? { outsideScopes } : {}),
      },
      inherit,
      invocationContext,
    ),
  };
}

function buildManifest(
  inline: Record<string, unknown>,
  name: string,
  origin: Origin,
  inherit: Provenance,
  invocationContext?: Record<string, any>,
): ResourceManifest {
  const written =
    inline.metadata && typeof inline.metadata === "object"
      ? (inline.metadata as Record<string, unknown>)
      : {};
  return {
    ...inline,
    metadata: {
      ...withoutStamps(written, writtenNestedStamps(inline)),
      name,
      ...(inherit.module ? { module: inherit.module } : {}),
      ...(inherit.forwarded ? { forwardedInternal: true } : {}),
      ...(inherit.moduleGlobals !== undefined ? { moduleGlobals: inherit.moduleGlobals } : {}),
      ...(inherit.importPath !== undefined ? { importPath: inherit.importPath } : {}),
      ...(invocationContext ? { xTeloInvocationContext: invocationContext } : {}),
      xTeloOrigin: origin,
    },
  } as unknown as ResourceManifest;
}
