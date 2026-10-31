/**
 * **Every value a resource writes at a slot whose schema comes from elsewhere,
 * paired with that schema** — the single reader of those sites.
 *
 * A kind's own `schema:` types most of a resource. Four shapes of site it does
 * not type, because what the value must be is declared by ANOTHER document:
 *
 *  - a call's argument map — a step's `inputs:` beside its `invoke:`, the map a
 *    reference slot names through its `x-telo-ref` `inputs:` pointer (an HTTP
 *    route, an Application's inline boot target), and a template definition's
 *    top-level `inputs:` — typed by the target's input contract;
 *  - an `x-telo-schema-from` slot, typed by another kind's schema (resolved in
 *    `schema-from-sites.ts`, where its anchor's refusals are worded);
 *  - an `x-telo-value-schema-from` slot, typed by a type the resource declares.
 *
 * `telo check` validates each site against the schema resolved here, and the
 * kernel decodes the plain-encoded literals at each one when it creates the
 * resource, through the same enumeration — so the two halves read one value at
 * one site against one schema. Browser-safe; resolution the host alone can
 * answer (which declaration a name means, which manifests hold named types) is
 * supplied by the caller.
 */
import { listRequests, type DeclarationRequests } from "./declaration-requests.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  analyzerContractScope,
  resolveContract,
  valueSchemaHostOf,
  type ResolvedContract,
} from "./invocation-contract.js";
import { assignConcretePath, navigateConcretePath } from "./manifest-path.js";
import { visitManifest } from "./manifest-visitor.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { siteRefEntry, type ReachSite } from "./reference-reach.js";
import { withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { isSchemaFromSite, schemaFromSites } from "./schema-from-sites.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import { topologyRoleOf } from "./topology-role.js";
import { dispatchTargetOf } from "./template-body.js";
import type { LibraryDeclarations } from "./library-declarations.js";
import { isKindDocument } from "./kind-declaration.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";
import {
  describeValueSchemaLocation,
  memberNameAt,
  memberTypeOf,
  resolveScopeValues,
  valueSchemaSlots,
  valueSchemaTypes,
  type ValueSchemaHost,
} from "./value-schema-slot.js";
import { isResolvedReference, resolvedReference } from "./resolved-reference.js";

/** What resolving a site needs from its host. */
export interface DerivedSlotContext {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** Each imported library's own declarations, which a projected contract's
   *  hop may reach. */
  readonly libraries?: LibraryDeclarations;
  /** The declarations a named type resolves against. */
  readonly types: DeclarationRequests;
  /** The declaration a `{kind, name, alias?}` reference written at `path` of
   *  the context's resource names, or undefined. */
  resolveTarget(ref: Record<string, any>, path?: string): Record<string, any> | undefined;
}

/** A call's argument map and the target it is for. */
export interface CallSite {
  /** How the argument map was found: a step body, a reference slot's `inputs:`
   *  pointer, or a template definition's top-level `inputs:`. */
  readonly origin: "step" | "slot" | "template";
  /** Concrete path of the argument map. */
  readonly path: string;
  readonly values: Record<string, any>;
  /** The target reference as written, or `{ kind }` for a template's dispatch. */
  readonly invoke: Record<string, any>;
  readonly invokedManifest: Record<string, any> | undefined;
  readonly invokedDefinition: ResourceDefinition | undefined;
  /** The target's input contract; undefined when it declares none. */
  readonly contract: ResolvedContract | undefined;
  /** The step itself and its item schema — only a step declares a re-attempt. */
  readonly step?: { readonly value: Record<string, any>; readonly schema: Record<string, any> };
}

/** An `x-telo-value-schema-from` slot and the type it must satisfy. */
export interface ValueSchemaSite {
  readonly path: string;
  readonly value: unknown;
  readonly schema: Record<string, any>;
  /** The resource field naming the type. */
  readonly from: string;
}

/** One site, reduced to what decoding needs: the value, its schema, and how to
 *  put a replaced value back. */
export interface DerivedSlot {
  readonly path: string;
  readonly value: unknown;
  readonly schema: Record<string, any>;
  replace(next: unknown): void;
}

function contractScopeOf(ctx: DerivedSlotContext) {
  return analyzerContractScope(
    ctx.defs,
    ctx.aliases,
    { aliasesByModule: ctx.aliasesByModule, rootModules: ctx.rootModules, libraries: ctx.libraries },
    ctx.types,
  );
}

export function callSiteAt(
  origin: CallSite["origin"],
  path: string,
  values: Record<string, any>,
  invoke: Record<string, any>,
  manifest: Record<string, any>,
  ctx: DerivedSlotContext,
  step?: CallSite["step"],
): CallSite {
  const scope = contractScopeOf(ctx);
  const readingModule = (manifest.metadata as { module?: string } | undefined)?.module;
  const invokedKind = typeof invoke.kind === "string" ? invoke.kind : undefined;
  const invokedManifest = isResolvedReference(invoke) ? ctx.resolveTarget(invoke, path) : invoke;
  const invokedDefinition = invokedKind ? scope.resolveIn(invokedKind, readingModule) : undefined;
  return {
    origin,
    path,
    values,
    invoke,
    invokedManifest,
    invokedDefinition,
    contract: resolveContract("inputType", invokedManifest, invokedDefinition, scope),
    ...(step ? { step } : {}),
  };
}

/** One step item of a step body, with what reading its call needs. */
export interface StepItem {
  readonly path: string;
  readonly value: Record<string, any>;
  readonly itemSchema: Record<string, any>;
  /** The field holding its target, and the one holding its arguments. */
  readonly invokeField: string;
  readonly inputsField: string;
}

/** Every step item of `manifest`'s step bodies whose item schema declares an
 *  argument map: the invoke field the step slot names, and whichever sibling
 *  declares `x-telo-topology-role: inputs`. */
export function stepItemsOf(manifest: Record<string, any>, defSchema: Record<string, any>): StepItem[] {
  const out: StepItem[] = [];
  const props = defSchema.properties as Record<string, any> | undefined;
  if (!props) return out;
  for (const [fieldName, fieldSchema] of Object.entries(props)) {
    const slot = readStepSlot(fieldSchema);
    if (!slot) continue;
    const steps = manifest[fieldName];
    if (!Array.isArray(steps)) continue;
    const itemSchema = resolveLocalRef(fieldSchema.items as Record<string, any> | undefined, defSchema);
    if (!itemSchema) continue;
    let inputsField: string | undefined;
    for (const [key, sub] of gatherPropertySchemas(itemSchema)) {
      if (topologyRoleOf(sub) === "inputs") inputsField = key;
    }
    if (!inputsField) continue;
    walkStepArray(steps, itemSchema, defSchema, fieldName, (step, path) => {
      out.push({ path, value: step, itemSchema, invokeField: slot.invoke, inputsField: inputsField! });
    });
  }
  return out;
}

/** The call a step item makes: its argument map against its target; undefined
 *  where it names no target or writes no argument map. */
export function stepCallSiteOf(item: StepItem, manifest: Record<string, any>, ctx: DerivedSlotContext): CallSite | undefined {
  const invoke = item.value[item.invokeField];
  const values = item.value[item.inputsField];
  if (!invoke || typeof invoke !== "object") return undefined;
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  return callSiteAt("step", `${item.path}.${item.inputsField}`, values, invoke, manifest, ctx, {
    value: item.value,
    schema: item.itemSchema,
  });
}

/** Every step's argument map, found through the step grammar. */
export function stepCallSites(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  ctx: DerivedSlotContext,
): CallSite[] {
  return stepItemsOf(manifest, defSchema).flatMap((item) => stepCallSiteOf(item, manifest, ctx) ?? []);
}

/** Every argument map a reference slot names through its `x-telo-ref` `inputs:`
 *  pointer, relative to the object enclosing the slot. */
export function slotCallSites(
  manifest: Record<string, any>,
  sites: readonly ReachSite[],
  ctx: DerivedSlotContext,
): CallSite[] {
  const out: CallSite[] = [];
  for (const site of sites) {
    const inputsPath = slotInputsPath(site);
    if (inputsPath === undefined) continue;
    const invoke = site.data;
    if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) continue;
    const values = navigateConcretePath(manifest, inputsPath);
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    out.push(
      callSiteAt("slot", inputsPath, values as Record<string, any>, invoke as Record<string, any>, manifest, ctx),
    );
  }
  return out;
}

