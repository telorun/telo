import { inlineStepTargetName, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import { isTaggedSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  controllerBearingAncestor,
  hasOwnControllerOrTemplate,
  type DefResolver,
} from "./extends-resolution.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isInlineResource } from "./reference-field-map.js";
import { siteRefEntry, type ReachSite } from "./reference-reach.js";
import { gatherPropertySchemas } from "./schema-walk.js";
import {
  declaredScopes,
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
function acceptsInline(resourceKind: string, entry: { inline?: boolean }): boolean {
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
  if (Array.isArray(value)) return value.map(cloneForMutation);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = cloneForMutation((value as Record<string, unknown>)[key]);
  }
  return out;
}

type NamedManifest = ResourceManifest & { metadata: { name: string } };

/** What an extraction inherits from the declaration it was written in: the
 *  module its kinds are written in, whether it is a dependency's code, and the
 *  declaring module's config contract its CEL is typed against. */
interface Provenance {
  module: string | undefined;
  forwarded: boolean;
  moduleGlobals: unknown;
}

/** A declaration waiting to have its inline slots extracted. */
interface Declaration extends Provenance {
  manifest: NamedManifest;
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
}

/** What `metadata.xTeloOrigin` records: where an extracted declaration was
 *  written, so a diagnostic about it anchors in its author's document. */
interface Origin {
  parentKind: string;
  parentName: string;
  /** Concrete dotted path with `[N]` indices, matching `buildPositionIndex` keys
   *  (e.g. `routes[0].handler`). */
  pathFromParent: string;
  /** Set on a step's dispatch target, whose identity is its path-derived name
   *  alone — see `inlineStepTargetName`. */
  stepTarget?: true;
  outsideScopes?: OutsideScope[];
}

/**
 * Phase 2 — Inline resource normalization.
 *
 * Every inline declaration (a `{kind, …config}` with no `name`) is extracted as a
 * first-class manifest under a deterministic name and replaced in place with
 * `{kind, name}`. Two kinds of slot carry one:
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
 * Returns a new array of deep-cloned manifests (the rewrites land on the clones)
 * plus every top-level extraction. The caller's manifests — array and elements —
 * are never mutated; this is the analyzer's immutability boundary.
 */
export function normalizeInlineResources(
  resources: ResourceManifest[],
  registry: DefinitionRegistry,
  aliases?: AliasResolver,
  aliasesByModule?: Map<string, AliasResolver>,
): ResourceManifest[] {
  // Deep-clone the input so this pass — and `resolveRefSentinels`, which runs on
  // this output — never mutate caller-owned manifests. The extractions rewrite
  // slots in place, so without cloning we'd corrupt shared state such as the
  // editor's `LoadedFile.manifests` parse cache (a reused sentinel would be
  // rewritten to `{kind, name}`, later misread as an authored reference form).
  const result = resources.map(cloneForMutation) as ResourceManifest[];

  // System kinds join the queue too: their inline-accepting slots are filtered
  // per entry below, so a system document is walked but only its opted-in slots
  // are extracted from.
  const queue: Declaration[] = result
    .filter((r): r is NamedManifest => typeof r.metadata?.name === "string" && !!r.kind)
    .map((manifest) => ({
      manifest,
      home: undefined,
      outside: outsideScopesOf(manifest),
      ...provenanceOf(manifest, undefined),
    }));

  // A template body's entries are declarations too, created in the template's
  // own child context — so what one declares inline joins the same `resources:`
  // list, where the kernel creates it with its siblings.
  for (const definition of result) {
    if (definition.kind !== "Telo.Definition") continue;
    const body = (definition as { resources?: unknown }).resources;
    if (!Array.isArray(body)) continue;
    const provenance = provenanceOf(definition, undefined);
    for (const entry of body) {
      const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
      if (typeof name !== "string") continue;
      if (typeof (entry as { kind?: unknown }).kind !== "string") continue;
      queue.push({ manifest: entry as NamedManifest, home: body, outside: [], inBody: true, ...provenance });
    }
  }

  const place = (
    manifest: ResourceManifest,
    into: unknown[] | undefined,
    module?: string,
    inBody?: true,
  ) => {
    if (into) into.push(manifest);
    else result.push(manifest);
    queue.push({
      manifest: manifest as NamedManifest,
      home: into,
      outside: outsideScopesOf(manifest),
      ...(inBody ? { inBody } : {}),
      ...provenanceOf(manifest, module),
    });
  };

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    const { manifest: resource, home, outside } = current;
    // The registry reads a kind's alias table off `metadata.module`; a scope
    // member is looked up through a view carrying its owner's.
    const view =
      current.module !== undefined && moduleOf(resource) === undefined
        ? ({ ...resource, metadata: { ...resource.metadata, module: current.module } } as NamedManifest)
        : resource;
    // The concrete sites, schema-from slots expanded — so an inline encoder
    // inside an HttpDispatch.Outcomes/$defs/Returns sub-schema reaches
    // extraction — and recursion unrolled as deep as the data goes.
    const sites = registry.referenceSites(view, aliases, aliasesByModule, resource);

    const parentName = resource.metadata.name;
    const parentModule = moduleOf(view);
    const inherit: Provenance = {
      module: parentModule,
      forwarded: current.forwarded,
      moduleGlobals: current.moduleGlobals,
    };

    const scopes = declaredScopes(sites);
    // Queued BEFORE anything is extracted into these arrays: an extraction
    // queues itself, and must not be walked twice. A member is created inside
    // this resource's scope, which is itself created where this resource is.
    for (const scope of scopes) {
      for (const member of scopeMembers(scope)) {
        queue.push({ manifest: member, home: scope.declarations, outside, ...inherit });
      }
    }
    const outsideAt = (slotPath: string, createdIn?: DeclaredScope): OutsideScope[] => [
      ...outside,
      ...scopes
        .filter((scope) => scope !== createdIn && scopeEncloses(scope, slotPath))
        .map((scope) => ({
          ownerKind: resource.kind,
          ownerName: parentName,
          field: scope.path,
          names: scopeMembers(scope).map((member) => member.metadata.name),
        }))
        .filter((scope) => scope.names.length > 0),
    ];

    const extractedAt: string[] = [];
    for (const site of sites) {
      if (site.refs.length === 0) continue;
      const entry = siteRefEntry(site);
      if (!acceptsInline(resource.kind, entry)) continue;
      if (current.inBody && entry.uses.includes("schema")) continue;
      // A site below one already extracted belongs to that declaration now.
      if (extractedAt.some((at) => site.path.startsWith(`${at}.`) || site.path.startsWith(`${at}[`))) {
        continue;
      }
      const scope = scopes.find((s) => scopeEncloses(s, site.path));
      const manifest = extractInlineAt(
        resource,
        site,
        parentName,
        resource.kind,
        inherit,
        outsideAt(site.path, scope),
        entry.context,
      );
      if (!manifest) continue;
      extractedAt.push(site.path);
      place(manifest, scope?.declarations ?? home, parentModule, current.inBody);
    }

    if (SYSTEM_KINDS.has(resource.kind)) continue;
    extractStepTargets(resource, view, registry, aliases, aliasesByModule, inherit, outsideAt, (m) =>
      place(m, home, parentModule, current.inBody),
    );
  }

  return result;
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
  outsideAt: (slotPath: string) => OutsideScope[],
  emit: (manifest: ResourceManifest) => void,
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
    const outsideScopes = outsideAt(body.field);

    forEachStep(body, schema, (step, stepPath) => {
      const target = step[body.invokeField];
      if (!target || typeof target !== "object" || Array.isArray(target)) return;
      if (!isInlineResource(target as Record<string, unknown>)) return;
      // The step grammar requires a name, and a target is named after it; a step
      // without one is reported by schema validation and left as written.
      if (typeof step.name !== "string") return;
      const inline = target as Record<string, unknown>;
      const declared = (inline.metadata as { name?: unknown } | undefined)?.name;
      const name =
        typeof declared === "string"
          ? declared
          : inlineStepTargetName(owner, [root, ...stepPathSegments(stepPath).slice(1)], step.name);
      step[body.invokeField] = { kind: inline.kind, name };
      emit(
        buildManifest(
          inline,
          name,
          {
            parentKind: resource.kind,
            parentName: resource.metadata.name,
            pathFromParent: `${stepPath}.${body.invokeField}`,
            stepTarget: true,
            ...(outsideScopes.length > 0 ? { outsideScopes } : {}),
          },
          inherit,
        ),
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
 * with `{kind, name}`. The name follows the site: each key, and each array
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
): ResourceManifest | undefined {
  const inline = site.data;
  if (!inline || typeof inline !== "object" || Array.isArray(inline) || !site.holder) return undefined;
  if (!isInlineResource(inline as Record<string, unknown>)) return undefined;
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
  const name = sanitizeName([parentName, ...nameParts].join("_"));
  (site.holder as Record<string | number, unknown>)[site.key!] = {
    kind: (inline as Record<string, unknown>).kind,
    name,
  };
  return buildManifest(
    inline as Record<string, unknown>,
    name,
    {
      parentKind,
      parentName,
      pathFromParent: site.path,
      ...(outsideScopes.length > 0 ? { outsideScopes } : {}),
    },
    inherit,
    invocationContext,
  );
}

function buildManifest(
  inline: Record<string, unknown>,
  name: string,
  origin: Origin,
  inherit: Provenance,
  invocationContext?: Record<string, any>,
): ResourceManifest {
  const existingMeta =
    inline.metadata && typeof inline.metadata === "object"
      ? (inline.metadata as Record<string, unknown>)
      : {};
  return {
    ...inline,
    metadata: {
      ...existingMeta,
      name,
      // Inherit parent module only if the inline doesn't already declare one
      ...(inherit.module && !existingMeta.module ? { module: inherit.module } : {}),
      ...(inherit.forwarded ? { forwardedInternal: true } : {}),
      ...(inherit.moduleGlobals !== undefined ? { moduleGlobals: inherit.moduleGlobals } : {}),
      ...(invocationContext ? { xTeloInvocationContext: invocationContext } : {}),
      xTeloOrigin: origin,
    },
  } as unknown as ResourceManifest;
}
