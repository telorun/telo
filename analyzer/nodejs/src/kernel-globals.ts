import type { ResourceManifest } from "@telorun/sdk";
import type { DeclarationRequests } from "./declaration-requests.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { moduleMetadataSchema } from "./module-metadata-scope.js";
import { inputValueSchema, residualEntrySchemaMap } from "./residual-schema.js";
import { admitsAbsence } from "./configuration-dimensions.js";
import { scopeSiteKey, type ScopeSite } from "./scope-address.js";
import { isScopeMemberDeclaration } from "./scope-members.js";
import { importPathOf } from "./scoped-name-resolver.js";
import type { TemplateBodyResources } from "./template-body-resources.js";
import { applyObservedStateNode, applyReadingNode } from "./validate-observed-state.js";

/**
 * Kernel global names available in every CEL evaluation context at runtime.
 * Both `buildKernelGlobalsSchema` (chain-access validation) and
 * `buildTypedCelEnvironment` in cel-environment.ts (CEL type-checking)
 * must stay in sync with this list.
 *
 * Note: there is no `imports` namespace at runtime — import snapshots are
 * stored under `resources.<alias>`. Host environment variables are reached
 * by declaring a typed `variables:`/`secrets:` entry with an `env:` binding
 * and referencing `variables.X` / `secrets.X`.
 */
export const KERNEL_GLOBAL_NAMES = [
  "variables",
  "secrets",
  "resources",
  "ports",
  "module",
] as const;

/** Kernel globals as ONE resource's declaring module sees them — at `path` on
 *  it, where a scope's members are in `resources` inside that scope's regions
 *  alone. */
export interface KernelGlobalsIndex {
  forResource(m: ResourceManifest, path?: string): Record<string, any>;
}

/** What the `resources` record holds inside a scope. */
export interface ScopedResources {
  /** The scope whose members a CEL read at `path` on `m` sees, if any. */
  at(m: ResourceManifest, path: string): ScopeSite | undefined;
  /** What `site` declares: each member's name and what a read of it is. */
  members(
    site: ScopeSite,
  ): Iterable<{ name: string; status?: Record<string, any>; reading?: Record<string, any> }>;
}

/**
 * Build the typed JSON Schema describing the kernel globals available to each
 * resource in a manifest set. Used to merge into `x-telo-context` schemas so
 * that chain-access validation recognises kernel globals without module authors
 * having to re-declare them.
 *
 * `variables` / `secrets` / `ports` are typed **per declaring module**, because
 * that is the contract the resource's CEL is evaluated against at runtime. An
 * application analysis is flattened — `selectModuleManifestsForAnalysis` drops
 * an imported library's module doc and carries its config blocks across as
 * `metadata.moduleGlobals` instead — so a resource forwarded from a library is
 * typed from that stamp, and everything else from the entry module's own doc
 * (the only module doc left in the set).
 *
 * Typing every resource from the entry doc is what made a library's
 * `variables.x` a hard error the library author could not act on, and — in the
 * other direction — let a library read a variable it never declared whenever the
 * app happened to declare that name.
 *
 * `resources` is NOT per module: it enumerates every non-system resource name in
 * the set, and stays OPEN for a forwarded manifest (see `readModuleGlobals` for
 * why a name list cannot be carried across the boundary honestly).
 */