/** The concrete path of the argument map a reference slot names through its
 *  `x-telo-ref` `inputs:` pointer, relative to the object enclosing the slot;
 *  undefined for a slot naming none. */
export function slotInputsPath(site: ReachSite): string | undefined {
  if (site.refs.length === 0) return undefined;
  const inputs = siteRefEntry(site).inputs;
  if (!inputs) return undefined;
  const pointer = pointerSegments(inputs);
  if (!pointer) return undefined;
  const enclosing = site.path.slice(0, Math.max(0, site.path.lastIndexOf(".")));
  return [enclosing, ...pointer].filter(Boolean).join(".");
}

/** A JSON Pointer naming a sibling FIELD path. An array index is not a field,
 *  so a pointer carrying one names nothing this can resolve. */
function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.every((s) => s.length > 0 && !/^\d+$/.test(s)) ? segments : undefined;
}

/**
 * A template definition's top-level `inputs:`, against the input contract of
 * whatever its `invoke:` / `provide:` dispatches to.
 *
 * The sanctioned spelling is a `!ref` naming a `resources:` entry, which is
 * still a sentinel on a definition (`resolveRefSentinels` skips these
 * documents), so it is resolved the one way a dispatch slot ever is —
 * {@link dispatchTargetOf} — and the ENTRY's own declaration is the contract's
 * first layer, exactly as it is when the kernel dispatches to it. The deprecated
 * `{kind, name}` object form resolves through the kind alone, as it always has.
 */
