/**
 * Where a declaration's own checks are cut into SITES: the regions each judged
 * once per key of its own, so a choice in one part of a declaration does not
 * multiply the judgement of another.
 *
 * A declaration is one site unless a choice in it can be judged apart. A choice
 * is cut out at the deepest position on the way to it that every schema node
 * above it reads member by member — SEPARABILITY, an allowlist:
 * `properties`, `patternProperties`, `additionalProperties`, `propertyNames`,
 * list-form `items`, `type`, scalar `enum` / `const`, the annotations, and
 * `allOf` recursively, local references and named shapes no configuration
 * varies followed. Every other keyword relates members (`anyOf`, `oneOf`,
 * `not`, `if`, `dependencies` and its successors, count bounds, `uniqueItems`,
 * `contains`, tuple `items` / `prefixItems`, an object-valued `enum` /
 * `const`), and so does a reference that does not resolve to one shape. A
 * member a choice may leave out is also related to its parent by `required`
 * naming it, and — since a check reports their verdict at the parent — by
 * `additionalProperties: false` refusing it and by `propertyNames`. The cut
 * position's region is its own site; what it holds is carved out of the
 * enclosing one. A region holding no choice is never cut.
 *
 * The schema in force at a position is every schema judging what is written
 * there. Beneath a declaration the normalization extracts, only its own kind's:
 * the holder judges the reference left in its place, so separability restarts
 * there — the declaration's own root read member by member or not — though the
 * extracted position itself is never cut, its holder's verdict reading the
 * reference. Beneath a scope member, left in place, its holder's and its own
 * kind's together. An object holding a `kind` anywhere else is the holder's
 * content. Which is which is the configuration runs' own enumeration
 * ({@link nestedPlacesOf}), never an object's shape.
 *
 * A finding belongs to the site whose region holds the place its check
 * judged: the node a keyword is evaluated at (a missing member's parent for
 * `required`), else its own place.
 *
 * Browser-safe.
 */
import { resolveSchemaReference } from "./schema-reference.js";
import type { ResourceManifest } from "@telorun/sdk";
import { expansionTagLabel, isTaggedSentinel } from "@telorun/templating";
import { assignmentKey, type Assignment } from "./configuration-dimensions.js";
import {
  holdingOf,
  isAlternatives,
  meet,
  takenAt,
  type AlternativeOption,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type Forcing,
  type Holding,
  World,
  type DeadBranchWorld,
} from "./conditioned-expansion.js";
import { FALSE, type ConditionSpace, type Condition } from "./presence-condition.js";
import { placeByProjectedKeys } from "./region-part.js";
import { isInlineDeclaration } from "./resolved-reference.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";

type Keys = readonly (string | number)[];

/**
 * Which of a declaration's own checks a site is judged for: its SCHEMA checks,
 * cut by separability. Every relational check is a relation site of its own
 * (`relation-sites.ts`).
 */
export type OwnSiteFamily = "schema";

/** One site of a declaration's own checks. */
export interface OwnSite {
  readonly id: string;
  readonly family: OwnSiteFamily;
  /** The declaration, or the forward view, whose region it is. */
  readonly declaration: ConditionedDeclaration;
  /** The union path of the region's root, a choice node transparent. */
  readonly unionKeys: Keys;
  /** Where the region's root is written in the holder document — for a
   *  view's site, where its consumer is: a view's own places are written
   *  nowhere, so its findings are attributed by union position. */
  readonly written: Keys;
  /** The options taken on the way to its root, inside the declaration. */
  readonly options: readonly AlternativeOption[];
  /** The declaration's condition and every option's on the way. */
  readonly condition: Condition;
  /** The union paths of the regions cut out of it. */
  readonly carved: ReadonlySet<string>;
  /** Whether a union stands at its root, reading its carved sites' verdicts
   *  per branch. */
  readonly union: boolean;
  /** The union path of the declaration whose validation judges its region:
   *  the extracted one it lies in, or the declaration's root. */
  readonly validatedAt: Keys;
  /** Whether no schema node constrains its region: nothing a union above it
   *  decides depends on it, or reports in it. */
  readonly inert: boolean;
  /** A lifted template body's unit, judged apart from the definition: the
   *  unit's site. */
  readonly unit?: TemplateBodyUnit;
  /** The root of a definition whose body is lifted: the units carved out of it. */
  readonly units?: readonly TemplateBodyUnit[];
}

