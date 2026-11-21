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
 * Nothing here enumerates configurations: every read is taken off the one
 * union expansion of the module (`conditioned-expansion.ts`) under the
 * condition of the option holding it, a requirement is the condition of its
 * reads, and `requiredWhen` is that condition's cover. A read inside a template
 * body counts wherever its definition is instantiated, whatever value the
 * definition is given. A library's requirement is a condition in its own space,
 * derived once and carried into each importer's through the import's binding
 * ({@link ConditionSpace.translate}).
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  celExpressionsOf,
  expansionTagOf,
  isExpansionSentinel,
  isTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import { wrapCelAst, type CelNode } from "./cel-ast.js";
import { parseCelSource } from "./cel-environment.js";
import { isStandInDeclaration } from "./choice-expansion.js";
import { branchesOf, branchForValue, readChoices, type ChoiceReading } from "./choice-reading.js";
import { expandUnion, isAlternatives } from "./conditioned-expansion.js";
import {
  ABSENT,
  admitsAbsence,
  configurationUniverse,
  entriesOfBlocks,
  memberOfValue,
  needDimensionKey,
  PRESENT,
  agreesWith,
  type Assignment,
  type Dimension,
} from "./configuration-dimensions.js";
import { isKindDocument } from "./kind-declaration.js";
import { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { DURABLE_DIRECTORY_TYPE, STATE_DIR_HOST_VALUE } from "./durable-directory.js";
import { isGeneratedSecretType, SECRET_SEED_HOST_VALUE } from "./generated-secret.js";
import { needSupplyOf, readNeeds, readSuppliedNeeds } from "./need-type.js";
import type { NeedEnvironmentEntry, NeedTable } from "./need-table.js";
import { ConditionSpace, FALSE, TRUE, type Condition } from "./presence-condition.js";
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
  readonly inputs: readonly InputRequirement[];
  /** Whether `input` is required in `assignment` — an assignment of every
   *  dimension: it is when some `requiredWhen` entry agrees with it on every
   *  key the entry names. */
  requiredIn(input: Pick<InputRequirement, "block" | "name">, assignment: Assignment): boolean;
}

type Block = "variables" | "secrets" | "ports" | "resources";
const BLOCKS: ReadonlySet<string> = new Set(["variables", "secrets", "ports", "resources"]);

/** What one module's documents read, each with the configurations it is read
 *  in: entries by block (`*` for the whole record), and the names its `!ref`s
 *  name. */
interface Reads {
  readonly entries: ReadonlyMap<Block, ReadonlyMap<string, Condition>>;
  readonly refs: ReadonlyMap<string, Condition>;
}