export function templateCallSite(
  manifest: Record<string, any>,
  ctx: DerivedSlotContext,
): CallSite | undefined {
  if (manifest.kind !== "Telo.Definition") return undefined;
  const values = manifest.inputs;
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  const scope = contractScopeOf(ctx);
  const module = (manifest.metadata as { module?: string } | undefined)?.module;

  for (const slot of ["invoke", "provide"] as const) {
    const target = dispatchTargetOf(manifest, slot);
    if (!target) continue;
    const definition = scope.resolveIn(target.kind, module);
    // The entry is authoring data, so a named shape in its contract is still a
    // `!ref`; it is read in the canonical form a registered resource carries.
    const aliases = moduleAliasScope(manifest.metadata, ctx.aliases, ctx.aliasesByModule);
    const entry = target.entry && {
      ...target.entry,
      inputType: withCanonicalRefSentinels(target.entry.inputType, module, (alias) =>
        aliases?.moduleForAlias(alias),
      ),
    };
    return {
      origin: "template",
      path: "inputs",
      values,
      invoke: resolvedReference(target.kind, target.name),
      invokedManifest: entry,
      invokedDefinition: definition,
      contract: resolveContract("inputType", entry, definition, scope),
    };
  }

  const dispatch = [manifest.invoke, manifest.provide].find(
    (d) => d && typeof d === "object" && !Array.isArray(d) && typeof d.kind === "string",
  ) as Record<string, any> | undefined;
  if (!dispatch) return undefined;
  const definition = scope.resolveIn(dispatch.kind, module);
  return {
    origin: "template",
    path: "inputs",
    values,
    invoke: { kind: dispatch.kind },
    invokedManifest: undefined,
    invokedDefinition: definition,
    contract: resolveContract("inputType", undefined, definition, scope),
  };
}

/** What reading a value slot's location needs: the manifests a named type
 *  resolves against, and — for a location crossing a reference — the host that
 *  follows it. Without one a location stays inside the resource. */
export interface ValueSchemaSiteContext {
  /** The declarations a named type resolves against. */
  readonly types: DeclarationRequests;
  readonly valueSchemaHost?: ValueSchemaHost;
}