/** What cutting reads of the schemas a declaration is judged against. */
export interface OwnSiteSchemas {
  /** The schema a declaration's own checks validate `value` against, read in
   *  the module `within` was written in. */
  rootOf(value: Record<string, any>, within: ResourceManifest): Record<string, any> | undefined;
  /** A named shape no configuration varies, by its `$ref`; undefined for one
   *  some configuration varies or none declares. */
  invariantShape(ref: string): Record<string, any> | undefined;
  /** How each object written beneath `declaration` is judged. */
  nestedPlacesOf(declaration: ConditionedDeclaration): NestedPlaces;
  /** Whether a check of the declaration relates its parts to each other, so
   *  that no choice in it is judged apart: its root reads member by member
   *  no more than a `not` does. */
  relatesRoot(declaration: ConditionedDeclaration): boolean;
}

/** The identity of a site: the declaration's written identity and where its
 *  region's root is written. */
export function ownSiteId(kind: unknown, name: unknown, filePath: unknown, written: Keys): string {
  return JSON.stringify([kind, name, filePath, written]);
}

const MEMBER_LOCAL = new Set([
  "type",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "items",
  "allOf",
  "$ref",
  "enum",
  "const",
  "required",
  "anyOf",
  "oneOf",
]);

/** Applicators whose subschemas judge the node they stand at: a `not`, and
 *  `then` / `else` selected by `if`. */
const APPLIED: readonly string[] = ["not", "if", "then", "else"];

/** Keywords that judge nothing. */
function isAnnotation(keyword: string): boolean {
  return (
    keyword.startsWith("x-telo-") ||
    [
      "title",
      "description",
      "default",
      "examples",
      "$comment",
      "$id",
      "$schema",
      "$defs",
      "definitions",
      "deprecated",
      "readOnly",
      "writeOnly",
      "contentMediaType",
      "contentEncoding",
    ].includes(keyword)
  );
}

/** One schema node in force at a data position, and the document its local
 *  references resolve in. */
interface Conjunct {
  readonly node: Record<string, any>;
  readonly document: Record<string, any>;
}

/**
 * The schema in force at a position: its conjuncts — every `anyOf` / `oneOf`
 * branch among them, read member by member like any conjunct — or `related`
 * where one relates members or a reference does not resolve. `union`: a union
 * stands here. `applied`: the subschemas of `not`, `if` / `then` / `else` and
 * `dependentSchemas` here, which relate a member they reach.
 */
type InForce = {
  readonly conjuncts: readonly Conjunct[];
  readonly related: boolean;
  readonly union?: boolean;
  readonly applied?: readonly Conjunct[];
};

/** `node` and everything it brings in: its references, `allOf` members and
 *  union branches. */