export function buildKernelGlobalsIndex(
  declarations: DeclarationRequests,
  /** Every resource a CEL read can name, including scope-declared ones (see
   *  `buildObservedStateIndex`). Kinds that declare a `status:` get a typed,
   *  closed `status` node; every other resource node stays open, so no flat read
   *  that passes today can start failing. */
  resources?: ReadonlyMap<
    string,
    { kind: string; status?: Record<string, any>; reading?: Record<string, any> }
  >,
  /** Which resources are functions. A function publishes no reading, so its
   *  name is absent from `resources` and a read of it is an unknown field. */
  functions?: { isFunction(manifest: ResourceManifest): boolean },
  /** Declarations that exist for the analysis alone (a template forward's
   *  views): no `resources.<name>` reaches one at run time. */
  analysisOnly?: ReadonlySet<ResourceManifest>,
  /** The scope members a CEL read sees at a site. */
  scoped?: ScopedResources,
  /** The values one configuration decides, by declaring module: each input
   *  typed as that value. */
  narrowing?: InputNarrowing,
  /** What a template body's own entries add to `resources` inside the body. */
  body?: Pick<TemplateBodyResources, "properties">,
  /** Each declaring module's globals built once, `narrowing` laid over them
   *  entry by entry; without it the blocks are narrowed whole. */
  overlays?: ModuleGlobalsOverlays,
): KernelGlobalsIndex {
  const blocksOf = (doc: ModuleGlobals | Record<string, any> | undefined, decided: DecidedInputs | undefined) =>
    overlays ? overlays.blocks(doc, decided) : globalsBlocks(narrowedGlobals(doc, decided));
  const modules = declarations.moduleDocuments();
  const entryDoc =
    (modules.find((m) => m.kind === "Telo.Application") as
      | Record<string, any>
      | undefined) ??
    (modules.find((m) => m.kind === "Telo.Library") as
      | Record<string, any>
      | undefined);

  const entryDecided = narrowing?.(entryDoc?.metadata?.name as string | undefined);
  const entrySchema = globalsSchema(
    blocksOf(entryDoc, entryDecided),
    narrowedNeeds(
      buildResourcesSchema(
        declarations,
        resources,
        entryDoc?.metadata?.name as string | undefined,
        functions,
        analysisOnly,
      ),
      entryDecided,
    ),
  );
  const openResources = { type: "object", additionalProperties: true };
  const byModule = new Map<string, Record<string, any>>();

  // A scope run's `resources` holds the module's readings plus that run's own
  // members — never an enclosing scope's, which only `!ref` reaches.
  const byScope = new Map<string, Record<string, any>>();
  const withScope = (site: ScopeSite): Record<string, any> => {
    const key = scopeSiteKey(site);
    const cached = byScope.get(key);
    if (cached) return cached;
    const properties: Record<string, any> = { ...entrySchema.properties.resources.properties };
    for (const member of scoped!.members(site)) {
      properties[member.name] = { type: "object", additionalProperties: true };
      if (member.reading) applyReadingNode(properties, member.name, member.reading);
      else if (member.status) applyObservedStateNode(properties, member.name, member.status);
    }
    const schema = {
      ...entrySchema,
      properties: {
        ...entrySchema.properties,
        resources: { ...entrySchema.properties.resources, properties },
      },
    };
    byScope.set(key, schema);
    return schema;
  };

  // Inside a template body `resources` also holds the body's own entries, which
  // shadow a module resource of the same name.
  const layered = new WeakMap<object, WeakMap<object, Record<string, any>>>();
  const withBody = (base: Record<string, any>, entries: Record<string, any>): Record<string, any> => {
    let byBase = layered.get(entries);
    if (!byBase) layered.set(entries, (byBase = new WeakMap()));
    const known = byBase.get(base);
    if (known) return known;
    const schema = {
      ...base,
      properties: {
        ...base.properties,
        resources: {
          ...base.properties.resources,
          properties: { ...base.properties.resources.properties, ...entries },
        },
      },
    };
    byBase.set(base, schema);
    return schema;
  };

  const globalsOf = (m: ResourceManifest, path: string): Record<string, any> => {
    {
      const meta = m.metadata as { module?: string; moduleGlobals?: ModuleGlobals } | undefined;
      const stamped = meta?.moduleGlobals;
      if (!stamped) {
        const site = scoped?.at(m, path);
        return site ? withScope(site) : entrySchema;
      }
      const instance = importPathOf(m);
      const key = instance ? `${meta?.module ?? ""}\0${instance.join("/")}` : (meta?.module ?? "");
      const cached = byModule.get(key);
      if (cached) return cached;
      const schema = globalsSchema(blocksOf(stamped, narrowing?.(meta?.module, instance)), openResources);
      byModule.set(key, schema);
      return schema;
    }
  };

  return {
    forResource(m: ResourceManifest, path = ""): Record<string, any> {
      const base = globalsOf(m, path);
      const entries = body?.properties(m, path);
      return entries ? withBody(base, entries) : base;
    },
  };
}

