/**
 * Which of an application's inputs each configuration requires.
 *
 * An Application `variables:` / `secrets:` / `ports:` entry with no `default:`
 * is required in exactly the configurations in which a manifest read reaches
 * it — a CEL read in a resource or a field that exists in that configuration,
 * or an import's binding forwarding it — and a dimension always (it decides the
 * configuration). An entry declaring `default: null` is never required. A need
 * that is not optional is required in exactly the configurations its fields'
 * reads, its `!ref`s or an import forwarding it reach; a library's need the
 * environment is read for is required where the library's own documents reach
 * it, translated through each import's binding at every level between it and
 * the application.
 *
 * What counts as a read: a kind document's in the configurations where its
 * kind is instantiated (by a declaration, through `extends`, or through the
 * template body of an instantiated kind); a ternary whose guard a
 * configuration decides, only the taken arm's; a whole `variables` / `secrets`
 * / `ports` / `resources` read, every entry. Manifest reads only — a
 * controller reads a module's inputs through its resource's fields.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { celExpressionsOf, isExpansionSentinel, isTaggedSentinel, walkCelExpressions } from "@telorun/templating";
import { wrapCelAst, type CelNode } from "./cel-ast.js";
import { parseCelSource } from "./cel-environment.js";
import { expandChoices, isStandInDeclaration } from "./choice-expansion.js";
import { readChoices, type ChoiceReading } from "./choice-reading.js";
import {
  ABSENT,
  admitsAbsence,
  assignmentKey,
  enumerateConfigurations,
  memberOfValue,
  needDimensionKey,
  PRESENT,
  agreesWith,
  requiredWhenOf,
  type Assignment,
  type Dimension,
} from "./configuration-dimensions.js";
import { isKindDocument } from "./kind-declaration.js";
import { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { DURABLE_DIRECTORY_TYPE, STATE_DIR_HOST_VALUE } from "./durable-directory.js";
import { needSupplyOf, readNeeds, readSuppliedNeeds } from "./need-type.js";
import type { NeedEnvironmentEntry, NeedTable } from "./need-table.js";
import { addressNeedPorts, PUBLIC_URL_HOST_VALUES, PUBLIC_URL_TYPE } from "./public-address.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference } from "./resolved-reference.js";
import { readResourceInputs, readSuppliedResources } from "./resource-input.js";

/** One input of an application and the configurations requiring it. */
export interface InputRequirement {
  readonly block: "variables" | "secrets" | "ports" | "needs";
  /** The entry's name; a need's path, `.`-joined. */
  readonly name: string;
  /** False when no configuration requires it. */
  readonly required: boolean;
  /** The configurations requiring it, as partial assignments keyed by
   *  dimension; absent when every configuration does. */
  readonly requiredWhen?: readonly Assignment[];
}

export interface InputRequirements {
  /** The dimensions requirement is decided over: the choices' own, and the
   *  presence of each optional need a library leaves to the environment. */
  readonly dimensions: readonly Dimension[];
  readonly configurations: readonly Assignment[];
  readonly inputs: readonly InputRequirement[];
  /** Whether `input` is required in `assignment` — an assignment of every
   *  dimension: it is when some `requiredWhen` entry agrees with it on every
   *  key the entry names. */
  requiredIn(input: Pick<InputRequirement, "block" | "name">, assignment: Assignment): boolean;
}

type Block = "variables" | "secrets" | "ports" | "resources";
const BLOCKS: ReadonlySet<string> = new Set(["variables", "secrets", "ports", "resources"]);

/** What one set of documents reads: entries by block (`*` for the whole
 *  record), and the names its `!ref`s name. */
interface Reads {
  readonly entries: Map<Block, Set<string>>;
  readonly refs: Set<string>;
}

function emptyReads(): Reads {
  return { entries: new Map([...BLOCKS].map((b) => [b as Block, new Set<string>()])), refs: new Set() };
}

/**
 * The dimensions an application's requirement is decided over: its choices'
 * own, and the presence of each optional need a library leaves to the
 * environment (`needTable`'s), whether or not a choice reads it — what a load
 * resolves before it expands its documents.
 */
