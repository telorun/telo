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
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import {
  analyzerContractScope,
  resolveContract,
  type ResolvedContract,
} from "./invocation-contract.js";
import { assignConcretePath, navigateConcretePath } from "./manifest-path.js";
import { visitManifest } from "./manifest-visitor.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { isRefEntry, resolveFieldEntries, type ReferenceFieldMap } from "./reference-field-map.js";
import { withCanonicalRefSentinels } from "./resolve-schema-type-refs.js";
import { isSchemaFromSite, schemaFromSites } from "./schema-from-sites.js";
import { gatherPropertySchemas, resolveLocalRef, walkStepArray } from "./schema-walk.js";
import { readStepSlot } from "./step-slot.js";
import { dispatchTargetOf } from "./template-body.js";
import { REF_VALIDATION_SKIP_KINDS } from "./system-kinds.js";
import { resolveTypeFieldToSchema } from "./validate-cel-context.js";

/** What resolving a site needs from its host. */
export interface DerivedSlotContext {
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The manifests a named type resolves against. */
  readonly typeManifests: Record<string, any>[];
  /** The declaration a `{kind, name, alias?}` reference names, or undefined. */
  resolveTarget(ref: Record<string, any>): Record<string, any> | undefined;
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
    { aliasesByModule: ctx.aliasesByModule, rootModules: ctx.rootModules },
    ctx.typeManifests,
  );
}

function callSite(
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
  const invokedManifest =
    typeof invoke.name === "string" ? ctx.resolveTarget(invoke) : invoke;
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

/** Every step's argument map, found through the step grammar: the invoke field
 *  the step slot names, and whichever sibling declares `x-telo-topology-role:
 *  inputs`. */
export function stepCallSites(
  manifest: Record<string, any>,
  defSchema: Record<string, any>,
  ctx: DerivedSlotContext,
): CallSite[] {
  const out: CallSite[] = [];
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
      if (sub?.["x-telo-topology-role"] === "inputs") inputsField = key;
    }
    if (!inputsField) continue;
    walkStepArray(steps, itemSchema, defSchema, fieldName, (step, stepPath) => {
      const invoke = step[slot.invoke];
      const values = step[inputsField!];
      if (!invoke || typeof invoke !== "object") return;
      if (!values || typeof values !== "object" || Array.isArray(values)) return;
      out.push(
        callSite("step", `${stepPath}.${inputsField}`, values, invoke, manifest, ctx, {
          value: step,
          schema: itemSchema,
        }),
      );
    });
  }
  return out;
}

/** Every argument map a reference slot names through its `x-telo-ref` `inputs:`
 *  pointer, relative to the object enclosing the slot. */
export function slotCallSites(
  manifest: Record<string, any>,
  fieldMap: ReferenceFieldMap | undefined,
  ctx: DerivedSlotContext,
): CallSite[] {
  const out: CallSite[] = [];
  if (!fieldMap) return out;
  for (const [fieldPath, entry] of fieldMap) {
    if (!isRefEntry(entry) || !entry.inputs) continue;
    const pointer = pointerSegments(entry.inputs);
    if (!pointer) continue;
    for (const { value: invoke, path: slotPath } of resolveFieldEntries(manifest, fieldPath)) {
      if (!invoke || typeof invoke !== "object" || Array.isArray(invoke)) continue;
      const enclosing = slotPath.slice(0, Math.max(0, slotPath.lastIndexOf(".")));
      const inputsPath = [enclosing, ...pointer].filter(Boolean).join(".");
      const values = navigateConcretePath(manifest, inputsPath);
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      out.push(
        callSite("slot", inputsPath, values as Record<string, any>, invoke as Record<string, any>, manifest, ctx),
      );
    }
  }
  return out;
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
      invoke: { kind: target.kind, name: target.name },
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

/** Every `x-telo-value-schema-from` slot, with the type its field names. A field
 *  naming no type opts out. */
export function valueSchemaSites(
  manifest: Record<string, any>,
  defSchema: Record<string, any> | undefined,
  ctx: Pick<DerivedSlotContext, "typeManifests">,
): ValueSchemaSite[] {
  if (!defSchema) return [];
  const out: ValueSchemaSite[] = [];
  for (const { scope, from } of valueSchemaAnnotations(defSchema, "$")) {
    const schema = resolveTypeFieldToSchema(manifest[from], ctx.typeManifests);
    if (!schema || typeof schema !== "object") continue;
    for (const { path, value } of resolveScopeValues(manifest, scope)) {
      out.push({ path, value, schema, from });
    }
  }
  return out;
}

const VALUE_SCHEMA_ANNOTATION = "x-telo-value-schema-from";

function valueSchemaAnnotations(
  schema: Record<string, any>,
  path: string,
): Array<{ scope: string; from: string }> {
  if (!schema || typeof schema !== "object") return [];
  const out: Array<{ scope: string; from: string }> = [];
  const from = schema[VALUE_SCHEMA_ANNOTATION];
  if (typeof from === "string" && from.length > 0) out.push({ scope: path, from });
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      out.push(...valueSchemaAnnotations(value, `${path}.${key}`));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    out.push(...valueSchemaAnnotations(schema.items, `${path}[*]`));
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(schema[key])) {
      for (const sub of schema[key]) out.push(...valueSchemaAnnotations(sub, path));
    }
  }
  return out;
}

/** Expand a `$.a[*].b` scope into the concrete values present, each with its path. */
function resolveScopeValues(
  manifest: Record<string, any>,
  scope: string,
): Array<{ path: string; value: unknown }> {
  const stripped = scope.startsWith("$.") ? scope.slice(2) : scope;
  if (!stripped) return [];
  let frontier: Array<{ path: string; value: unknown }> = [{ path: "", value: manifest }];
  for (const segment of stripped.split(".")) {
    const wildcard = segment.endsWith("[*]");
    const name = wildcard ? segment.slice(0, -3) : segment;
    const next: Array<{ path: string; value: unknown }> = [];
    for (const entry of frontier) {
      const container = entry.value as Record<string, unknown> | undefined;
      if (!container || typeof container !== "object") continue;
      const child = container[name];
      if (child === undefined) continue;
      const childPath = entry.path ? `${entry.path}.${name}` : name;
      if (!wildcard) {
        next.push({ path: childPath, value: child });
        continue;
      }
      if (!Array.isArray(child)) continue;
      child.forEach((item, i) => next.push({ path: `${childPath}[${i}]`, value: item }));
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier;
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
      ctx.defs.expandedFieldMapForResource(resource, ctx.aliases, ctx.aliasesByModule),
      ctx,
    ),
  ];
  const template = templateCallSite(manifest, ctx);
  if (template) calls.push(template);
  for (const call of calls) {
    if (call.contract) at(call.path, call.values, call.contract.schema);
  }
  for (const site of valueSchemaSites(manifest, schema, ctx)) {
    at(site.path, site.value, site.schema);
  }
  visitManifest(
    [resource],
    ctx.defs,
    {
      onSchemaFrom: (e) => {
        for (const site of schemaFromSites(manifest, e.fieldPath, e.entry.schemaFrom, ctx)) {
          if (isSchemaFromSite(site)) at(site.path, site.value, site.schema);
        }
      },
    },
    {
      aliases: ctx.aliases,
      aliasesByModule: ctx.aliasesByModule,
      skipKinds: REF_VALIDATION_SKIP_KINDS,
      expand: false,
    },
  );
  return out;
}