/** What one configuration decides of a module's inputs: a whole value per
 *  input, or a value per member, each typed as that literal. */
export type InputNarrowing = (
  module: string | undefined,
  /** The instance of a module imported several times. */
  importPath?: readonly string[],
) => DecidedInputs | undefined;

export interface DecidedInputs {
  readonly variables: ReadonlyMap<string, DecidedInput>;
  readonly secrets: ReadonlyMap<string, DecidedInput>;
  /** Each decided read as its chain is written (`variables.dialect`,
   *  `secrets.databaseUrl.scheme`, `resources.databaseAccess.url.scheme`), with
   *  the literal it holds. */
  readonly chains?: ReadonlyMap<string, unknown>;
  /** Each input, and each of the module's own needs, the configuration proves
   *  present, by chain (`secrets.openaiApiKey`, `resources.databaseAccess`):
   *  read as non-null. */
  readonly present?: ReadonlySet<string>;
  /** The module's own needs whose fields' members the configuration decides:
   *  by need, by field, the value type's parameter bound to each member. */
  readonly needs?: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, unknown>>>;
}

export type DecidedInput =
  | { readonly whole: unknown }
  /** Keyed by the value type's parameter bound to each member. */
  | { readonly members: ReadonlyMap<string, unknown> };

/** The entries of a declaring module's `variables` / `secrets` block one
 *  configuration narrows: each decided input's declaration narrowed to its
 *  value, and each input proven present no longer admitting absence. */
function narrowedEntries(
  blockName: "variables" | "secrets",
  block: unknown,
  decided: DecidedInputs,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!block || typeof block !== "object") return out;
  const declared = block as Record<string, unknown>;
  const current = (name: string) => out.get(name) ?? declared[name];
  for (const [name, value] of decided[blockName]) {
    const entry = current(name);
    if (!entry || typeof entry !== "object") continue;
    if ("whole" in value) {
      const narrowed: Record<string, unknown> = { ...(entry as Record<string, unknown>), enum: [value.whole] };
      delete narrowed.const;
      out.set(name, narrowed);
      continue;
    }
    const annotation = (entry as Record<string, unknown>)["x-telo-type"];
    if (!annotation || typeof annotation !== "object") continue;
    const narrowed: Record<string, unknown> = { ...(annotation as Record<string, unknown>) };
    for (const [parameter, member] of value.members) narrowed[parameter] = { enum: [member] };
    out.set(name, { ...(entry as Record<string, unknown>), "x-telo-type": narrowed });
  }
  for (const chain of decided.present ?? []) {
    const [input, name] = chain.split(".");
    const entry = input === blockName ? current(name!) : undefined;
    if (!entry || typeof entry !== "object" || !admitsAbsence(entry as Record<string, unknown>)) continue;
    const present: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
    delete present.default;
    out.set(name!, present);
  }
  return out;
}

/** `doc` with its `variables` / `secrets` blocks copied whole, the entries
 *  `decided` narrows replaced. */
function narrowedGlobals<T extends ModuleGlobals | Record<string, any> | undefined>(
  doc: T,
  decided: DecidedInputs | undefined,
): T {
  if (!doc || !decided) return doc;
  const record = doc as Record<string, any>;
  const narrow = (blockName: "variables" | "secrets") => {
    const block = record[blockName];
    if (!block || typeof block !== "object") return block;
    return { ...block, ...Object.fromEntries(narrowedEntries(blockName, block, decided)) };
  };
  return { ...record, variables: narrow("variables"), secrets: narrow("secrets") } as T;
}

