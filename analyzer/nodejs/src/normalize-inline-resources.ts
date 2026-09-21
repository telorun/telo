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
import { isInlineResource, isRefEntry } from "./reference-field-map.js";
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
 *  - a REFERENCE slot, found through the kind's field map, named
 *    `{parentName}_{pathSegment}[_{itemName|index}]_{fieldName}`
 *    (`TestBasicAddition_steps_AddTwoNumbers_invoke`);
 *  - a STEP's dispatch target, at any nesting depth of a step body, named by
 *    `inlineStepTargetName` — the name the step engine has always registered it
 *    under, which is durable identity and so must not move with the extraction.
 *
 * Step slots are found through the kind's step-body annotation and walked with
 * `walkStepArray`, never through the field map: that map is the kernel's Phase-5
 * injection surface, and a step's target resolves at dispatch.
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

  const place = (manifest: ResourceManifest, into: unknown[] | undefined, module?: string) => {
    if (into) into.push(manifest);
    else result.push(manifest);
    queue.push({
      manifest: manifest as NamedManifest,
      home: into,
      outside: outsideScopesOf(manifest),
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
    // When aliasesByModule is available, use the expanded map so inline refs
    // hidden behind an x-telo-schema-from indirection (e.g. an encoder inside
    // an HttpDispatch.Outcomes/$defs/Returns sub-schema) reach extraction.
    const fieldMap =
      aliases && aliasesByModule
        ? registry.expandedFieldMapForResource(view, aliases, aliasesByModule)
        : registry.getFieldMapForKind(resource.kind, aliases);
    if (!fieldMap) continue;

    const parentName = resource.metadata.name;
    const parentModule = moduleOf(view);
    const inherit: Provenance = {
      module: parentModule,
      forwarded: current.forwarded,
      moduleGlobals: current.moduleGlobals,
    };

    const scopes = declaredScopes(resource, fieldMap);
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

    for (const [fieldPath, entry] of fieldMap) {
      if (!isRefEntry(entry)) continue;
      if (!acceptsInline(resource.kind, entry)) continue;
      const scope = scopes.find((s) => scopeEncloses(s, fieldPath));
      for (const manifest of extractInlinesAtPath(
        resource,
        fieldPath,
        parentName,
        resource.kind,
        inherit,
        outsideAt(fieldPath, scope),
        entry.context,
      )) {
        place(manifest, scope?.declarations ?? home, parentModule);
      }
    }

    if (SYSTEM_KINDS.has(resource.kind)) continue;
    extractStepTargets(resource, view, registry, aliases, aliasesByModule, inherit, outsideAt, (m) =>
      place(m, home, parentModule),
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
  } else if (typeof value === "string") {
    source = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(value)?.[1];
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
 * Walks `resource` following `fieldPath` (dot notation, `[]` = array traversal).
 * Mutates the resource in-place: replaces each inline value with `{kind, name}`.
 * Returns the extracted manifests.
 */
function extractInlinesAtPath(
  resource: ResourceManifest,
  fieldPath: string,
  parentName: string,
  parentKind: string,
  inherit: Provenance,
  outsideScopes: OutsideScope[],
  invocationContext?: Record<string, any>,
): ResourceManifest[] {
  const extracted: ResourceManifest[] = [];
  const parts = fieldPath.split(".");

  function emit(
    inline: Record<string, unknown>,
    nameSegments: string[],
    concretePath: string,
  ): string {
    const name = sanitizeName([parentName, ...nameSegments].join("_"));
    extracted.push(
      buildManifest(
        inline,
        name,
        {
          parentKind,
          parentName,
          pathFromParent: concretePath,
          ...(outsideScopes.length > 0 ? { outsideScopes } : {}),
        },
        inherit,
        invocationContext,
      ),
    );
    return name;
  }

  function traverse(
    obj: unknown,
    partsLeft: string[],
    nameParts: string[],
    pathSoFar: string,
  ): void {
    if (!obj || typeof obj !== "object" || partsLeft.length === 0) return;

    const [head, ...rest] = partsLeft;

    // Map iteration: descend into every value of the current object (used for
    // schema fields with `additionalProperties` like `content[mime]`).
    if (head === "{}") {
      const container = obj as Record<string, unknown>;
      for (const mapKey of Object.keys(container)) {
        const elem = container[mapKey];
        if (!elem || typeof elem !== "object") continue;
        const sanitizedKey = sanitizeName(mapKey);
        const childPath = pathSoFar ? `${pathSoFar}.${mapKey}` : mapKey;

        if (rest.length === 0) {
          if (isInlineResource(elem as Record<string, unknown>)) {
            const name = emit(elem as Record<string, unknown>, [...nameParts, sanitizedKey], childPath);
            container[mapKey] = { kind: (elem as Record<string, unknown>).kind, name };
          }
        } else {
          traverse(elem, rest, [...nameParts, sanitizedKey], childPath);
        }
      }
      return;
    }

    const isArr = head.endsWith("[]");
    const key = isArr ? head.slice(0, -2) : head;
    const container = obj as Record<string, unknown>;
    const val = container[key];
    if (val == null) return;
    const keyPath = pathSoFar ? `${pathSoFar}.${key}` : key;

    if (isArr) {
      if (!Array.isArray(val)) return;
      for (let idx = 0; idx < val.length; idx++) {
        const elem = val[idx];
        if (!elem || typeof elem !== "object") continue;
        const elemId =
          typeof (elem as Record<string, unknown>).name === "string"
            ? ((elem as Record<string, unknown>).name as string)
            : String(idx);
        const childPath = `${keyPath}[${idx}]`;

        if (rest.length === 0) {
          // Array element itself is the ref slot
          if (isInlineResource(elem as Record<string, unknown>)) {
            const name = emit(elem as Record<string, unknown>, [...nameParts, key, elemId], childPath);
            val[idx] = { kind: (elem as Record<string, unknown>).kind, name };
          }
        } else {
          traverse(elem, rest, [...nameParts, key, elemId], childPath);
        }
      }
    } else {
      if (rest.length === 0) {
        // val is the ref slot
        if (val && typeof val === "object" && !Array.isArray(val) && isInlineResource(val as Record<string, unknown>)) {
          const name = emit(val as Record<string, unknown>, [...nameParts, key], keyPath);
          container[key] = { kind: (val as Record<string, unknown>).kind, name };
        }
      } else {
        traverse(val, rest, [...nameParts, key], keyPath);
      }
    }
  }

  traverse(resource, parts, [], "");
  return extracted;
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