export function requirementDimensionsOf(choices: ChoiceReading, needTable: NeedTable | undefined): Dimension[] {
  const dimensions: Dimension[] = [...choices.dimensions];
  const keys = new Set(dimensions.map((d) => d.key));
  for (const entry of needTable?.environment ?? []) {
    if (entry.path.length < 2 || !entry.need.optional) continue;
    const key = needDimensionKey(entry.path);
    if (keys.has(key)) continue;
    keys.add(key);
    dimensions.push({
      key,
      input: "resources",
      name: entry.path.join("."),
      projection: "presence",
      needPath: entry.path,
      values: [PRESENT, ABSENT],
      declaration: {},
    });
  }
  return dimensions;
}

/**
 * The requirements of the application whose analysed set is `manifests`, over
 * `choices` (its reading), `needTable` (the paths a need is read from the
 * environment under) and `libraries` (each imported library's documents).
 */
export function inputRequirements(
  manifests: readonly ResourceManifest[],
  choices: ChoiceReading,
  needTable: NeedTable | undefined,
  libraries: readonly ModuleDocuments[],
): InputRequirements {
  const root = manifests.find((m) => m.kind === "Telo.Application") as Record<string, any> | undefined;
  const rootName = root?.metadata?.name as string | undefined;
  const ownNeeds = readNeeds(root);
  const callNames = moduleCallNamesByModule(manifests);

  const dimensions = requirementDimensionsOf(choices, needTable);
  const keys = new Set(dimensions.map((d) => d.key));
  const configurations = enumerateConfigurations(dimensions);
  /** The assignment of the choices' own dimensions within `assignment`. */
  const own = (assignment: Assignment) => {
    const out: Record<string, unknown> = {};
    for (const d of choices.dimensions) out[d.key] = assignment[d.key];
    return out;
  };

  const ownModule = (m: ResourceManifest) => {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    return typeof module !== "string" || module === rootName;
  };

  /** The reads of the application's own documents in one configuration. */
  const rootReads = new Map<string, Reads>();
  const readsIn = (assignment: Assignment): Reads => {
    const key = assignmentKey(own(assignment));
    const known = rootReads.get(key);
    if (known) return known;
    const expanded = expandChoices(manifests, choices.decide(own(assignment))).manifests.filter(
      (m) => !isStandInDeclaration(m) && ownModule(m),
    );
    const reads = documentReads(expanded, rootName, (m, source) => choices.valueIn(m, source, own(assignment)), callNames);
    rootReads.set(key, reads);
    return reads;
  };

  const out: InputRequirement[] = [];
  const predicates = new Map<string, (assignment: Assignment) => boolean>();
  const demands = new Map<string, { required: boolean; requiredWhen?: readonly Assignment[] }>();
  const record = (block: InputRequirement["block"], name: string, test: (a: Assignment) => boolean) => {
    predicates.set(`${block}\0${name}`, test);
    const holding = configurations.filter(test);
    const requiredWhen = requiredWhenOf(holding, configurations, dimensions);
    demands.set(`${block}\0${name}`, {
      required: holding.length > 0,
      ...(requiredWhen ? { requiredWhen } : {}),
    });
    out.push({
      block,
      name,
      required: holding.length > 0,
      ...(requiredWhen && holding.length > 0 ? { requiredWhen } : {}),
    });
  };

  // The application's own inputs.
  const dimensionInputs = new Set(
    choices.dimensions.filter((d) => d.input !== "resources").map((d) => `${d.input}.${d.name}`),
  );
  const addressPorts = new Set(root ? addressNeedPorts(root) : []);
  for (const block of ["variables", "secrets", "ports"] as const) {
    const entries = root?.[block];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, entry] of Object.entries(entries as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry !== "object") continue;
      if (admitsAbsence(entry) || entry.default !== undefined) {
        record(block, name, () => false);
        continue;
      }
      if (dimensionInputs.has(`${block}.${name}`) || (block === "ports" && addressPorts.has(name))) {
        record(block, name, () => true);
        continue;
      }
      record(block, name, (a) => {
        const read = readsIn(a).entries.get(block)!;
        return read.has("*") || read.has(name);
      });
    }
  }

  // What each library the application imports requires, translated through
  // every import level to this application's dimensions.
  const ownOptional = new Map(ownNeeds.map((need) => [need.name, need.optional]));
  const translated = importRequirements(
    manifests.filter((m) => {
      if (m.kind !== "Telo.Import") return false;
      const module = (m.metadata as { module?: unknown } | undefined)?.module;
      return module === undefined || module === rootName;
    }),
    keys,
    ownOptional,
    (path, field, member) => needDimensionKey(path.segments, field, member),
    { manifests, libraries, callNames, memo: new Map(), active: new Set() },
  );
  // A `shared` library imported twice reaches one need through both imports.
  for (const item of translated.environment) {
    const key = `needs\0${item.path.segments.join(".")}`;
    const previous = predicates.get(key);
    predicates.set(key, previous ? (a) => previous(a) || item.test(a) : item.test);
  }

  // The application's own needs.
  for (const need of ownNeeds) {
    if (need.optional) {
      record("needs", need.name, () => false);
      continue;
    }
    const memberDimension = choices.dimensions.some((d) => d.needPath?.length === 1 && d.needPath[0] === need.name);
    const forwards = translated.forwarded.get(need.name) ?? [];
    record("needs", need.name, (a) => {
      if (memberDimension) return true;
      const reads = readsIn(a);
      const read = reads.entries.get("resources")!;
      return (
        read.has("*") ||
        read.has(need.name) ||
        reads.refs.has(need.name) ||
        translated.opaque.has(need.name) ||
        forwards.some((f) => f(a))
      );
    });
  }

  // Every other need the environment is read for: a library's.
  for (const entry of needTable?.environment ?? []) {
    if (entry.path.length < 2) continue;
    const name = entry.path.join(".");
    if (entry.need.optional) {
      record("needs", name, () => false);
      continue;
    }
    record("needs", name, predicates.get(`needs\0${name}`) ?? (() => true));
  }

  return {
    dimensions,
    configurations,
    inputs: out,
    requiredIn(input, assignment) {
      const demand = demands.get(`${input.block}\0${input.name}`);
      if (!demand) return true;
      return demand.required && (demand.requiredWhen === undefined || demand.requiredWhen.some((e) => agreesWith(e, assignment)));
    },
  };
}