/** The globals a declaring module's blocks give its resources. */
interface GlobalsBlocks {
  readonly variables: Record<string, any>;
  readonly secrets: Record<string, any>;
  readonly ports: Record<string, any>;
  readonly module: Record<string, any>;
}

function globalsBlocks(doc: ModuleGlobals | Record<string, any> | undefined): GlobalsBlocks {
  return {
    variables: buildSchemaMapSchema(doc?.variables as Record<string, any> | undefined),
    secrets: buildSchemaMapSchema(doc?.secrets as Record<string, any> | undefined),
    ports: buildPortsSchema(doc?.ports as Record<string, any> | undefined),
    module: buildModuleSchema(doc),
  };
}

/**
 * Each declaring module's globals, built ONCE from its document — every
 * declared input with its declared type, its ports, its metadata — and the
 * entries one configuration narrows laid over them. A narrowed block is the
 * base block with only those entries replaced, built once per distinct overlay
 * and module, so what a key pays for its module's inputs is the entries it
 * narrows, never the number declared.
 */
export class ModuleGlobalsOverlays {
  private readonly bases = new WeakMap<object, GlobalsBlocks>();
  private readonly overlaid = new WeakMap<object, Map<string, GlobalsBlocks>>();

  blocks(doc: ModuleGlobals | Record<string, any> | undefined, decided: DecidedInputs | undefined): GlobalsBlocks {
    if (!doc) return globalsBlocks(doc);
    let base = this.bases.get(doc);
    if (!base) this.bases.set(doc, (base = globalsBlocks(doc)));
    if (!decided) return base;
    const record = doc as Record<string, any>;
    const variables = narrowedEntries("variables", record.variables, decided);
    const secrets = narrowedEntries("secrets", record.secrets, decided);
    if (variables.size === 0 && secrets.size === 0) return base;
    const text = overlayText([[...variables].sort(byName), [...secrets].sort(byName)]);
    let byText = this.overlaid.get(doc);
    if (!byText) this.overlaid.set(doc, (byText = new Map()));
    const known = byText.get(text);
    if (known) return known;
    const over = (block: Record<string, any>, entries: Map<string, Record<string, unknown>>): Record<string, any> => {
      if (entries.size === 0) return block;
      const properties: Record<string, any> = { ...block.properties };
      for (const [name, entry] of entries) properties[name] = inputValueSchema(entry);
      return { ...block, properties };
    };
    const blocks: GlobalsBlocks = {
      ...base,
      variables: over(base.variables, variables),
      secrets: over(base.secrets, secrets),
    };
    byText.set(text, blocks);
    return blocks;
  }
}

const byName = (a: readonly [string, unknown], b: readonly [string, unknown]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function overlayText(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v));
}

/** The `resources` schema with each of the module's own needs the
 *  configuration proves present read as non-null, and each field member it
 *  decides typed as that value. */
function narrowedNeeds(schema: Record<string, any>, decided: DecidedInputs | undefined): Record<string, any> {
  if (!decided?.present?.size && !decided?.needs?.size) return schema;
  const properties: Record<string, any> = { ...schema.properties };
  for (const chain of decided.present ?? []) {
    if (!chain.startsWith("resources.")) continue;
    const name = chain.slice("resources.".length);
    const node = properties[name];
    if (!node || !Array.isArray(node.type)) continue;
    const type = node.type.filter((t: unknown) => t !== "null");
    properties[name] = { ...node, type: type.length === 1 ? type[0] : type };
  }
  for (const [name, fields] of decided.needs ?? []) {
    const node = properties[name];
    if (!node?.properties) continue;
    const narrowedFields: Record<string, any> = { ...node.properties };
    for (const [field, parameters] of fields) {
      const fieldSchema = narrowedFields[field];
      const annotation = fieldSchema?.["x-telo-type"];
      if (!annotation || typeof annotation !== "object") continue;
      const narrowed: Record<string, unknown> = { ...annotation };
      for (const [parameter, member] of parameters) narrowed[parameter] = { enum: [member] };
      narrowedFields[field] = { ...fieldSchema, "x-telo-type": narrowed };
    }
    properties[name] = { ...node, properties: narrowedFields };
  }
  return { ...schema, properties };
}