function expand(node: unknown, document: Record<string, any>, schemas: OwnSiteSchemas, seen: Set<object>): InForce {
  if (node === true || node === undefined) return { conjuncts: [], related: false };
  if (!node || typeof node !== "object" || Array.isArray(node)) return { conjuncts: [], related: true };
  const schema = node as Record<string, any>;
  if (seen.has(schema)) return { conjuncts: [], related: false };
  seen.add(schema);
  const conjuncts: Conjunct[] = [{ node: schema, document }];
  const applied: Conjunct[] = [];
  let related = false;
  let union = false;
  for (const keyword of Object.keys(schema)) {
    if (MEMBER_LOCAL.has(keyword) || isAnnotation(keyword)) continue;
    if (APPLIED.includes(keyword)) {
      const inner = expand(schema[keyword], document, schemas, new Set(seen));
      applied.push(...inner.conjuncts, ...(inner.applied ?? []));
      related ||= inner.related;
      continue;
    }
    if (keyword === "dependentSchemas" && schema[keyword] && typeof schema[keyword] === "object") {
      for (const member of Object.values(schema[keyword] as Record<string, unknown>)) {
        const inner = expand(member, document, schemas, new Set(seen));
        applied.push(...inner.conjuncts, ...(inner.applied ?? []));
        related ||= inner.related;
      }
      continue;
    }
    related = true;
  }
  if (Array.isArray(schema.items)) related = true;
  for (const keyword of ["enum", "const"] as const) {
    const values = keyword === "enum" ? schema.enum : [schema.const];
    if (keyword in schema && Array.isArray(values) && values.some((v: unknown) => v !== null && typeof v === "object")) {
      related = true;
    }
  }
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref as string;
    const target = resolveSchemaReference(ref, document, (id) => schemas.invariantShape(id) as Record<string, any> | undefined);
    if (target === undefined) related = true;
    else {
      const inner = expand(target.node, target.document, schemas, seen);
      conjuncts.push(...inner.conjuncts);
      applied.push(...(inner.applied ?? []));
      related ||= inner.related;
      union ||= !!inner.union;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) {
      const inner = expand(member, document, schemas, seen);
      conjuncts.push(...inner.conjuncts);
      applied.push(...(inner.applied ?? []));
      related ||= inner.related;
      union ||= !!inner.union;
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    union = true;
    for (const member of schema[keyword]) {
      const inner = expand(member, document, schemas, new Set(seen));
      conjuncts.push(...inner.conjuncts);
      applied.push(...(inner.applied ?? []));
      related ||= inner.related;
    }
  }
  return { conjuncts, related, union, applied };
}

/** Whether a node says anything of member `key`. */
function reaches(node: Record<string, any>, key: string): boolean {
  if (node.properties && Object.hasOwn(node.properties, key) && node.properties[key] !== true) return true;
  for (const pattern of Object.keys((node.patternProperties ?? {}) as Record<string, unknown>)) {
    try {
      if (new RegExp(pattern, "u").test(key)) return true;
    } catch {
      return true;
    }
  }
  return node.additionalProperties !== undefined && node.additionalProperties !== false && node.additionalProperties !== true;
}

/** What every conjunct says of member `key`: the schema in force at it. An
 *  applied subschema reaching it relates the parent's members, which
 *  {@link relatesMembers} reads at the parent. */
function memberInForce(at: InForce, key: string, schemas: OwnSiteSchemas): InForce {
  const conjuncts: Conjunct[] = [];
  let related = false;
  const applied: Conjunct[] = [];
  let union = false;
  for (const { node, document } of at.conjuncts) {
    const properties = node.properties as Record<string, unknown> | undefined;
    const own: unknown[] = [];
    if (properties && Object.hasOwn(properties, key)) own.push(properties[key]);
    for (const [pattern, child] of Object.entries((node.patternProperties ?? {}) as Record<string, unknown>)) {
      try {
        if (new RegExp(pattern, "u").test(key)) own.push(child);
      } catch {
        related = true;
      }
    }
    if (own.length === 0 && node.additionalProperties !== undefined) own.push(node.additionalProperties);
    for (const child of own) {
      if (child === false) continue;
      const inner = expand(child, document, schemas, new Set());
      conjuncts.push(...inner.conjuncts);
      applied.push(...(inner.applied ?? []));
      related ||= inner.related;
      union ||= !!inner.union;
    }
  }
  return { conjuncts, related, union, applied };
}