/** Where `reads` reads `name` of `block`, or the whole block. */
function readOf(space: ConditionSpace, reads: Reads, block: Block, name: string): Condition {
  const entries = reads.entries.get(block)!;
  return space.or(entries.get("*") ?? FALSE, entries.get(name) ?? FALSE);
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
  const space = new ConditionSpace(dimensions);
  const universe = configurationUniverse(space, dimensions);
  const keys = new Set(dimensions.map((d) => d.key));

  const ownModule = (m: ResourceManifest) => {
    const module = (m.metadata as { module?: unknown } | undefined)?.module;
    return typeof module !== "string" || module === rootName;
  };
  let rootReads: Reads | undefined;
  const reads = () => (rootReads ??= conditionedReads(manifests, choices, space, rootName, callNames, ownModule));

  const out: InputRequirement[] = [];
  const demands = new Map<string, { required: boolean; requiredWhen?: readonly Assignment[] }>();
  const record = (block: InputRequirement["block"], name: string, condition: Condition) => {
    const held = space.and(condition, universe);
    const required = held !== FALSE;
    const requiredWhen = held === universe ? undefined : entriesOfBlocks(space.cover(held, universe));
    demands.set(`${block}\0${name}`, { required, ...(requiredWhen ? { requiredWhen } : {}) });
    out.push({ block, name, required, ...(requiredWhen && required ? { requiredWhen } : {}) });
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
        record(block, name, FALSE);
        continue;
      }
      if (dimensionInputs.has(`${block}.${name}`) || (block === "ports" && addressPorts.has(name))) {
        record(block, name, TRUE);
        continue;
      }
      record(block, name, readOf(space, reads(), block, name));
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
    space,
    keys,
    ownOptional,
    (path, field, member) => needDimensionKey(path.segments, field, member),
    { manifests, libraries, callNames, memo: new Map(), active: new Set() },
  );
  // A `shared` library imported twice reaches one need through both imports.
  const environmentNeeds = new Map<string, Condition>();
  for (const item of translated.environment) {
    const key = item.path.segments.join(".");
    environmentNeeds.set(key, space.or(environmentNeeds.get(key) ?? FALSE, item.condition));
  }

  // The application's own needs.
  for (const need of ownNeeds) {
    if (need.optional) {
      record("needs", need.name, FALSE);
      continue;
    }
    const memberDimension = choices.dimensions.some((d) => d.needPath?.length === 1 && d.needPath[0] === need.name);
    if (memberDimension || translated.opaque.has(need.name)) {
      record("needs", need.name, TRUE);
      continue;
    }
    const read = reads();
    record(
      "needs",
      need.name,
      space.some([
        readOf(space, read, "resources", need.name),
        read.refs.get(need.name) ?? FALSE,
        ...(translated.forwarded.get(need.name) ?? []),
      ]),
    );
  }

  // Every other need the environment is read for: a library's.
  for (const entry of needTable?.environment ?? []) {
    if (entry.path.length < 2) continue;
    const name = entry.path.join(".");
    if (entry.need.optional) {
      record("needs", name, FALSE);
      continue;
    }
    record("needs", name, environmentNeeds.get(name) ?? TRUE);
  }

  return {
    dimensions,
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
 *  module, and each need forwarded whole from one of the module's own needs —
 *  each with the module's configurations requiring it. */
interface ImportedRequirements {
  readonly environment: Array<{ path: NeedPathBelow; optional: boolean; condition: Condition }>;
  readonly forwarded: Map<string, Condition[]>;
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
 * each import's binding into the importing module's `space` (`keys` its
 * dimensions, `ownNeeds` its needs by optionality, `keyOf` the key of a need
 * below it). A library's requirement is derived once, over its own
 * configurations, and carried across: a literal or a supply is a fact the
 * library's dimension is restricted to, a bare chain to one of the importer's
 * dimensions renames it, an unsupplied optional need is its presence
 * dimension, and anything else decides nothing, so the dimension is projected
 * out — the need is required whatever that library dimension holds.
 */
function importRequirements(
  imports: readonly ResourceManifest[],
  space: ConditionSpace,
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
    const byKey = new Map(library.dimensions.map((d) => [d.key, d]));
    const carry = (condition: Condition) =>
      library.space.translate(condition, space, (key) => translate(byKey.get(key)!));

    for (const [need, { optional, condition }] of library.needs) {
      const carried = carry(condition);
      const written = supplied[need];
      if (written === undefined) {
        out.environment.push({ path: below({ segments: [need], rooted: false }), optional, condition: carried });
        continue;
      }
      const supply = needSupplyOf(written);
      if (supply.form === "whole" && supply.target.alias === undefined && ownNeeds.has(supply.target.name)) {
        out.forwarded.set(supply.target.name, [...(out.forwarded.get(supply.target.name) ?? []), carried]);
      }
    }
    for (const item of library.environment) {
      out.environment.push({ path: below(item.path), optional: item.optional, condition: carry(item.condition) });
    }
  }
  return out;
}

/** What one library requires of its needs, as conditions over its own
 *  configurations: each of its own needs, and each need of a library it
 *  imports that its import leaves to the environment. */
interface LibraryRequirement {
  /** The library's dimensions: its choices' own, and the presence of each
   *  optional need of a library it imports left to the environment. */
  readonly dimensions: readonly Dimension[];
  readonly space: ConditionSpace;
  /** Of those, each nested need's presence by key: the need's path below the
   *  library. */
  readonly nested: ReadonlyMap<string, NeedPathBelow>;
  readonly needs: Map<string, { optional: boolean; condition: Condition }>;
  readonly environment: Array<{ path: NeedPathBelow; optional: boolean; condition: Condition }>;
}

function libraryRequirement(documents: ModuleDocuments, context: RequirementContext): LibraryRequirement {
  const all = documents.manifests;
  const sentinels = all.filter(isExpansionSentinel);
  const declarations = all.filter((m) => !sentinels.includes(m));
  const choices = readChoices(declarations, sentinels);
  const libraryDoc = all.find((m) => m.kind === "Telo.Library");
  const declared = readNeeds(libraryDoc);
  const libraryName = libraryDoc?.metadata?.name as string | undefined;

  // Which needs the imports leave to the environment decides the nested
  // presence dimensions, so the imports are read for that over the choices'
  // own space first, then carried into the space those dimensions complete.
  const nestedKey = (path: NeedPathBelow, field?: string, member?: string) =>
    `${path.rooted ? "/" : ""}${needDimensionKey(path.segments, field, member)}`;
  const ownSpace = new ConditionSpace(choices.dimensions);
  const ownKeys = new Set(choices.dimensions.map((d) => d.key));
  const keys = new Set(ownKeys);
  const nested = new Map<string, NeedPathBelow>();
  const dimensions: Dimension[] = [...choices.dimensions];
  const importDocs = all.filter((m) => m.kind === "Telo.Import");
  const ownNeeds = new Map(declared.map((need) => [need.name, need.optional]));
  for (const item of importRequirements(importDocs, ownSpace, ownKeys, ownNeeds, nestedKey, context).environment) {
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
  const space = new ConditionSpace(dimensions);
  const universe = configurationUniverse(space, dimensions);
  const imported = importRequirements(importDocs, space, keys, ownNeeds, nestedKey, context);
  const reads = conditionedReads(all, choices, space, libraryName, context.callNames, () => true);

  const needs = new Map<string, { optional: boolean; condition: Condition }>();
  for (const need of declared) {
    const condition = imported.opaque.has(need.name)
      ? TRUE
      : space.some([
          readOf(space, reads, "resources", need.name),
          reads.refs.get(need.name) ?? FALSE,
          ...(imported.forwarded.get(need.name) ?? []),
        ]);
    needs.set(need.name, { optional: need.optional, condition: space.and(condition, universe) });
  }
  const environment = imported.environment.map((item) => ({
    path: item.path,
    optional: item.optional,
    condition: space.and(item.condition, universe),
  }));
  return { dimensions, space, nested, needs, environment };
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
  if (isGeneratedSecretType(entry.need.type)) return [SECRET_SEED_HOST_VALUE];
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
 * What `documents` read across every configuration, off their one union
 * expansion over `space`: every entry a CEL expression reads and every name a
 * `!ref` names, each under the condition of the declaration and the options
 * holding it — a kind document's where its kind is instantiated, a ternary's
 * arm where its guard takes it. `keep` selects the declarations counted.
 */
function conditionedReads(
  documents: readonly ResourceManifest[],
  choices: ChoiceReading,
  space: ConditionSpace,
  moduleName: string | undefined,
  callNames: ReturnType<typeof moduleCallNamesByModule>,
  keep: (m: ResourceManifest) => boolean,
): Reads {
  const union = expandUnion(documents, space, choices.branchConditions(space));
  const declarations = union.declarations.filter(
    (d) => d.condition !== FALSE && !isStandInDeclaration(d.manifest) && keep(d.manifest),
  );
  const entries = new Map<Block, Map<string, Condition>>([...BLOCKS].map((b) => [b as Block, new Map()]));
  const refs = new Map<string, Condition>();
  const add = (map: Map<string, Condition>, name: string, condition: Condition) =>
    map.set(name, space.or(map.get(name) ?? FALSE, condition));
  const instantiated = instantiatedKinds(declarations, moduleName, space);
  for (const { manifest: m, condition: declared } of declarations) {
    const condition = isKindDocument(m) ? (instantiated.get(m.metadata?.name as string) ?? FALSE) : declared;
    if (condition === FALSE) continue;
    const names = moduleCallNamesOf(callNames, m);
    const outcomes = new Map<string, ReturnType<ChoiceReading["valueOutcomes"]>>();
    const decide = (guard: string) => {
      if (!outcomes.has(guard)) outcomes.set(guard, choices.valueOutcomes(m, guard, space));
      return outcomes.get(guard);
    };
    // A template body's choice the configuration decides holds each branch
    // where it is taken; one reading the definition's own values holds every
    // branch, whatever value the definition is given.
    const bodyBranches =
      m.kind === "Telo.Definition"
        ? (sentinel: ExpansionSentinel): Map<string, Condition> | undefined => {
            const tag = expansionTagOf(sentinel);
            if (tag !== "if" && tag !== "switch") return undefined;
            const written = (sentinel as Record<string, unknown>)[tag];
            const source = isTaggedSentinel(written) ? written.source : isCompiledValue(written) ? written.source : undefined;
            const outcomes = typeof source === "string" ? decide(source) : undefined;
            if (!outcomes) return undefined;
            const out = new Map<string, Condition>();
            for (const { value, condition: at } of outcomes) {
              const branch = branchForValue(sentinel, tag, value);
              if (branch !== null) out.set(branch, space.or(out.get(branch) ?? FALSE, at));
            }
            return out;
          }
        : undefined;
    walkConditionedExpressions(space, m, condition, (source, engine, held) => {
      for (const expression of celExpressionsOf(engine, source)) {
        const parsed = parseCelSource(expression, names);
        if (!parsed) continue;
        visitReads(space, wrapCelAst(parsed.root, 0), expression, decide, held, (block, name, at) =>
          add(entries.get(block)!, name, at),
        );
      }
    }, bodyBranches);
    collectRefs(space, m, condition, (name, at) => add(refs, name, at), isModuleKind(m.kind));
  }
  return { entries, refs };
}

/** Each CEL-bearing tag in `value` with the condition it is held under: a
 *  choice's option under its own, and an unexpanded choice `branches` decides
 *  each branch under the condition it is taken in. */
function walkConditionedExpressions(
  space: ConditionSpace,
  value: unknown,
  condition: Condition,
  found: (source: string, engine: string, condition: Condition) => void,
  branches?: (sentinel: ExpansionSentinel) => ReadonlyMap<string, Condition> | undefined,
): void {
  const walk = (at: unknown, held: Condition) => walkConditionedExpressions(space, at, held, found, branches);
  if (isTaggedSentinel(value)) {
    found(value.source, value.engine, condition);
    return;
  }
  if (isAlternatives(value)) {
    for (const option of value.options) {
      const held = space.and(condition, option.condition);
      if (option.present && held !== FALSE) walk(option.value, held);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, condition);
    return;
  }
  if (value === null || typeof value !== "object" || isCompiledValue(value)) return;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return;
  const sentinel = isExpansionSentinel(value) ? value : undefined;
  const taken = branches && sentinel ? branches(sentinel) : undefined;
  if (sentinel && taken) {
    const tag = expansionTagOf(sentinel) as "if" | "switch";
    const branchKeys = new Set<string>();
    for (const [branch, keys] of branchesOf({ sentinel, tag })) {
      branchKeys.add(String(keys[0]));
      const held = space.and(condition, taken.get(branch) ?? FALSE);
      if (held !== FALSE) walk(keys.reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], value), held);
    }
    for (const key in value) if (!branchKeys.has(key)) walk((value as Record<string, unknown>)[key], condition);
    return;
  }
  for (const key in value) walk((value as Record<string, unknown>)[key], condition);
}

/** Where each of the module's own kinds is instantiated among `declarations` —
 *  directly, through `extends`, or through the template body of an
 *  instantiated kind. */
function instantiatedKinds(
  declarations: readonly { readonly manifest: ResourceManifest; readonly condition: Condition }[],
  moduleName: string | undefined,
  space: ConditionSpace,
): Map<string, Condition> {
  const own = (kind: unknown): string | undefined => {
    if (typeof kind !== "string") return undefined;
    const dot = kind.indexOf(".");
    const prefix = kind.slice(0, dot);
    return dot > 0 && (prefix === "Self" || prefix === moduleName) ? kind.slice(dot + 1) : undefined;
  };
  const kinds = new Map<string, ResourceManifest>();
  for (const { manifest } of declarations) if (isKindDocument(manifest)) kinds.set(manifest.metadata?.name as string, manifest);
  const out = new Map<string, Condition>();
  const pending: string[] = [];
  const add = (name: string | undefined, condition: Condition) => {
    if (name === undefined || !kinds.has(name)) return;
    const before = out.get(name) ?? FALSE;
    const after = space.or(before, condition);
    if (after === before) return;
    out.set(name, after);
    pending.push(name);
  };
  for (const { manifest, condition } of declarations) if (!isKindDocument(manifest)) add(own(manifest.kind), condition);
  while (pending.length > 0) {
    const name = pending.pop()!;
    const kind = kinds.get(name) as Record<string, any>;
    const condition = out.get(name)!;
    add(own(kind.extends), condition);
    const body = kind.resources;
    if (Array.isArray(body)) for (const entry of body) add(own(entry?.kind), condition);
  }
  return out;
}

/** Every chain `node` reads off a namespace root under `condition`, each
 *  ternary's arm under the condition its guard takes it, where `decide` gives
 *  the guard's values. */
function visitReads(
  space: ConditionSpace,
  node: CelNode,
  source: string,
  decide: (guard: string) => ReturnType<ChoiceReading["valueOutcomes"]>,
  condition: Condition,
  read: (block: Block, name: string, condition: Condition) => void,
): void {
  if (condition === FALSE) return;
  const chain = chainOf(node);
  if (chain) {
    const [root, member] = chain;
    if (BLOCKS.has(root!)) read(root as Block, member ?? "*", condition);
    return;
  }
  const visit = (child: CelNode, at: Condition = condition) => visitReads(space, child, source, decide, at, read);
  switch (node.kind) {
    case "literal":
    case "ident":
      return;
    case "member":
    case "index": {
      const base = chainOf(node.target);
      // A read past an optional member or through an index reads its base whole.
      if (base && BLOCKS.has(base[0]!)) read(base[0] as Block, base[1] ?? "*", condition);
      else visit(node.target);
      if (node.kind === "index") visit(node.index);
      return;
    }
    case "ternary": {
      const outcomes = decide(source.slice(node.cond.range[0], node.cond.range[1]));
      let then = FALSE;
      let otherwise = FALSE;
      let undecided = outcomes ? FALSE : TRUE;
      for (const outcome of outcomes ?? []) {
        if (outcome.value === true) then = space.or(then, outcome.condition);
        else if (outcome.value === false) otherwise = space.or(otherwise, outcome.condition);
        else undecided = space.or(undecided, outcome.condition);
      }
      visit(node.then, space.and(condition, space.or(then, undecided)));
      visit(node.else, space.and(condition, space.or(otherwise, undecided)));
      visit(node.cond, space.and(condition, undecided));
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

/** Every name a reference in `value` names in its own module, under the
 *  condition holding it: a `!ref` sentinel or a resolved reference with no
 *  alias. An import's `needs:` is a forward, translated through the library's
 *  requirement instead. */
function collectRefs(
  space: ConditionSpace,
  value: unknown,
  condition: Condition,
  found: (name: string, condition: Condition) => void,
  moduleDoc: boolean,
  key?: string,
): void {
  if (value === null || typeof value !== "object") return;
  if (isAlternatives(value)) {
    for (const option of value.options) {
      const held = space.and(condition, option.condition);
      if (option.present && held !== FALSE) collectRefs(space, option.value, held, found, moduleDoc, key);
    }
    return;
  }
  const target = refSentinelTarget(value);
  if (target) {
    if (target.alias === undefined) found(target.name, condition);
    return;
  }
  if (isResolvedReference(value)) {
    const ref = value as { name?: unknown; alias?: unknown };
    if (typeof ref.name === "string" && ref.alias === undefined) found(ref.name, condition);
    return;
  }
  if (isTaggedSentinel(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(space, item, condition, found, false);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (moduleDoc && (k === "imports" || k === "needs")) continue;
    if (k === "needs" && key === undefined && (value as { kind?: unknown }).kind === "Telo.Import") continue;
    collectRefs(space, v, condition, found, false, k);
  }
}