/** The blocks a declaring module contributes to its resources' CEL globals. */
interface ModuleGlobals {
  variables?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  ports?: Record<string, unknown>;
  module?: Record<string, unknown>;
}

function globalsSchema(blocks: GlobalsBlocks, resourcesSchema: Record<string, any>): Record<string, any> {
  return {
    type: "object",
    properties: {
      variables: blocks.variables,
      secrets: blocks.secrets,
      resources: resourcesSchema,
      ports: blocks.ports,
      module: blocks.module,
    },
  };
}

/** The `module` namespace. Derived by `moduleMetadataSchema`, the same call the
 *  CEL environment types from, so the two cannot disagree about which fields
 *  exist or whether the namespace is closed. */
function buildModuleSchema(doc: ModuleGlobals | Record<string, any> | undefined): Record<string, any> {
  return (
    moduleMetadataSchema(
      ((doc as ModuleGlobals | undefined)?.module ?? (doc as any)?.metadata) as
        | Record<string, unknown>
        | undefined,
    ) ?? { type: "object", additionalProperties: true }
  );
}

/** The reading of a resource whose name a record lists and whose content the
 *  analysis does not hold: an object holding no member, so any member read of
 *  it is refused. */
function withheldReading(): Record<string, any> {
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Every non-system resource name the entry module declares, plus the
 *  scope-declared ones. */
function buildResourcesSchema(
  declarations: DeclarationRequests,
  resources:
    | ReadonlyMap<
        string,
        {
          kind: string;
          status?: Record<string, any>;
          reading?: Record<string, any>;
          forwardedFrom?: string;
          scoped?: boolean;
        }
      >
    | undefined,
  entryModule: string | undefined,
  functions: { isFunction(manifest: ResourceManifest): boolean } | undefined,
  analysisOnly: ReadonlySet<ResourceManifest> | undefined,
): Record<string, any> {
  const resourceProps: Record<string, any> = {};
  const withheld = new Set<string>();
  /** Names an extraction generated: the author never wrote one, so no message
   *  lists it and no expression reads it. */
  const generated = new Set<string>();
  /** Names listed with no content: read whole, never by a member. */
  const inert = new Set<string>();
  for (const m of declarations.published()) {
    const name = m.metadata?.name as string | undefined;
    if (!name || !m.kind) continue;
    const origin = (m.metadata as { xTeloOrigin?: { named?: true } } | undefined)?.xTeloOrigin;
    if (origin !== undefined && origin.named !== true) {
      generated.add(name);
      continue;
    }
    // A scope member is in `resources` only inside its scope.
    if (isScopeMemberDeclaration(m)) continue;
    // A forward view exists for the analysis alone: nothing publishes it.
    if (analysisOnly?.has(m)) {
      withheld.add(name);
      continue;
    }
    // A dependency's code is not in the consumer's `resources`: an export is read
    // as `resources.<Alias>.<name>`, and what extraction pulled out of one is
    // reachable under no name at all.
    if (isForwardedDeclaration(m)) continue;
    // Nor are the imports a dependency declares for itself: its aliases publish
    // into its own module's `resources`.
    const module = m.metadata?.module;
    if (
      m.kind === "Telo.Import" &&
      entryModule !== undefined &&
      typeof module === "string" &&
      module !== entryModule
    ) {
      continue;
    }
    // A kind document and a module document publish nothing. Telo.Import
    // snapshots are stored under resources.<alias> at runtime, so they appear
    // here alongside regular resources.
    if (isKindDocument(m) || isModuleKind(m.kind)) continue;
    if (functions?.isFunction(m)) {
      withheld.add(name);
      continue;
    }
    if (declarations.holdsContentOf?.(m) === false) {
      inert.add(name);
      resourceProps[name] = withheldReading();
      continue;
    }
    resourceProps[name] = { type: "object", additionalProperties: true };
  }
  for (const [key, entry] of resources ?? []) {
    if (key.includes(".") || entry.forwardedFrom !== undefined || entry.scoped || withheld.has(key) || inert.has(key) || generated.has(key)) {
      continue;
    }
    resourceProps[key] ??= { type: "object", additionalProperties: true };
    if (entry.reading) applyReadingNode(resourceProps, key, entry.reading);
    else if (entry.status) applyObservedStateNode(resourceProps, key, entry.status);
  }
  // Imports' exported instances publish two levels deep (`resources.<Alias>.<name>`);
  // the alias node stays open so its other keys keep resolving.
  for (const [key, entry] of resources ?? []) {
    if (!key.includes(".") || entry.forwardedFrom !== undefined || entry.scoped || withheld.has(key) || generated.has(key)) {
      continue;
    }
    if (entry.reading) applyReadingNode(resourceProps, key, entry.reading);
    else if (entry.status) applyObservedStateNode(resourceProps, key, entry.status);
  }

  return { type: "object", properties: resourceProps, additionalProperties: false };
}

/** Build the closed `ports` chain-access schema: each declared port is an
 *  integer, so `ports.<name>` resolves and `ports.typo` (or member access past
 *  a port, like `ports.http.foo`) is flagged. Falls back to an open map when
 *  the module declares no ports. */
function buildPortsSchema(
  ports: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) {
    return { type: "object", additionalProperties: true };
  }
  const props: Record<string, any> = {};
  for (const name of Object.keys(ports)) {
    props[name] = { type: "integer" };
  }
  if (Object.keys(props).length === 0) {
    return { type: "object", additionalProperties: true };
  }
  return { type: "object", properties: props, additionalProperties: false };
}