/** What every conjunct says of a list item. */
function itemInForce(at: InForce, schemas: OwnSiteSchemas): InForce {
  const conjuncts: Conjunct[] = [];
  let related = false;
  const applied: Conjunct[] = [];
  let union = false;
  for (const { node, document } of at.conjuncts) {
    if (node.items === undefined || Array.isArray(node.items)) continue;
    const inner = expand(node.items, document, schemas, new Set());
    conjuncts.push(...inner.conjuncts);
    applied.push(...(inner.applied ?? []));
    related ||= inner.related;
    union ||= !!inner.union;
  }
  return { conjuncts, related, union, applied };
}

/** Whether an applied subschema at `at` reaches a member of `value` — the
 *  node beneath which its members relate, cut at itself. */
function relatesMembers(at: InForce, value: unknown): boolean {
  const applied = at.applied ?? [];
  if (applied.length === 0 || value === null || typeof value !== "object" || isTaggedSentinel(value)) return false;
  if (Array.isArray(value)) return applied.some(({ node }) => node.items !== undefined || node.prefixItems !== undefined);
  const keys = Object.keys(value);
  return applied.some(({ node }) => keys.some((key) => reaches(node, key)));
}

/** Whether a member `key` a choice may leave out is related to its parent:
 *  required by it, refused by `additionalProperties: false`, or held to its
 *  `propertyNames`. */
function omissionRelates(parent: InForce, key: string): boolean {
  for (const { node } of [...parent.conjuncts, ...(parent.applied ?? [])]) {
    if (Array.isArray(node.required) && node.required.includes(key)) return true;
    if (node.propertyNames !== undefined) return true;
    if (node.additionalProperties !== false) continue;
    const declared = !!node.properties && Object.hasOwn(node.properties, key);
    const patterned = Object.keys((node.patternProperties ?? {}) as Record<string, unknown>).some((pattern) => {
      try {
        return new RegExp(pattern, "u").test(key);
      } catch {
        return true;
      }
    });
    if (!declared && !patterned) return true;
  }
  return false;
}

/** Whether nothing in force at a position judges what is written there — an
 *  `x-telo-*` keyword may be a validating one (`x-telo-type`). */
function unconstrained(at: InForce): boolean {
  return (
    !at.related &&
    !at.union &&
    at.conjuncts.every(({ node }) =>
      Object.keys(node).every((keyword) => keyword === "$ref" || (isAnnotation(keyword) && !keyword.startsWith("x-telo-"))),
    )
  );
}

/** Whether a union value holds a choice anywhere inside it. */
function holdsChoice(value: unknown): boolean {
  if (isAlternatives(value)) return true;
  if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return false;
  return (Array.isArray(value) ? value : Object.values(value)).some(holdsChoice);
}

/** Every site of `declaration`'s own checks, the declaration's own first and
 *  the others in written order. A forward view's (`view`, which tells it from
 *  every other view of the union) are identified by its consumer's identity,
 *  the view and the union path of each region's root — never by a written
 *  place, which its consumer's own sites hold. A template definition whose
 *  body is lifted (`units`) is a root with every unit carved and one site per
 *  unit. */
