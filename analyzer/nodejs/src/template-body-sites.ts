/**
 * The CEL sites of every template body, read once off its lifted reading:
 * each expression where it is written, and the condition — over its
 * definition's own dimensions — under which a way of deciding the body holds
 * it. An expression only a branch no value the definition can be given takes
 * holds carries that branch and the choices forced to reach it; one its branch
 * does not reach there is never present, as the forced variant leaves it.
 *
 * What a site's key reads of the body beyond the definition as written is read
 * off the same reading, unit by unit — a top-level `resources:` item, or one
 * other body field: its own unit, every unit it names (a `resources.<name>`
 * read, a `!ref` in its own unit), and — beside a site outside `resources:` —
 * the dispatch fields and what they name. Each unit is its content as the
 * key's witness decides it, holding wherever every option taken in it is.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { expansionBody, isExpansionSentinel, isRefSentinel, isTaggedSentinel, REF_ENGINE } from "@telorun/templating";
import { Alternatives, type ChoiceStep, type DeadBranchWorld, type Forcing, World } from "./conditioned-expansion.js";
import type { Assignment } from "./configuration-dimensions.js";
import { definitionDimensionKey, FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { localRefName } from "./ref-sentinel-target.js";
import type { TemplateBodyReading, TemplateDefinitions } from "./template-definition-check.js";
import { parseKeys, pathText, relocateTemplatePath, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";

type Keys = readonly (string | number)[];

/** A branch of a body no value the definition can be given takes: the
 *  assignment of the definition's own dimensions reaching its choice, and the
 *  choices forced to take it there. */
export interface BodyDeadBranch {
  readonly sentinel: object;
  readonly branch: string;
  readonly baseline: Assignment;
  readonly world: DeadBranchWorld;
  readonly forcing: Forcing;
}

/** What a site's key reads of one body unit at a witness. */
export interface BodyUnitClass {
  readonly text: string;
  readonly condition: Condition;
}

/** One expression of a template body, as written. */
export interface TemplateBodySite {
  readonly id: string;
  /** The definition holding it, as written. */
  readonly holder: ResourceManifest;
  /** Whether its body holds a choice or a repeat, read lifted: a body holding
   *  none is the same however the definition is given values. */
  readonly lifted: boolean;
  /** Where it is written in the definition. */
  readonly path: string;
  /** Where some way of deciding the body holds it — FALSE for a dead one. */
  readonly condition: Condition;
  readonly dead?: BodyDeadBranch;
  /** Every expression written at its place, in the order the body holds them. */
  readonly expressions: readonly { readonly engine: string; readonly source: string }[];
  /** The units it reads at `witness`: its own, the ones `names` name (every
   *  unit for `"all"`), and the ones its own unit references. In a dead branch
   *  each unit is its text alone: the body is decided there, whatever holds. */
  unitClasses(witness: World, names: readonly string[] | "all"): BodyUnitClass[];
  /** Its definition's own dimensions at their first values: where a site
   *  outside the body reads it at no assignment of its own. */
  readonly firstAssignment: Assignment;
}

/** One unit of a lifted body: a top-level `resources:` item by its lifted
 *  index, or another body field. */
interface Unit {
  readonly id: string;
  readonly node: unknown;
  readonly names: ReadonlySet<string>;
  readonly references: ReadonlySet<string>;
}

const DISPATCH_FIELDS = ["invoke", "provide", "run", "mount"];

/** Where an analysis reports each expression of `definition`'s body as
 *  `assignment` of its own dimensions (by their keys in the space; `forcing`'s
 *  choices forced) decides it: its site's id, by the object the body holds. */
export type BodySitePlaces = (
  definition: ResourceManifest,
  assignment: Assignment,
  forcing: Forcing | undefined,
) => ReadonlyMap<object, string>;

/** Every CEL site of the body of each of `definitions` — read off its lifted
 *  reading where `templates` lifted it, else off the body as written — in
 *  definition order. */
export function templateBodySites(
  definitions: readonly ResourceManifest[],
  templates: TemplateDefinitions | undefined,
  space: ConditionSpace,
  places: BodySitePlaces,
  /** The configurations kept: a site is placed in one. */
  universe: Condition,
): TemplateBodySite[] {
  const lifted = new Set(templates?.definitions ?? []);
  const out: TemplateBodySite[] = [];
  for (const definition of definitions) {
    if (lifted.has(definition)) {
      const reading = templates!.readingOf(definition);
      out.push(...sitesOf(definition, reading.body.fields, reading.body.members, space, places, universe, { templates: templates!, reading }));
      continue;
    }
    if (!TEMPLATE_BODY_FIELDS.some((field) => (definition as Record<string, unknown>)[field] !== undefined)) continue;
    out.push(...sitesOf(definition, definition as Record<string, unknown>, [], space, places, universe, undefined));
  }
  return out;
}