/** Wrap a JSON Schema property map (like `Telo.Application.variables`) into a
 *  closed object schema suitable for chain-access validation. For Application
 *  entries the per-entry shape carries kernel-specific keys (`env`, `default`)
 *  on top of an otherwise-standard JSON Schema property schema; those keys are
 *  stripped via `residualEntrySchemaMap` so CEL sees the coerced shape, not
 *  the env-binding wrapper. Library entries are pure JSON Schema property
 *  schemas and pass through the same call unchanged. Falls back to an open map
 *  when the module declares no variables/secrets. */
function buildSchemaMapSchema(
  schemaMap: Record<string, any> | null | undefined,
): Record<string, any> {
  const props = residualEntrySchemaMap(schemaMap);
  // An entry declaring `default: null` may be absent: CEL reads it as nullable.
  for (const name of Object.keys(props)) props[name] = inputValueSchema(schemaMap![name]);
  if (Object.keys(props).length === 0) {
    return { type: "object", additionalProperties: true };
  }
  return {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
}

/**
 * Merge kernel globals into an `x-telo-context` schema so chain-access
 * validation recognises `variables`, `secrets`, `resources`, `ports`
 * without module authors having to re-declare them.
 *
 * Context-specific properties take precedence over globals (spread order).
 * The original `additionalProperties` setting is preserved.
 */
export function mergeKernelGlobalsIntoContext(
  contextSchema: Record<string, any>,
  globalsSchema: Record<string, any>,
): Record<string, any> {
  return {
    ...contextSchema,
    properties: {
      ...globalsSchema.properties,
      ...(contextSchema.properties ?? {}),
    },
    additionalProperties: contextSchema.additionalProperties ?? false,
  };
}