export function ownSitesOf(
  declaration: ConditionedDeclaration,
  space: ConditionSpace,
  schemas: OwnSiteSchemas,
  view?: string,
  units?: readonly TemplateBodyUnit[],
): OwnSite[] {
  const holder = declaration.holder;
  const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
  const kind = holder.kind ?? expansionTagLabel(holder);
  const out: OwnSite[] = [];
  const open = (
    unionKeys: Keys,
    written: Keys,
    options: readonly AlternativeOption[],
    condition: Condition,
    union: boolean,
    validatedAt: Keys,
    inert = false,
    body: Pick<OwnSite, "unit" | "units"> = {},
  ): OwnSite & { carved: Set<string> } => {
    const site = {
      ...body,
      union,
      validatedAt,
      inert,
      id:
        view === undefined
          ? ownSiteId(kind, meta?.name, meta?.source, written)
          : JSON.stringify([kind, meta?.name, meta?.source, declaration.at, "view", view, unionKeys]),
      written: view === undefined ? written : declaration.at,
      family: "schema" as const,
      declaration,
      unionKeys,
      options,
      condition,
      carved: new Set<string>(),
    };
    out.push(site);
    return site;
  };
  const kindDocument = declaration.manifest.kind === "Telo.Definition" || declaration.manifest.kind === "Telo.Abstract";
  const rootSchema = kindDocument ? undefined : schemas.rootOf(declaration.manifest as Record<string, any>, declaration.manifest);
  const expanded = rootSchema ? expand(rootSchema, rootSchema, schemas, new Set()) : undefined;
  const rootInForce: InForce | undefined = expanded && schemas.relatesRoot(declaration) ? { ...expanded, related: true } : expanded;
  const lifted = kindDocument && units && units.length > 0 ? units : undefined;
  const root = open([], declaration.at, [], declaration.condition, !!rootInForce?.union, [], false, lifted ? { units: lifted } : {});
  if (lifted) {
    for (const unit of lifted) {
      open(unit.keys, [...declaration.at, ...unit.keys], [], declaration.condition, false, [], false, { unit });
      root.carved.add(JSON.stringify(unit.keys));
    }
    return out;
  }
  if (!rootSchema || !rootInForce) return out;
  const nested = schemas.nestedPlacesOf(declaration);

  /**
   * `value` at `unionKeys`: `inForce` the schema there, `separable` whether
   * every node from the site's root down to its parent reads member by member,
   * `omission` whether a choice there leaving the member out is related to its
   * parent, `unions` whether a union is read through here — never beneath a
   * scope member, whose own declaration judges the region again — and
   * `validatedAt` the declaration whose validation judges the position.
   */
  const visit = (
    value: unknown,
    given: InForce,
    unionKeys: Keys,
    written: Keys,
    options: readonly AlternativeOption[],
    condition: Condition,
    site: OwnSite & { carved: Set<string> },
    separable: boolean,
    omission: (() => boolean) | undefined,
    unions: boolean,
    validatedAt: Keys,
  ): void => {
    if (!holdsChoice(value)) return;
    const inForce: InForce = unions || !given.union ? given : { ...given, related: true };
    const choice = isAlternatives(value) ? value : undefined;
    const membersRelate = !choice && relatesMembers(inForce, value);
    const mayOmit = !!choice && choice.options.some((option) => !option.present);
    const cuttable = separable && unionKeys.length > site.unionKeys.length && !(mayOmit && omission?.());
    // The deepest position on the way to a choice the path reads member by
    // member: the choice itself, a union, or the node beneath which members
    // relate. Beneath a union the branches are read member by member.
    if (cuttable && (choice !== undefined || inForce.related || membersRelate || !!inForce.union)) {
      const cut = open(unionKeys, written, options, condition, !!inForce.union && unions, validatedAt, unconstrained(inForce));
      site.carved.add(JSON.stringify(unionKeys));
      site = cut;
    }
    if (choice) {
      for (const option of choice.options) {
        if (!option.present) continue;
        visit(
          option.value,
          inForce,
          unionKeys,
          option.at,
          [...options, option],
          space.and(condition, option.condition),
          site,
          // Inside a choice's own site, separability is read afresh below it.
          site.unionKeys.length === unionKeys.length ? !inForce.related : separable && !inForce.related,
          undefined,
          unions,
          validatedAt,
        );
      }
      return;
    }
    const below = separable && !inForce.related && !membersRelate;
    if (Array.isArray(value)) {
      const items = itemInForce(inForce, schemas);
      value.forEach((item, i) =>
        visit(item, items, [...unionKeys, i], [...written, i], options, condition, site, below, undefined, unions, validatedAt),
      );
      return;
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
    const record = value as Record<string, unknown>;
    let here = inForce;
    let childSeparable = below;
    let childUnions = unions;
    let childValidatedAt = validatedAt;
    const place = unionKeys.length > 0 ? nested.of(record) : undefined;
    if (place === "undecided") childSeparable = false;
    else if (place !== undefined) {
      const ownRoot = schemas.rootOf(record as Record<string, any>, declaration.manifest);
      const own = ownRoot ? expand(ownRoot, ownRoot, schemas, new Set()) : { conjuncts: [], related: false };
      if (place === "extracted") {
        here = own;
        childSeparable = !own.related && !relatesMembers(own, record);
        childValidatedAt = unionKeys;
      } else {
        here = {
          conjuncts: [...inForce.conjuncts, ...own.conjuncts],
          related: inForce.related || own.related,
          union: !!inForce.union || !!own.union,
          applied: [...(inForce.applied ?? []), ...(own.applied ?? [])],
        };
        childSeparable = below && !own.related && !here.union && !relatesMembers(here, record);
        childUnions = false;
      }
    }
    for (const [key, field] of Object.entries(record)) {
      visit(
        field,
        memberInForce(here, key, schemas),
        [...unionKeys, key],
        [...written, key],
        options,
        condition,
        site,
        childSeparable,
        () => omissionRelates(here, key),
        childUnions,
        childValidatedAt,
      );
    }
  };
  visit(declaration.manifest, rootInForce, [], declaration.at, [], declaration.condition, root, true, undefined, true, []);
  return out;
}

/** The site of `sites` whose region holds the written place `keys`: the
 *  deepest whose root is on its way. */
export function ownSiteHolding(sites: readonly OwnSite[], keys: Keys): OwnSite | undefined {
  let best: OwnSite | undefined;
  for (const site of sites) {
    if (site.written.length > keys.length) continue;
    if (!site.written.every((key, i) => String(key) === String(keys[i]))) continue;
    if (!best || site.written.length > best.written.length) best = site;
  }
  return best;
}

// Which objects written beneath a declaration of the union the configuration
// runs analyse as declarations of their own, judged by their own kind: what
// inline normalization extracts — a reference site's or a step's dispatch
// target, its place left holding a reference — and every scope member, left in
// place. Asked of the runs' own enumeration, never of an object's shape: each
// object holding a `kind` is a candidate, settled by enumerating the
// declaration projected at a configuration taking it. One projection serves
// every candidate a configuration takes, so a declaration holding K candidates
// under independent choices is enumerated once, not K times.

/** How an object beneath a declaration is judged: drawn out by normalization
 *  (`extracted`), a scope member left in place (`member`), or not known —
 *  its own `kind` decided by a choice, or no configuration settles it. An
 *  object absent from the answer is the holder's content. */
export type NestedPlace = "extracted" | "member" | "undecided";

/** One declaration the runs analyse beneath another: where it lands in the
 *  declaration projected, and how the run comes to analyse it. */
export interface EnumeratedDeclaration {
  readonly keys: Keys;
  readonly via: "extraction" | "scope";
}

export interface NestedPlaces {
  /** How the object `record` of the union is judged. */
  of(record: object): NestedPlace | undefined;
  /** The enumerations it took. */
  readonly enumerations: number;
}

interface Candidate {
  readonly record: object;
  readonly unionKeys: Keys;
  readonly holding: Holding;
  /** For one only a branch no configuration takes holds: the innermost such
   *  option on the way, read at its baseline with its forcing. */
  readonly dead?: { readonly baseline: Assignment; readonly forcing: Forcing; readonly world: DeadBranchWorld };
}

/**
 * The {@link NestedPlaces} of `declaration`, each candidate settled by
 * `enumerate` — the runs' enumeration of the declarations beneath one
 * projected declaration — at a configuration taking it.
 */
export function nestedPlacesOf(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  enumerate: (projected: ResourceManifest) => readonly EnumeratedDeclaration[],
): NestedPlaces {
  const { space } = union;
  const answer = new Map<object, NestedPlace>();
  const candidates: Candidate[] = [];
  const visit = (value: unknown, unionKeys: Keys, holding: Holding, dead: Candidate["dead"], root: boolean): void => {
    if (isAlternatives(value)) {
      for (const option of value.options) {
        if (!option.present) continue;
        const deadHere =
          option.unreachable && option.baseline && option.forcing ? { baseline: option.baseline, forcing: option.forcing, world: option.world! } : dead;
        visit(option.value, unionKeys, meet(space, holding, holdingOf(option)), deadHere, root);
      }
      return;
    }
    if (!value || typeof value !== "object" || isTaggedSentinel(value) || (value as { __compiled?: unknown }).__compiled) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...unionKeys, i], holding, dead, false));
      return;
    }
    const record = value as Record<string, unknown>;
    if (!root) {
      if (isAlternatives(record.kind)) answer.set(record, "undecided");
      else if (isInlineDeclaration(record)) candidates.push({ record, unionKeys, holding, ...(dead ? { dead } : {}) });
    }
    for (const [key, field] of Object.entries(record)) visit(field, [...unionKeys, key], holding, dead, false);
  };
  visit(declaration.manifest, [], { condition: declaration.condition, path: declaration.path }, undefined, true);
  if (candidates.length === 0) return { of: (record) => answer.get(record), enumerations: 0 };

  // Candidates a configuration takes together share its projection: each live
  // one joins the first group whose condition it meets, dead ones group by the
  // choices they force.
  const live: { condition: Condition; members: Candidate[] }[] = [];
  const forced: { forcing: Forcing; witness: World; members: Candidate[] }[] = [];
  for (const candidate of candidates) {
    if (candidate.dead) {
      const { baseline, forcing } = candidate.dead;
      if (!takenAt(space, candidate.holding.condition, candidate.holding.path, baseline, forcing)) {
        answer.set(candidate.record, "undecided");
        continue;
      }
      const group = forced.find((g) => g.forcing === forcing);
      if (group) group.members.push(candidate);
      else forced.push({ forcing, witness: candidate.dead.world, members: [candidate] });
      continue;
    }
    if (candidate.holding.condition === FALSE) {
      answer.set(candidate.record, "undecided");
      continue;
    }
    let joined = false;
    for (const group of live) {
      const both = space.and(group.condition, candidate.holding.condition);
      if (both === FALSE) continue;
      group.condition = both;
      group.members.push(candidate);
      joined = true;
      break;
    }
    if (!joined) live.push({ condition: candidate.holding.condition, members: [candidate] });
  }
  const groups: { witness: World | undefined; members: Candidate[] }[] = [
    ...live.map((group) => {
      const assignment = space.firstAssignment(group.condition);
      return { witness: assignment ? World.key(assignment as Assignment) : undefined, members: group.members };
    }),
    ...forced,
  ];
  let enumerations = 0;
  const text = (keys: Keys) => JSON.stringify(keys.map(String));
  for (const { witness, members } of groups) {
    const projected = witness ? union.project(declaration.manifest, witness.assignment, witness.forcing) : undefined;
    if (!witness || !projected?.present) {
      for (const member of members) answer.set(member.record, "undecided");
      continue;
    }
    enumerations++;
    const settled = new Map<string, NestedPlace>();
    for (const found of enumerate(projected.value as ResourceManifest)) {
      const place = placeByProjectedKeys(union, declaration, found.keys, witness);
      if (place.present) settled.set(text(place.unionKeys), found.via === "scope" ? "member" : "extracted");
    }
    for (const member of members) {
      const place = settled.get(text(member.unionKeys));
      if (place) answer.set(member.record, place);
    }
  }
  return { of: (record) => answer.get(record), enumerations };
}