/** A host for a caller holding no module scope: no path is a reference site, so
 *  a location is read off the resource alone. */
function resourceLocalHost(types: DeclarationRequests): ValueSchemaHost {
  return {
    scope: {
      resolveManifest: () => undefined,
      resolveDefinition: () => undefined,
      referenceSlots: () => [],
    },
    typeSchemaOf: (value, holder) => resolveTypeFieldToSchema(value, types, holder),
  };
}

/** Every `x-telo-value-schema-from` slot, with each type its locations name. A
 *  location naming no type opts out. */
export function valueSchemaSites(
  manifest: Record<string, any>,
  defSchema: Record<string, any> | undefined,
  ctx: ValueSchemaSiteContext,
): ValueSchemaSite[] {
  if (!defSchema) return [];
  const host = ctx.valueSchemaHost ?? resourceLocalHost(ctx.types);
  const out: ValueSchemaSite[] = [];
  for (const { scope, from } of valueSchemaSlots(defSchema)) {
    const label = describeValueSchemaLocation(from);
    for (const { schema: type, member } of valueSchemaTypes(manifest, from, host)) {
      for (const { path, value } of resolveScopeValues(manifest, scope)) {
        if (!member) {
          out.push({ path, value, schema: type, from: label });
          continue;
        }
        // A key the type does not declare contributes nothing.
        const name = memberNameAt(manifest, path, member);
        const schema = name === undefined ? undefined : memberTypeOf(type, name);
        if (schema) out.push({ path, value, schema, from: label });
      }
    }
  }
  return out;
}

/**
 * Every derived slot of ONE resource, for a host that decodes rather than
 * reports: the kernel, at creation. The same enumerators the checks run, over
 * the same resource, in the same scope.
 */
export function derivedSlotsOf(
  resource: ResourceManifest,
  ctx: DerivedSlotContext,
): DerivedSlot[] {
  const manifest = resource as unknown as Record<string, any>;
  const moduleScope = moduleAliasScope(resource.metadata, ctx.aliases, ctx.aliasesByModule);
  const resolvedKind = moduleScope.resolveKind(resource.kind);
  const definition =
    ctx.defs.resolve(resource.kind) ?? (resolvedKind ? ctx.defs.resolve(resolvedKind) : undefined);
  // The author-facing schema, inheritance resolved — the one `telo check` types
  // the resource against, so a slot a parent declares is found on its child.
  const schema = ctx.defs.effectiveSchemaOf(definition) as Record<string, any> | undefined;
  const out: DerivedSlot[] = [];
  const at = (path: string, value: unknown, schema: Record<string, any>) =>
    out.push({ path, value, schema, replace: (next) => assignConcretePath(manifest, path, next) });

  const calls: CallSite[] = [
    ...(schema ? stepCallSites(manifest, schema, ctx) : []),
    ...slotCallSites(
      manifest,
      ctx.defs.referenceSites(resource, ctx.aliases, ctx.aliasesByModule),
      ctx,
    ),
  ];
  const template = templateCallSite(manifest, ctx);
  if (template) calls.push(template);
  for (const call of calls) {
    if (call.contract) at(call.path, call.values, call.contract.schema);
  }
  const valueSchemaHost = valueSchemaHostOf(contractScopeOf(ctx));
  for (const site of valueSchemaSites(manifest, schema, {
    types: ctx.types,
    valueSchemaHost,
  })) {
    at(site.path, site.value, site.schema);
  }
  visitManifest(
    [resource],
    ctx.defs,
    {
      onSchemaFrom: (e) => {
        const slot = { fieldPath: e.fieldPath, path: e.concretePath, value: e.value, holder: e.holder };
        for (const site of schemaFromSites(manifest, slot, e.entry.schemaFrom, ctx)) {
          if (isSchemaFromSite(site)) at(site.path, site.value, site.schema);
        }
      },
    },
    {
      aliases: ctx.aliases,
      aliasesByModule: ctx.aliasesByModule,
      skip: isKindDocument,
    },
  );
  return out;
}