/** A need path below a module: relative to it, or — a `shared` library's —
 *  from the application root whatever the depth. */
interface NeedPathBelow {
  readonly segments: readonly string[];
  readonly rooted: boolean;
}

/** What one module's imports require of their libraries' needs, in that
 *  module's terms: each need the environment is read for, by its path below the
 *  module, and each need forwarded whole from one of the module's own needs. */
interface ImportedRequirements {
  readonly environment: Array<{ path: NeedPathBelow; optional: boolean; test: (a: Assignment) => boolean }>;
  readonly forwarded: Map<string, Array<(a: Assignment) => boolean>>;
  /** The module's own needs forwarded to an import whose library the analysis
   *  holds no documents for: reached whatever it requires. */
  readonly opaque: Set<string>;
}

interface RequirementContext {
  /** The application's analysed set: its imports carry each target's source. */
  readonly manifests: readonly ResourceManifest[];
  readonly libraries: readonly ModuleDocuments[];
  readonly callNames: ReturnType<typeof moduleCallNamesByModule>;
  readonly memo: Map<ModuleDocuments, LibraryRequirement>;
  readonly active: Set<ModuleDocuments>;
}

/** The library documents an import reaches. */
function importTarget(importDoc: ResourceManifest, context: RequirementContext): ModuleDocuments | undefined {
  const meta = importDoc.metadata as
    | { name?: string; source?: string; resolvedModuleName?: string; resolvedSource?: string }
    | undefined;
  if (!meta?.name) return undefined;
  // A library's own import carries its target on the analysed set's copy.
  const stamped =
    meta.resolvedSource !== undefined
      ? meta
      : (context.manifests.find(
          (m) =>
            m.kind === "Telo.Import" &&
            m.metadata?.name === meta.name &&
            (m.metadata as { source?: string }).source === meta.source,
        )?.metadata as { resolvedModuleName?: string; resolvedSource?: string } | undefined);
  const bySource = context.libraries.find((d) => d.sourceId === stamped?.resolvedSource);
  if (bySource) return bySource;
  const named = context.libraries.filter((d) => d.module === stamped?.resolvedModuleName);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * What the libraries `imports` reach require of their needs, translated through
 * each import's binding into the importing module's configurations (`keys` its
 * dimensions, `ownNeeds` its needs by optionality, `keyOf` the key of a need
 * below it). A library's requirement is derived once, over its own
 * configurations: a literal or a supply is a fact, a bare chain to one of the
 * importer's dimensions is that dimension, an unsupplied optional need its
 * presence dimension, and anything else decides nothing, so the need is
 * required whatever that library dimension holds.
 */
function importRequirements(
  imports: readonly ResourceManifest[],
  keys: ReadonlySet<string>,
  ownNeeds: ReadonlyMap<string, boolean>,
  keyOf: (path: NeedPathBelow, field?: string, member?: string) => string,
  context: RequirementContext,
): ImportedRequirements {
  const out: ImportedRequirements = { environment: [], forwarded: new Map(), opaque: new Set() };
  for (const importDoc of imports) {
    const alias = importDoc.metadata?.name as string | undefined;
    if (!alias) continue;
    const supplied = readSuppliedNeeds(importDoc);
    const target = importTarget(importDoc, context);
    if (!target || context.active.has(target)) {
      for (const value of Object.values(supplied)) {
        const supply = needSupplyOf(value);
        if (supply.form === "whole" && supply.target.alias === undefined) out.opaque.add(supply.target.name);
      }
      continue;
    }
    let requirement = context.memo.get(target);
    if (!requirement) {
      context.active.add(target);
      requirement = libraryRequirement(target, context);
      context.active.delete(target);
      context.memo.set(target, requirement);
    }
    const library = requirement;
    const libraryDoc = target.manifests.find((m) => m.kind === "Telo.Library") as Record<string, any> | undefined;
    const shared = libraryDoc?.lifecycle === "shared";
    const below = (path: NeedPathBelow): NeedPathBelow =>
      path.rooted
        ? path
        : shared
          ? { segments: [target.module, ...path.segments], rooted: true }
          : { segments: [alias, ...path.segments], rooted: false };

    // Each library dimension as the importer reads it.
    const resourceInputs = new Set(readResourceInputs(libraryDoc).map((input) => input.name));
    const suppliedResources = readSuppliedResources(importDoc);
    const translate = (dimension: Dimension): { key: string } | { fact: unknown } | undefined => {
      if (dimension.input === "resources") {
        // A resource input's presence is whether the import supplies it.
        const input = dimension.needPath?.length === 1 ? dimension.needPath[0]! : undefined;
        if (input !== undefined && resourceInputs.has(input)) {
          return { fact: Object.hasOwn(suppliedResources, input) ? PRESENT : ABSENT };
        }
        const nested = library.nested.get(dimension.key);
        if (nested) {
          const key = keyOf(below(nested));
          return keys.has(key) ? { key } : undefined;
        }
        const need = dimension.needPath?.[0];
        const written = need !== undefined ? supplied[need] : undefined;
        if (written === undefined) {
          const key = keyOf(below({ segments: dimension.needPath ?? [], rooted: false }), dimension.field, dimension.member);
          return keys.has(key) ? { key } : undefined;
        }
        const supply = needSupplyOf(written);
        if (supply.form === "whole" && supply.target.alias === undefined && ownNeeds.has(supply.target.name)) {
          const key = keyOf({ segments: [supply.target.name], rooted: false }, dimension.field, dimension.member);
          if (keys.has(key)) return { key };
          // A required need is present wherever the module runs; an optional
          // one no dimension decides is left undecided.
          return dimension.projection === "presence" && ownNeeds.get(supply.target.name) === false
            ? { fact: PRESENT }
            : undefined;
        }
        return dimension.projection === "presence" ? { fact: PRESENT } : undefined;
      }
      const block = (importDoc as Record<string, any>)[dimension.input];
      const written = block && typeof block === "object" ? block[dimension.name] : undefined;
      const value = written === undefined ? dimension.declaration.default : written;
      if (!isTaggedSentinel(value)) {
        if (dimension.projection === "presence") return { fact: value === null || value === undefined ? ABSENT : PRESENT };
        if (dimension.projection === "member") {
          const member = memberOfValue(dimension.declaration, value, dimension.member!);
          return member === undefined ? undefined : { fact: member };
        }
        return { fact: value ?? null };
      }
      const source = (value as { engine?: string; source?: string }).source?.trim();
      const chain = /^(variables|secrets)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(source ?? "");
      if (!chain || (value as { engine?: string }).engine !== "cel") return undefined;
      const key = dimension.projection === "member" ? `${chain[0]}.${dimension.member}` : chain[0]!;
      return keys.has(key) ? { key } : undefined;
    };
    /** Whether an importer configuration agrees with a library one. */
    const agrees = (assignment: Assignment, a: Assignment) =>
      library.dimensions.every((dimension) => {
        const meaning = translate(dimension);
        if (!meaning) return true;
        const value = assignment[dimension.key];
        return "fact" in meaning ? meaning.fact === value : a[meaning.key] === value;
      });
    const testOf = (holding: readonly Assignment[]) => (a: Assignment) => holding.some((l) => agrees(l, a));

    for (const [need, { optional, holding }] of library.needs) {
      const test = testOf(holding);
      const written = supplied[need];
      if (written === undefined) {
        out.environment.push({ path: below({ segments: [need], rooted: false }), optional, test });
        continue;
      }
      const supply = needSupplyOf(written);
      if (supply.form === "whole" && supply.target.alias === undefined && ownNeeds.has(supply.target.name)) {
        out.forwarded.set(supply.target.name, [...(out.forwarded.get(supply.target.name) ?? []), test]);
      }
    }
    for (const item of library.environment) {
      out.environment.push({ path: below(item.path), optional: item.optional, test: testOf(item.holding) });
    }
  }
  return out;
}

/** What one library requires of its needs, over its own configurations: each
 *  of its own needs, and each need of a library it imports that its import
 *  leaves to the environment. */
interface LibraryRequirement {
  /** The library's dimensions: its choices' own, and the presence of each
   *  optional need of a library it imports left to the environment. */
  readonly dimensions: readonly Dimension[];
  /** Of those, each nested need's presence by key: the need's path below the
   *  library. */
  readonly nested: ReadonlyMap<string, NeedPathBelow>;
  readonly needs: Map<string, { optional: boolean; holding: Assignment[] }>;
  readonly environment: Array<{ path: NeedPathBelow; optional: boolean; holding: Assignment[] }>;
}

function libraryRequirement(documents: ModuleDocuments, context: RequirementContext): LibraryRequirement {
  const all = documents.manifests;
  const sentinels = all.filter(isExpansionSentinel);
  const declarations = all.filter((m) => !sentinels.includes(m));
  const choices = readChoices(declarations, sentinels);
  const libraryDoc = all.find((m) => m.kind === "Telo.Library");
  const declared = readNeeds(libraryDoc);
  const libraryName = libraryDoc?.metadata?.name as string | undefined;

  const dimensions: Dimension[] = [...choices.dimensions];
  const keys = new Set(dimensions.map((d) => d.key));
  const nestedKey = (path: NeedPathBelow, field?: string, member?: string) =>
    `${path.rooted ? "/" : ""}${needDimensionKey(path.segments, field, member)}`;
  const imported = importRequirements(
    all.filter((m) => m.kind === "Telo.Import"),
    keys,
    new Map(declared.map((need) => [need.name, need.optional])),
    nestedKey,
    context,
  );
  const nested = new Map<string, NeedPathBelow>();
  for (const item of imported.environment) {
    if (!item.optional) continue;
    const key = nestedKey(item.path);
    if (keys.has(key)) continue;
    keys.add(key);
    nested.set(key, item.path);
    dimensions.push({
      key,
      input: "resources",
      name: item.path.segments.join("."),
      projection: "presence",
      values: [PRESENT, ABSENT],
      declaration: {},
    });
  }
  const configurations = enumerateConfigurations(dimensions);
  const own = (assignment: Assignment) => {
    const out: Record<string, unknown> = {};
    for (const d of choices.dimensions) out[d.key] = assignment[d.key];
    return out;
  };
  const readsOf = new Map<string, Reads>();
  const readsIn = (assignment: Assignment): Reads => {
    const key = assignmentKey(own(assignment));
    const known = readsOf.get(key);
    if (known) return known;
    const expanded = expandChoices(all, choices.decide(own(assignment))).manifests.filter((m) => !isStandInDeclaration(m));
    const reads = documentReads(expanded, libraryName, (m, source) => choices.valueIn(m, source, own(assignment)), context.callNames);
    readsOf.set(key, reads);
    return reads;
  };

  const needs = new Map<string, { optional: boolean; holding: Assignment[] }>();
  for (const need of declared) {
    const forwards = imported.forwarded.get(need.name) ?? [];
    const holding = configurations.filter((a) => {
      const reads = readsIn(a);
      const resources = reads.entries.get("resources")!;
      return (
        resources.has("*") ||
        resources.has(need.name) ||
        reads.refs.has(need.name) ||
        imported.opaque.has(need.name) ||
        forwards.some((f) => f(a))
      );
    });
    needs.set(need.name, { optional: need.optional, holding });
  }
  const environment = imported.environment.map((item) => ({
    path: item.path,
    optional: item.optional,
    holding: configurations.filter(item.test),
  }));
  return { dimensions, nested, needs, environment };
}

/** One dimension as a report names it: its key, its values, the environment
 *  variables its value is read from, and — for a member dimension — the member
 *  a sentence names. */
export interface ReportedDimension {
  readonly key: string;
  readonly values: readonly unknown[];
  readonly env: readonly string[];
  readonly member?: string;
}

/** A dimension as a sentence spells it. */
export type RequirementDimension = ReportedDimension;

/** The host values that answer a need of a kernel-declared type. */
function hostValuesOf(entry: NeedEnvironmentEntry): readonly string[] {
  if (entry.need.type === DURABLE_DIRECTORY_TYPE) return [STATE_DIR_HOST_VALUE];
  if (entry.need.type === PUBLIC_URL_TYPE) return PUBLIC_URL_HOST_VALUES;
  return [];
}

/** Every environment variable a need is read from: each field's, and a
 *  kernel-declared type's host values. */
export function needEnvNames(entry: NeedEnvironmentEntry): string[] {
  return [...Object.values(entry.fields ?? {}).map((field) => field.env), ...hostValuesOf(entry)];
}

/** The environment variables a need's presence is read from: its required
 *  fields' (every field's when none is required), and a kernel-declared type's
 *  host values. */
function presenceEnvNames(entry: NeedEnvironmentEntry): string[] {
  const fields = Object.values(entry.fields ?? {});
  const required = fields.filter((field) => field.required);
  return [...(required.length > 0 ? required : fields).map((field) => field.env), ...hostValuesOf(entry)];
}

/**
 * The dimensions `requirements` are decided over, each with the environment
 * variables its value is read from: an input's `env:`, a need's (`environment`,
 * the need table's) as {@link presenceEnvNames} and, for a field's member, that
 * field's. The one builder the needs report, `telo module manifest --json` and
 * `--help` read.
 */
export function requirementDimensions(
  requirements: InputRequirements,
  root: unknown,
  environment: readonly NeedEnvironmentEntry[],
): RequirementDimension[] {
  const moduleDoc = (root ?? {}) as Record<string, any>;
  return requirements.dimensions.map((dimension) => {
    let env: string[] = [];
    if (dimension.input === "resources") {
      const entry = environment.find((e) => e.path.join(".") === dimension.name);
      if (entry) {
        env =
          dimension.projection === "member"
            ? [entry.fields?.[dimension.field!]?.env].filter((name): name is string => typeof name === "string")
            : presenceEnvNames(entry);
      }
    } else {
      const declared = moduleDoc[dimension.input]?.[dimension.name];
      if (typeof declared?.env === "string") env = [declared.env];
    }
    return {
      key: dimension.key,
      values: dimension.values,
      env,
      ...(dimension.projection === "member" ? { member: dimension.member } : {}),
    };
  });
}

/** `dimensions` as a report carries them: `{ key, values, env, member? }`. */
export function reportedDimensions(dimensions: readonly RequirementDimension[]): ReportedDimension[] {
  return dimensions.map(({ key, values, env, member }) => ({
    key,
    values: [...values],
    env: [...env],
    ...(member !== undefined ? { member } : {}),
  }));
}

/**
 * The configurations `requiredWhen` names, as a sentence over the environment
 * variables each dimension is read from: `OPENAI_API_KEY is unset`,
 * `AI_PROVIDER is openai and none of A, B is set`, alternatives joined by
 * ` or `. A dimension no variable names is spelled by its key. The one sentence
 * `--help`, the needs report and `telo env template` print after
 * `required when`.
 */
export function requirementSentence(
  requiredWhen: readonly Assignment[],
  dimensions: readonly RequirementDimension[],
): string {
  const byKey = new Map(dimensions.map((d) => [d.key, d]));
  const spell = (key: string, value: unknown): string => {
    const dimension = byKey.get(key);
    const env = dimension?.env ?? [];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const unset = value === ABSENT || value === null;
    if (env.length === 0) return `${key} is ${unset ? "absent" : text}`;
    if (value === PRESENT) return env.length === 1 ? `${env[0]} is set` : `${env.join(", ")} are set`;
    if (unset) return env.length === 1 ? `${env[0]} is unset` : `none of ${env.join(", ")} is set`;
    if (dimension?.member !== undefined) return `the ${dimension.member} of ${env.join(", ")} is ${text}`;
    return `${env.join(", ")} is ${text}`;
  };
  return requiredWhen
    .map((assignment) =>
      Object.entries(assignment)
        .map(([key, value]) => spell(key, value))
        .join(" and "),
    )
    .join(" or ");
}

/**
 * What `documents` read: every entry a CEL expression reads, and every name a
 * `!ref` names — a kind document counted only where its kind is instantiated,
 * a ternary only through the arm `decide` says its guard takes.
 */
function documentReads(
  documents: readonly ResourceManifest[],
  moduleName: string | undefined,
  decide: (holder: ResourceManifest, source: string) => { value: unknown } | undefined,
  callNames: ReturnType<typeof moduleCallNamesByModule>,
): Reads {
  const reads = emptyReads();
  const instantiated = instantiatedKinds(documents, moduleName);
  for (const m of documents) {
    if (isKindDocument(m) && !instantiated.has(m.metadata?.name as string)) continue;
    const names = moduleCallNamesOf(callNames, m);
    walkCelExpressions(m, "", (source, _path, engine) => {
      for (const expression of celExpressionsOf(engine, source)) {
        const parsed = parseCelSource(expression, names);
        if (!parsed) continue;
        visitReads(wrapCelAst(parsed.root, 0), expression, (guard) => decide(m, guard), reads);
      }
    });
    collectRefs(m, reads.refs, isModuleKind(m.kind));
  }
  return reads;
}

/** The names of the module's own kinds a declaration of `documents`
 *  instantiates — directly, through `extends`, or through the template body of
 *  an instantiated kind. */
function instantiatedKinds(documents: readonly ResourceManifest[], moduleName: string | undefined): Set<string> {
  const own = (kind: unknown): string | undefined => {
    if (typeof kind !== "string") return undefined;
    const dot = kind.indexOf(".");
    const prefix = kind.slice(0, dot);
    return dot > 0 && (prefix === "Self" || prefix === moduleName) ? kind.slice(dot + 1) : undefined;
  };
  const kinds = new Map<string, ResourceManifest>();
  for (const m of documents) if (isKindDocument(m)) kinds.set(m.metadata?.name as string, m);
  const out = new Set<string>();
  const pending: string[] = [];
  const add = (name: string | undefined) => {
    if (name === undefined || out.has(name) || !kinds.has(name)) return;
    out.add(name);
    pending.push(name);
  };
  for (const m of documents) if (!isKindDocument(m)) add(own(m.kind));
  while (pending.length > 0) {
    const kind = kinds.get(pending.pop()!) as Record<string, any>;
    add(own(kind.extends));
    const body = kind.resources;
    if (Array.isArray(body)) for (const entry of body) add(own(entry?.kind));
  }
  return out;
}

/** Every chain `node` reads off a namespace root, each ternary visited through
 *  the arm its guard takes where `decide` says. */
function visitReads(
  node: CelNode,
  source: string,
  decide: (guard: string) => { value: unknown } | undefined,
  reads: Reads,
): void {
  const chain = chainOf(node);
  if (chain) {
    const [root, member] = chain;
    if (BLOCKS.has(root!)) reads.entries.get(root as Block)!.add(member ?? "*");
    return;
  }
  const visit = (child: CelNode) => visitReads(child, source, decide, reads);
  switch (node.kind) {
    case "literal":
    case "ident":
      return;
    case "member":
    case "index": {
      const base = chainOf(node.target);
      // A read past an optional member or through an index reads its base whole.
      if (base && BLOCKS.has(base[0]!)) reads.entries.get(base[0] as Block)!.add(base[1] ?? "*");
      else visit(node.target);
      if (node.kind === "index") visit(node.index);
      return;
    }
    case "ternary": {
      const decided = decide(source.slice(node.cond.range[0], node.cond.range[1]));
      if (decided && typeof decided.value === "boolean") {
        visit(decided.value ? node.then : node.else);
        return;
      }
      visit(node.cond);
      visit(node.then);
      visit(node.else);
      return;
    }
    case "binary":
      visit(node.left);
      visit(node.right);
      return;
    case "unary":
      visit(node.operand);
      return;
    case "list":
      for (const item of node.items) visit(item);
      return;
    case "map":
      for (const entry of node.entries) {
        visit(entry.key);
        visit(entry.value);
      }
      return;
    case "call":
      for (const arg of node.args) visit(arg);
      return;
    case "methodCall":
      visit(node.receiver);
      for (const arg of node.args) visit(arg);
      return;
  }
}

function chainOf(node: CelNode): string[] | undefined {
  if (node.kind === "ident") return [node.name];
  if (node.kind === "member" && !node.optional) {
    const parent = chainOf(node.target);
    return parent ? [...parent, node.property] : undefined;
  }
  return undefined;
}

/** Every name a reference in `value` names in its own module: a `!ref`
 *  sentinel or a resolved reference with no alias. An import's `needs:` is a
 *  forward, translated through the library's requirement instead. */
function collectRefs(value: unknown, refs: Set<string>, moduleDoc: boolean, key?: string): void {
  if (value === null || typeof value !== "object") return;
  const target = refSentinelTarget(value);
  if (target) {
    if (target.alias === undefined) refs.add(target.name);
    return;
  }
  if (isResolvedReference(value)) {
    const ref = value as { name?: unknown; alias?: unknown };
    if (typeof ref.name === "string" && ref.alias === undefined) refs.add(ref.name);
    return;
  }
  if (isTaggedSentinel(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs, false);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (moduleDoc && (k === "imports" || k === "needs")) continue;
    if (k === "needs" && key === undefined && (value as { kind?: unknown }).kind === "Telo.Import") continue;
    collectRefs(v, refs, false, k);
  }
}