const mayEntries = new WeakMap<TemplateBodyReading, ReadonlyMap<string, string>>();

/** Every entry a body may hold, by name, with the kind it is first written
 *  with, in written order: what a CEL `resources` record lists of the body as
 *  written. */
export function mayBodyEntries(reading: TemplateBodyReading): ReadonlyMap<string, string> {
  const known = mayEntries.get(reading);
  if (known) return known;
  const out = new Map<string, string>();
  mayEntries.set(reading, out);
  const take = (value: unknown): void => {
    if (value instanceof Alternatives) {
      for (const option of value.options) if (option.present) take(option.value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entry = value as { kind?: unknown; metadata?: { name?: unknown } };
    // A family's members are the family's, which its expansion declares.
    const name = entry.metadata?.name;
    if (typeof entry.kind === "string" && typeof name === "string" && !name.includes("[") && !out.has(name)) {
      out.set(name, entry.kind);
    }
  };
  const resources = (reading.body.fields as Record<string, unknown>).resources;
  if (Array.isArray(resources)) for (const item of resources) take(item);
  return out;
}

/** The names every entry of the lifted body `reading` is declared under as
 *  written — every way of deciding it — in written order: what a message
 *  about the body lists. */
export function writtenBodyEntryNames(reading: TemplateBodyReading): readonly string[] {
  const known = writtenNames.get(reading);
  if (known) return known;
  const out = new Set<string>();
  const take = (value: unknown): void => {
    if (value instanceof Alternatives) {
      for (const option of value.options) if (option.present) take(option.value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const name = (value as { metadata?: { name?: unknown } }).metadata?.name;
    if (typeof name === "string") out.add(name);
  };
  const resources = (reading.body.fields as Record<string, unknown>).resources;
  if (Array.isArray(resources)) for (const item of resources) take(item);
  const names = [...out];
  writtenNames.set(reading, names);
  return names;
}
const writtenNames = new WeakMap<TemplateBodyReading, readonly string[]>();

function sitesOf(
  definition: ResourceManifest,
  bodyFields: Readonly<Record<string, unknown>>,
  members: TemplateBodyReading["body"]["members"],
  space: ConditionSpace,
  places: BodySitePlaces,
  universe: Condition,
  lifted: { readonly templates: TemplateDefinitions; readonly reading: TemplateBodyReading } | undefined,
): TemplateBodySite[] {
  const written = writtenPaths(definition);
  const dimensions = lifted
    ? [...lifted.templates.dimensionsOf(definition), ...lifted.templates.configurationDimensionsOf(definition)]
    : [];
  const ownDimensions = lifted ? lifted.templates.dimensionsOf(definition) : [];

  // The units, and the names each declares and references.
  const units = new Map<string, Unit>();
  const familyAt = new Map<number, Set<string>>();
  for (const { item } of members) {
    const [field, index] = item.member.at;
    if (field !== "resources" || typeof index !== "number") continue;
    const family = item.member.name.split("[")[0]!;
    familyAt.set(index, (familyAt.get(index) ?? new Set()).add(family));
  }
  const fields = bodyFields as Record<string, unknown>;
  for (const field of TEMPLATE_BODY_FIELDS) {
    const node = fields[field];
    if (node === undefined) continue;
    if (field === "resources" && Array.isArray(node)) {
      node.forEach((item, i) => {
        const names = new Set(familyAt.get(i) ?? []);
        namesDeclared(item, names);
        units.set(`resources[${i}]`, { id: `resources[${i}]`, node: item, names, references: referencesIn(item) });
      });
      continue;
    }
    units.set(field, { id: field, node, names: new Set(), references: referencesIn(node) });
  }
  const unitsNamed = (name: string): Unit[] => [...units.values()].filter((unit) => unit.names.has(name));

  const unitClass = (unit: Unit, witness: World, forced: boolean): BodyUnitClass =>
    unitClassOf(space, unit.id, unit.node, witness, forced);

  /** Where an analysis reports the expression `value`, the body decided at
   *  `assignment` (and `forcing`) — undefined for one it judges nowhere. */
  const placed = new Map<string, ReadonlyMap<object, string>>();
  const forcingIds = new Map<object, number>();
  const placedPath = (value: object, assignment: Assignment, forcing: Forcing | undefined): string | undefined => {
    const local: Record<string, unknown> = {};
    for (const dimension of dimensions) {
      if (Object.hasOwn(assignment, dimension.key)) local[dimension.key] = assignment[dimension.key];
    }
    const forced = [...(forcing ?? [])].map(([sentinel, branch]) => {
      if (!forcingIds.has(sentinel as object)) forcingIds.set(sentinel as object, forcingIds.size);
      return `${forcingIds.get(sentinel as object)}=${branch}`;
    });
    const key = `${JSON.stringify(Object.entries(local))}|${forced.join(",")}`;
    let at = placed.get(key);
    if (!at) placed.set(key, (at = places(definition, local, forcing)));
    return at.get(value);
  };

  /** Where a site under `condition` is placed: a configuration kept it holds
   *  in, else the first kept with the definition's own values it first holds
   *  at. */
  const placementOf = (condition: Condition): Assignment => {
    const kept = space.firstAssignment(space.and(condition, universe));
    if (kept) return kept;
    const first = space.firstAssignment(condition)!;
    return {
      ...space.firstAssignment(universe),
      ...Object.fromEntries(ownDimensions.filter((d) => Object.hasOwn(first, d.key)).map((d) => [d.key, first[d.key]])),
    };
  };

  // Each expression the lifted body holds, under the options on its way.
  type Found = { id: string; path: string; unit: Unit; engine: string; source: string; condition: Condition; dead?: BodyDeadBranch };
  const found: Found[] = [];
  const visit = (value: unknown, unit: Unit, condition: Condition, steps: readonly ChoiceStep[], dead: BodyDeadBranch | undefined): void => {
    if (value instanceof Alternatives) {
      for (const option of value.options) {
        if (!option.present) continue;
        const step = option.path.at(-1);
        const branch: BodyDeadBranch | undefined =
          option.unreachable && option.forcing && option.baseline && step && typeof step.branch === "string"
            ? { sentinel: step.sentinel as object, branch: step.branch, baseline: option.baseline, forcing: option.forcing, world: option.world! }
            : dead;
        visit(option.value, unit, space.and(condition, option.condition), option.path, branch);
      }
      return;
    }
    if (isTaggedSentinel(value)) {
      if (value.engine === REF_ENGINE || isRefSentinel(value)) return;
      if (!written.has(value)) return;
      // Inside a dead branch, present only where its forced witness holds it.
      const deadAt = dead ? { ...space.firstAssignment(universe), ...dead.baseline } : undefined;
      if (dead && !steps.every((step) => (dead.forcing.has(step.sentinel) ? dead.forcing.get(step.sentinel) === step.branch : space.holds(step.taken, deadAt!)))) {
        return;
      }
      const id = placedPath(value, deadAt ?? placementOf(condition), dead?.forcing);
      if (id === undefined) return;
      found.push({
        id,
        path: (JSON.parse(id) as unknown[])[3] as string,
        unit,
        engine: value.engine,
        source: value.source,
        condition: dead ? FALSE : condition,
        ...(dead ? { dead } : {}),
      });
      return;
    }
    if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return;
    for (const field of Array.isArray(value) ? value : Object.values(value)) visit(field, unit, condition, steps, dead);
  };
  for (const unit of units.values()) visit(unit.node, unit, TRUE, [], undefined);

  // One site per written place and branch: its occurrences joined.
  type Site = Omit<Found, "unit" | "engine" | "source"> & { units: Set<Unit>; expressions: { engine: string; source: string }[] };
  const sites = new Map<string, Site>();
  for (const each of found) {
    const at = `${each.id}\0${each.dead ? `${String(each.dead.branch)}@${lifted!.reading.unreachable.findIndex((u) => u.sentinel === each.dead!.sentinel)}` : ""}`;
    const known = sites.get(at);
    if (known) {
      known.condition = space.or(known.condition, each.condition);
      known.units.add(each.unit);
      known.expressions.push({ engine: each.engine, source: each.source });
      continue;
    }
    sites.set(at, {
      id: each.id,
      path: each.path,
      condition: each.condition,
      ...(each.dead ? { dead: each.dead } : {}),
      units: new Set([each.unit]),
      expressions: [{ engine: each.engine, source: each.source }],
    });
  }
  return [...sites.values()].map((site): TemplateBodySite => ({
    id: site.id,
    holder: definition,
    lifted: lifted !== undefined,
    path: site.path,
    condition: site.condition,
    ...(site.dead ? { dead: site.dead } : {}),
    expressions: site.expressions,
    unitClasses: (witness, names) => {
      const read = new Set<Unit>(site.units);
      const named = (name: string) => unitsNamed(name).forEach((unit) => read.add(unit));
      if (names === "all") for (const unit of units.values()) read.add(unit);
      else names.forEach(named);
      for (const unit of site.units) unit.references.forEach(named);
      if ([...site.units].some((unit) => !unit.id.startsWith("resources["))) {
        for (const field of DISPATCH_FIELDS) {
          const unit = units.get(field);
          if (!unit) continue;
          read.add(unit);
          unit.references.forEach(named);
        }
      }
      return [...read].map((unit) => unitClass(unit, witness, site.dead !== undefined));
    },
    firstAssignment: lifted
      ? Object.fromEntries(ownDimensions.map((dimension) => [dimension.key, dimension.values[0]]))
      : {},
  }));
}

/** What the lifted `node` of the unit `id` holds at `witness`, and where every
 *  option taken in it is — everywhere, in a dead branch (`forced`). */
function unitClassOf(space: ConditionSpace, id: string, node: unknown, witness: World, forced: boolean): BodyUnitClass {
  const forcing = witness.bodyForcing;
  const hold = (step: ChoiceStep): boolean =>
    forcing?.has(step.sentinel) ? forcing.get(step.sentinel) === step.branch : space.holds(step.taken, witness.assignment);
  let condition = TRUE;
  const walk = (value: unknown): unknown => {
    if (value instanceof Alternatives) {
      const option = value.options.find((o) => o.path.every(hold));
      if (!option) {
        condition = space.and(condition, space.not(space.some(value.options.map((o) => o.condition))));
        return "$absent";
      }
      condition = space.and(condition, option.condition);
      return option.present ? walk(option.value) : "$absent";
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return value;
    if (Array.isArray(value)) return value.map(walk);
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, walk(field)]));
  };
  const content = walk(node);
  return { text: textOf(["body-unit", id, content]), condition: forced ? TRUE : condition };
}

/** A branch of a body unit no value the definition can be given takes, and
 *  where it is written: what a check keyed in it keeps. */
export interface BodyUnitDeadBranch extends BodyDeadBranch {
  readonly path: string;
}

/**
 * One unit of a lifted body as written — a top-level `resources:` item, or
 * another body field — whose own checks are judged apart from the rest of
 * the definition.
 */
export interface TemplateBodyUnit {
  readonly definition: ResourceManifest;
  /** Where it is written in the definition. */
  readonly keys: Keys;
  /** Its lifted item — every one, where it is written as several. */
  readonly node: unknown;
  /** Every branch in it no value the definition can be given takes. */
  readonly dead: readonly BodyUnitDeadBranch[];
  /** What it holds at `witness`, every lifted item it is written as read
   *  together; in a dead branch (`forced`), its text alone. */
  classAt(witness: World, forced: boolean): BodyUnitClass;
}

/** The units of `definition`'s lifted body, in written order. */
export function templateBodyUnits(
  definition: ResourceManifest,
  templates: TemplateDefinitions,
  space: ConditionSpace,
): TemplateBodyUnit[] {
  const reading = templates.readingOf(definition);
  const dimensions = templates.dimensionsOf(definition);
  const fields = reading.body.fields as Record<string, unknown>;
  const mappings = reading.body.mappings.map((m) => m.item);
  const sentinelPaths = writtenSentinelPaths(definition);
  const groups = new Map<string, { keys: Keys; nodes: unknown[] }>();
  for (const field of TEMPLATE_BODY_FIELDS) {
    const node = fields[field];
    if (node === undefined) continue;
    if (field !== "resources" || !Array.isArray(node)) {
      groups.set(field, { keys: [field], nodes: [node] });
      continue;
    }
    node.forEach((item, lifted) => {
      const written = parseKeys(relocateTemplatePath(pathText(["resources", lifted]), mappings));
      if (written[0] !== "resources" || typeof written[1] !== "number") {
        throw new Error(`internal: the lifted body item resources[${lifted}] of ${String(definition.metadata?.name)} is written at '${pathText(written)}'.`);
      }
      const id = pathText(written.slice(0, 2));
      const group = groups.get(id) ?? { keys: written.slice(0, 2), nodes: [] };
      group.nodes.push(item);
      groups.set(id, group);
    });
  }
  const order = (keys: Keys) => [TEMPLATE_BODY_FIELDS.indexOf(String(keys[0])), typeof keys[1] === "number" ? keys[1] : -1];
  return [...groups.entries()]
    .sort(([, a], [, b]) => {
      const [fa, ia] = order(a.keys);
      const [fb, ib] = order(b.keys);
      return fa! - fb! || ia! - ib!;
    })
    .map(([id, { keys, nodes }]): TemplateBodyUnit => {
      const node = nodes.length === 1 ? nodes[0] : nodes;
      const dead: BodyUnitDeadBranch[] = [];
      const visit = (value: unknown): void => {
        if (value instanceof Alternatives) {
          for (const option of value.options) {
            if (!option.present) continue;
            const step = option.path.at(-1);
            if (option.unreachable && option.forcing && option.baseline && step && typeof step.branch === "string") {
              const at = sentinelPaths.get(step.sentinel as object);
              if (!at) throw new Error(`internal: a dead branch of ${String(definition.metadata?.name)} is written nowhere.`);
              if (!dead.some((d) => d.sentinel === step.sentinel && d.branch === step.branch)) {
                dead.push({
                  sentinel: step.sentinel as object,
                  branch: step.branch,
                  baseline: option.baseline,
                  world: option.world!,
                  forcing: option.forcing,
                  path: pathText([...at, ...(step.branch.startsWith("case:") ? ["cases", step.branch.slice(5)] : [step.branch])]),
                });
              }
            }
            visit(option.value);
          }
          return;
        }
        if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
        for (const field of Array.isArray(value) ? value : Object.values(value)) visit(field);
      };
      visit(node);
      return {
        definition,
        keys,
        node,
        dead,
        classAt: (witness, forced) => unitClassOf(space, id, node, witness, forced),
      };
    });
}

/** Every choice and repeat of `definition`'s body as written, by sentinel: where
 *  it is written. */
function writtenSentinelPaths(definition: ResourceManifest): Map<object, Keys> {
  const out = new Map<object, Keys>();
  const visit = (value: unknown, keys: Keys): void => {
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
    if (isExpansionSentinel(value) && !out.has(value)) out.set(value, keys);
    const fields = isExpansionSentinel(value) ? expansionBody(value) : value;
    if (Array.isArray(fields)) fields.forEach((item, i) => visit(item, [...keys, i]));
    else for (const [key, field] of Object.entries(fields)) visit(field, [...keys, key]);
  };
  for (const field of TEMPLATE_BODY_FIELDS) {
    const value = (definition as Record<string, unknown>)[field];
    if (value !== undefined) visit(value, [field]);
  }
  return out;
}

/** Every expression of `definition`'s body as written, by object: what a
 *  lifted body holds of it. */
function writtenPaths(definition: ResourceManifest): Map<object, Keys> {
  const out = new Map<object, Keys>();
  const visit = (value: unknown, keys: Keys): void => {
    if (value === null || typeof value !== "object") return;
    if (isTaggedSentinel(value)) {
      if (!out.has(value)) out.set(value, keys);
      return;
    }
    const fields = isExpansionSentinel(value) ? expansionBody(value) : value;
    if (Array.isArray(fields)) fields.forEach((item, i) => visit(item, [...keys, i]));
    else for (const [key, field] of Object.entries(fields)) visit(field, [...keys, key]);
  };
  for (const field of TEMPLATE_BODY_FIELDS) {
    const value = (definition as Record<string, unknown>)[field];
    if (value !== undefined) visit(value, [field]);
  }
  return out;
}

/** The names `value` declares as a body entry, under any option. */
function namesDeclared(value: unknown, into: Set<string>): void {
  if (value instanceof Alternatives) {
    for (const option of value.options) if (option.present) namesDeclared(option.value, into);
    return;
  }
  const name = (value as { metadata?: { name?: unknown } } | null)?.metadata?.name;
  if (typeof name === "string") into.add(name);
}

/** The local names every reference in `value` names, under any option: a
 *  `!ref`, or a family member a repeat's reference resolved to. */
function referencesIn(value: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (node instanceof Alternatives) {
      for (const option of node.options) if (option.present) visit(option.value);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (isRefSentinel(node)) {
      const name = localRefName(node);
      if (name) out.add(name.split("[")[0]!);
      return;
    }
    if (isTaggedSentinel(node)) return;
    const resolved = node as { kind?: unknown; name?: unknown };
    if (resolved.kind === "" && typeof resolved.name === "string") out.add(resolved.name.split("[")[0]!);
    for (const field of Array.isArray(node) ? node : Object.values(node)) visit(field);
  };
  visit(value);
  return out;
}

function textOf(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => (typeof field === "bigint" ? { $bigint: field.toString() } : field));
}
