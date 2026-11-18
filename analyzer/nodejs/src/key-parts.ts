/**
 * What a key's environment is built from: each declaration of the union
 * normalized on its own, as a configuration's analysis normalizes it — a
 * template definition's body as the witness decides it (its reading projected
 * at the witness's assignment of the definition's own dimensions), its inline
 * declarations extracted,
 * its references stamped with what they resolve to at the witness, its scope
 * members collected — and interned, so a declaration is normalized once per
 * distinct (projection, body projection, outcome of each reference it
 * stamps), and two keys whose projections are equal hold the same objects.
 *
 * A declaration whose every reference resolves one way at every witness is
 * FIXED: its part is the same wherever it projects alike. The fixed parts of
 * the declarations no configuration a key is judged for varies (`doorCare`)
 * are, per care, the SHARED layer, built once per analysis and read beneath
 * every key's own parts, so a key's environment is built from what it reads
 * and never from the whole application. A template definition reading no
 * configuration is held there with its body at its first values; a key whose
 * witness decides that body otherwise holds its own part in its place.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import type { ConditionedNameIndex, NamePopulation } from "./conditioned-name-index.js";
import {
  isAlternatives,
  takenAt,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type PlaceMap,
  type PlaceMapping,
  type Projected,
  type World,
} from "./conditioned-expansion.js";
import type { DefinitionRegistry, VaryingShapeClasses } from "./definition-registry.js";
import type { DoorCare } from "./key-door.js";
import { normalizeInlineResources } from "./normalize-inline-resources.js";
import { TRUE, type Condition } from "./presence-condition.js";
import { UNRESOLVED, type NameResolution, type RefResolution, type ResolutionOutcome } from "./reference-resolution.js";
import { resolveRefSentinels } from "./resolve-ref-sentinels.js";
import { resolveSchemaTypeRefs } from "./resolve-schema-type-refs.js";
import { isKindDocument } from "./kind-declaration.js";
import { isCarvedResult } from "./step-result-inference.js";
import type { ScopeSite } from "./scope-address.js";
import { collectScopeMembers, type ScopeMember } from "./scope-members.js";
import { MANIFEST_READING, ScopedNameResolver } from "./scoped-name-resolver.js";
import type { DefinitionProjection, TemplateDefinitions } from "./template-definition-check.js";
import { emittedInlineName, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import { isExpansionSentinel, isTaggedSentinel } from "@telorun/templating";
import {
  CARVED_PLACE,
  memberIdentity,
  optionAt,
  placeByUnionKeys,
  regionMappings,
  regionSkeleton,
  scopeMemberPlaces,
  valueAtKeys,
} from "./region-part.js";
import { isAtOrAbove } from "./relation-sites.js";

/** A template definition as one way of deciding it expands its body, and as
 *  written. */
export interface TemplateVariantOf {
  readonly variant: DefinitionProjection;
  readonly written: ResourceManifest;
}

/** One reference resolution a part's stamps read, and what it found. */
interface Lookup {
  readonly population: NamePopulation;
  readonly name: string;
  /** `locate`: the reader's module and scope; `inModule`: the module and
   *  instance named. */
  readonly locate?: { readonly fromModule: string | undefined; readonly within: ScopeSite | undefined };
  readonly inModule?: { readonly module: string | undefined; readonly importPath: readonly string[] | undefined };
  readonly outcome: ResolutionOutcome;
  /** The same at every witness. */
  readonly fixed: boolean;
}

/** Whether a reference slot some configuration's named shapes declare held
 *  where a part was normalized: the condition the slot holds under, and what
 *  it decided there. */
interface SlotLookup {
  readonly condition: Condition;
  readonly held: boolean;
}

/** One declaration of the union, normalized. */
export interface DeclarationPart {
  readonly declaration: ConditionedDeclaration;
  readonly projection: Projected;
  /** The declaration as normalized, then every declaration extraction drew out
   *  of it at the top level, then its scope members at any depth. */
  readonly manifests: readonly ResourceManifest[];
  /** The declaration as written, before extraction and reference resolution
   *  rewrote it — the one place an author-written reference form is told from
   *  what resolution wrote. */
  readonly raw: ResourceManifest;
  /** Its scope members: the analysed ones, and the kind documents. */
  readonly members: readonly ScopeMember[];
  readonly kindMembers: readonly ScopeMember[];
  /** Set for a template definition: its body as the part's witness decides it. */
  readonly template?: TemplateVariantOf;
  /** The same part at every witness projecting it alike. */
  readonly fixed: boolean;
  readonly lookups: readonly Lookup[];
  readonly slots: readonly SlotLookup[];
}

/** Some regions of a declaration of the union, normalized on their own. */
export interface RegionPart {
  readonly declaration: ConditionedDeclaration;
  /** The first region root's projected keys and where it is written — the
   *  declaration's root where it holds none. */
  readonly at: readonly (string | number)[];
  readonly written: readonly (string | number)[];
  /** Every region root it holds, the first one first. */
  readonly roots: readonly { readonly at: readonly (string | number)[]; readonly written: readonly (string | number)[] }[];
  /** The region's manifest as normalized — the declaration's `kind`,
   *  `metadata`, the way to the root and the region — then what extraction
   *  drew out of it, then its scope members. */
  readonly manifests: readonly ResourceManifest[];
  /** The region's manifest as written, before extraction and reference
   *  resolution rewrote it. */
  readonly raw: ResourceManifest;
  /** Its manifest and where each of its positions is written. */
  readonly projection: Projected;
  /** The nodes it holds of its declaration, counted before normalization
   *  rewrites them — as a declaration's part counts its projection. */
  readonly nodes: number;
  /** Its scope members: the analysed ones, and the kind documents. */
  readonly members: readonly ScopeMember[];
  readonly kindMembers: readonly ScopeMember[];
  readonly lookups: readonly Lookup[];
  readonly slots: readonly SlotLookup[];
}

/** How many values `value` holds, itself included; a carved producer's
 *  stand-in is one, whatever fact it carries. */
export function countNodes(value: unknown): number {
  if (value === null || typeof value !== "object" || isCarvedResult(value)) return 1;
  let n = 1;
  // A region's list holds it alone at its index: the places before it hold nothing.
  for (const field of Object.values(value)) if (field !== undefined) n += countNodes(field);
  return n;
}

/**
 * The extent of the regions of `declaration` rooted at `roots` (union keys) at
 * `witness`, counted from the union as written — never from what a key
 * normalizes: the declaration's `kind` and `metadata`, each object on the way
 * to every region with what it holds beside the way (one node each) and the
 * `kind` and `metadata` of an inline declaration on it, each member of the
 * scopes declared on the way as its identity, and each region, each place at
 * `carved` one node; a region beneath another is the other's.
 */
export function regionExtent(
  union: ConditionedExpansion,
  declaration: ConditionedDeclaration,
  roots: readonly (readonly (string | number)[])[],
  carved: readonly (readonly (string | number)[])[],
  witness: World,
  scopeFields: (holder: { readonly kind: unknown; readonly metadata: unknown }) => readonly string[],
): number {
  const text = (keys: readonly (string | number)[]) => JSON.stringify(keys);
  const places = roots.map((keys) => placeByUnionKeys(union, declaration, keys, witness)).filter((place) => place.present);
  const members = new Set(scopeMemberPlaces(union, declaration, places, witness, scopeFields));
  places.push(...members);
  const held = places.filter(
    (place, i) =>
      !places.some((other, j) => j !== i && isAtOrAbove(other.at, place.at) && (other.at.length < place.at.length || j < i)),
  );
  const carvedText = new Set(carved.map(text));
  const contentOf = (unionKeys: readonly (string | number)[], node: unknown): unknown => {
    const visit = (value: unknown, keys: readonly (string | number)[]): { present: boolean; value?: unknown } => {
      if (keys.length > unionKeys.length && carvedText.has(text(keys))) return { present: true, value: CARVED_PLACE };
      while (isAlternatives(value)) {
        const option = optionAt(union, value, witness);
        if (!option?.present) return { present: false };
        value = option.value;
      }
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return { present: true, value };
      if (Array.isArray(value)) {
        return {
          present: true,
          value: value.flatMap((item, i) => {
            const inner = visit(item, [...keys, i]);
            return inner.present ? [inner.value] : [];
          }),
        };
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        const inner = visit(field, [...keys, key]);
        if (inner.present) out[key] = inner.value;
      }
      return { present: true, value: out };
    };
    return visit(node, unionKeys).value;
  };
  const whole = held.find((place) => place.at.length === 0);
  if (whole) return countNodes(contentOf(whole.unionKeys, whole.node));
  // The identity of an object on the way, but a field a region is rooted at,
  // which that region holds.
  const rooted = new Set(held.map((place) => text(place.at)));
  const identity = (at: readonly (string | number)[], value: { kind: unknown; metadata: unknown }) =>
    (rooted.has(text([...at, "kind"])) ? 0 : countNodes(value.kind)) +
    (value.metadata === undefined || rooted.has(text([...at, "metadata"])) ? 0 : countNodes(value.metadata));
  let n = 1 + identity([], { kind: declaration.manifest.kind, metadata: declaration.manifest.metadata });
  const ways = new Map<string, { beside: Set<string>; way: Set<string> }>();
  const intermediate = new Set<string>();
  for (const place of held) {
    for (let depth = 0; depth < place.at.length; depth++) {
      const prefix = text(place.at.slice(0, depth));
      const members = place.enclosing.get(depth);
      if (members) {
        const declared = depth === 0 || place.identities.has(depth);
        const entry = ways.get(prefix) ?? { beside: new Set<string>(), way: new Set<string>() };
        ways.set(prefix, entry);
        entry.way.add(String(place.at[depth]));
        for (const member of Object.keys(members)) {
          if (declared && (member === "kind" || member === "metadata")) continue;
          entry.beside.add(member);
        }
      }
      if (depth + 1 === place.at.length) continue;
      const next = text(place.at.slice(0, depth + 1));
      if (intermediate.has(next)) continue;
      intermediate.add(next);
      n++;
      const inner = place.identities.get(depth + 1);
      if (inner && typeof place.at[depth + 1] !== "number") n += identity(place.at.slice(0, depth + 1), inner);
    }
    n += countNodes(members.has(place) ? memberIdentity(union, place, witness).value : contentOf(place.unionKeys, place.node));
  }
  for (const { beside, way } of ways.values()) for (const member of beside) if (!way.has(member)) n++;
  return n;
}

/** What every key reads beneath its own parts. */
export interface SharedLayer {
  readonly parts: readonly DeclarationPart[];
  /** Declarations no configuration of the care varies whose part is not
   *  fixed: a key holds each at its own witness. */
  readonly dependent: readonly ConditionedDeclaration[];
  /** Every manifest of `parts`, in analysis order. */
  readonly manifests: readonly ResourceManifest[];
  readonly names: ScopedNameResolver<ResourceManifest>;
  readonly templateVariants: ReadonlyMap<string, TemplateVariantOf>;
  /** The template definitions held here, each at its first values: a key whose
   *  witness names one of its dimensions or forces one of its choices holds
   *  its own part in its place. */
  readonly templated: ReadonlyMap<ConditionedDeclaration, DeclarationPart>;
}

export interface KeyPartsInputs {
  readonly union: ConditionedExpansion;
  readonly names: ConditionedNameIndex;
  /** What a key judged at a witness holds fixed. */
  readonly careAt: (witness: World) => DoorCare;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly templates: TemplateDefinitions | undefined;
  /** The fields a declaration of `holder`'s kind declares a scope at. */
  readonly scopeFieldsOf: (holder: { readonly kind: unknown; readonly metadata: unknown }) => readonly string[];
  /** The named shapes some configuration varies, as their classes: what a
   *  reference slot one declares is read through — a cut point of the
   *  declaration, decided at each witness. */
  readonly varying: VaryingShapeClasses<Condition> | undefined;
}

/** Where a manifest stands in an analysis's list: section (a declaration and
 *  what extraction drew out of it, then scope members, then forward views),
 *  depth, its declaration's place in the union, and its place in its part. */
type Rank = readonly [number, number, number, number];
const ranks = new WeakMap<object, Rank>();

/** The order an analysis lists manifests in — the order the whole list's
 *  normalization would give them. */
export function analysisOrder(a: object, b: object): number {
  const x = ranks.get(a);
  const y = ranks.get(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Rank `views` after every part's manifests, in the order given. */
export function rankForwardViews(views: readonly ResourceManifest[]): void {
  views.forEach((view, i) => ranks.set(view, [2, 0, 0, i]));
}

/** `parts`' manifests, in analysis order. */
export function partManifests(parts: Iterable<DeclarationPart>): ResourceManifest[] {
  const out: ResourceManifest[] = [];
  for (const part of parts) out.push(...part.manifests);
  return out.sort(analysisOrder);
}

/** The template variant of every template definition among `parts`. */
export function templateVariantsOf(parts: Iterable<DeclarationPart>): Map<string, TemplateVariantOf> {
  const out = new Map<string, TemplateVariantOf>();
  for (const part of parts) if (part.template) out.set(templateKeyOf(part.template.written), part.template);
  return out;
}

export function templateKeyOf(m: { kind?: unknown; metadata?: unknown }): string {
  const meta = m.metadata as { name?: unknown; module?: unknown; source?: unknown } | undefined;
  return `${m.kind}\0${meta?.module}\0${meta?.name}\0${meta?.source}`;
}

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );

function sameOutcome(a: ResolutionOutcome, b: ResolutionOutcome): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "unresolved" || b.status === "unresolved") return true;
  return a.declaration === b.declaration && a.address.key === b.address.key;
}

export class KeyParts {
  private readonly position = new Map<ConditionedDeclaration, number>();
  private readonly cache = new Map<ConditionedDeclaration, Map<string, DeclarationPart[]>>();
  private readonly definitions: ReadonlySet<ResourceManifest>;
  private readonly projectionIds = new WeakMap<object, number>();
  private nextProjectionId = 1;
  private readonly shared = new Map<DoorCare, SharedLayer>();
  private readonly regions = new Map<ConditionedDeclaration, Map<string, RegionPart[]>>();
  private readonly roots = new Map<ConditionedDeclaration, PlaceMap>();
  private definitionsByIdentity: Map<string, ConditionedDeclaration> | undefined;
  private definitionsBySentinel: Map<object, ConditionedDeclaration> | undefined;
  private readonly touched = new WeakMap<World, ReadonlySet<ConditionedDeclaration>>();

  constructor(private readonly input: KeyPartsInputs) {
    // A union position for every declaration, and for every forward view after
    // them: positions are the union's.
    input.union.declarations.forEach((d, i) => this.position.set(d, i));
    input.union.views.forEach((v, i) => this.position.set(v, input.union.declarations.length + i));
    this.definitions = new Set(input.templates?.definitions ?? []);
  }

  /** Whether `declaration` is present at `witness`. */
  presentAt(declaration: ConditionedDeclaration, witness: World): boolean {
    return takenAt(this.input.union.space, declaration.condition, declaration.path, witness.assignment, witness.forcing);
  }

  /** The fixed parts in the care of `witness`, built at the first key
   *  reading them. A declaration a whole-document choice declares is held
   *  fixed only where no branch is forced; a template definition never, its
   *  body read as each key's own witness decides it. */
  sharedLayer(witness: World): SharedLayer {
    const care = this.input.careAt(witness);
    const known = this.shared.get(care);
    if (known) return known;
    const parts: DeclarationPart[] = [];
    const dependent: ConditionedDeclaration[] = [];
    const templated = new Map<ConditionedDeclaration, DeclarationPart>();
    for (const declaration of this.input.union.declarations) {
      if (!care.invariant.has(declaration)) continue;
      if (this.definitions.has(declaration.manifest)) {
        const part =
          this.input.templates!.configurationDimensionsOf(declaration.manifest).length === 0
            ? this.partAt(declaration, this.atFirstValues(declaration, witness))
            : undefined;
        if (part?.fixed && (declaration.path.length === 0 || !witness.forcing)) {
          parts.push(part);
          templated.set(declaration, part);
        } else dependent.push(declaration);
        continue;
      }
      const part = this.partAt(declaration, witness);
      if (part.fixed && (declaration.path.length === 0 || !witness.forcing)) parts.push(part);
      else dependent.push(declaration);
    }
    const manifests = partManifests(parts);
    const layer: SharedLayer = {
      parts,
      dependent,
      manifests,
      names: new ScopedNameResolver(manifests, MANIFEST_READING),
      templateVariants: templateVariantsOf(parts),
      templated,
    };
    this.shared.set(care, layer);
    return layer;
  }

  /** The template definitions whose body `witness` decides otherwise than at
   *  their first values: one it names a dimension of, or forces a choice of. */
  touchedDefinitions(witness: World): ReadonlySet<ConditionedDeclaration> {
    const known = this.touched.get(witness);
    if (known) return known;
    const out = new Set<ConditionedDeclaration>();
    if (this.definitions.size > 0) {
      const { byIdentity, bySentinel } = this.definitionIndex();
      const { space } = this.input.union;
      for (const key of Object.keys(witness.assignment)) {
        const identity = space.definitionOf(key)?.identity;
        const declaration = identity === undefined ? undefined : byIdentity.get(identity);
        if (declaration) out.add(declaration);
      }
      for (const sentinel of witness.bodyForcing?.keys() ?? []) {
        const declaration = bySentinel.get(sentinel as object);
        if (declaration) out.add(declaration);
      }
    }
    this.touched.set(witness, out);
    return out;
  }

  /** `witness` with `declaration`'s body at its first values. */
  private atFirstValues(declaration: ConditionedDeclaration, witness: World): World {
    const own = new Set(this.input.templates!.dimensionsOf(declaration.manifest).map((d) => d.key));
    const assignment: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(witness.assignment)) if (!own.has(key)) assignment[key] = value;
    return witness.withAssignment(assignment);
  }

  /** Every lifted definition of the union by its identity and by each choice
   *  its body holds. */
  private definitionIndex(): {
    byIdentity: ReadonlyMap<string, ConditionedDeclaration>;
    bySentinel: ReadonlyMap<object, ConditionedDeclaration>;
  } {
    if (!this.definitionsByIdentity || !this.definitionsBySentinel) {
      const byIdentity = new Map<string, ConditionedDeclaration>();
      const bySentinel = new Map<object, ConditionedDeclaration>();
      const templates = this.input.templates!;
      for (const declaration of this.input.union.declarations) {
        if (!this.definitions.has(declaration.manifest)) continue;
        byIdentity.set(templates.readingOf(declaration.manifest).identity, declaration);
        const visit = (value: unknown): void => {
          if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
          if (isExpansionSentinel(value)) bySentinel.set(value, declaration);
          for (const field of Array.isArray(value) ? value : Object.values(value)) visit(field);
        };
        for (const field of TEMPLATE_BODY_FIELDS) visit((declaration.manifest as Record<string, unknown>)[field]);
      }
      this.definitionsByIdentity = byIdentity;
      this.definitionsBySentinel = bySentinel;
    }
    return { byIdentity: this.definitionsByIdentity, bySentinel: this.definitionsBySentinel };
  }

  /** `declaration` normalized at `witness` — a template definition's body as
   *  the witness decides it: the part already
   *  built for an equal projection whose references resolve as they do here,
   *  or a new one. */
  partAt(declaration: ConditionedDeclaration, witness: World): DeclarationPart {
    const { union } = this.input;
    const projection = union.project(declaration.manifest, witness.assignment, witness.forcing);
    const value = projection.value as ResourceManifest;
    const template = this.definitions.has(value) ? this.bodyOf(value, witness) : undefined;
    const content =
      value === declaration.manifest && projection.places.mappings.length === 0 && !projection.places.resource
        ? ""
        : stableJson([value, projection.places]);
    const key = `${template ? this.projectionIdOf(template) : ""}\0${content}`;
    let byContent = this.cache.get(declaration);
    if (!byContent) this.cache.set(declaration, (byContent = new Map()));
    const built = byContent.get(key) ?? [];
    for (const part of built) {
      if (part.fixed || (part.lookups.every((lookup) => sameOutcome(lookup.outcome, this.outcomeAt(lookup, witness))) && this.sameSlots(part.slots, witness))) {
        return part;
      }
    }
    const part = this.normalize(declaration, projection, template && { variant: template, written: value }, witness);
    built.push(part);
    byContent.set(key, built);
    reportKeyCost({
      kind: "normalization",
      declaration,
      invariant: this.input.careAt(witness).invariant.has(declaration),
      live: !witness.forcing,
      outcomes: part.lookups.map((l) => outcomeText(l.outcome)).join("\n"),
    });
    return part;
  }

  /**
   * The region of `declaration` rooted at `unionKeys`, normalized at `witness`
   * on its own — {@link regionsAt} of one root.
   */
  regionAt(declaration: ConditionedDeclaration, unionKeys: readonly (string | number)[], witness: World): RegionPart {
    return this.regionsAt(declaration, [unionKeys], witness);
  }

  /**
   * The regions of `declaration` rooted at each of `roots`, normalized at
   * `witness` together and on their own: each region's projection — a
   * template definition's from its body as the witness decides it — held in one manifest with nothing else of the declaration but
   * its `kind`, `metadata`, the way to each root, what each object on the way
   * holds beside it (shallow: what a union branch on the way is selected by)
   * and each member of the scopes declared on the way as its identity (its
   * `kind` and `metadata`; one on the way to a root is the way, one a root
   * lies in that root's), then extraction, `!ref` stamps, scope
   * members and schema type references inside them. Each place at `carved`
   * (union keys) beneath a region holds its stand-in — {@link CARVED_PLACE},
   * unless `standIn` gives one — instead of its content, whatever the witness
   * takes there. Interned like a part, by each region's written and projected
   * places and its stand-ins too. The first root is the part's own place;
   * with no root, the part holds the declaration's `kind` and `metadata` alone.
   */
  regionsAt(
    declaration: ConditionedDeclaration,
    roots: readonly (readonly (string | number)[])[],
    witness: World,
    carved: readonly (readonly (string | number)[])[] = [],
    standIn: (carve: readonly (string | number)[]) => unknown = () => CARVED_PLACE,
  ): RegionPart {
    const { union, defs, aliases, aliasesByModule } = this.input;
    const definition = this.definitions.has(declaration.manifest) ? declaration.manifest : undefined;
    const template = definition ? this.bodyOf(definition, witness) : undefined;
    // Each root, and the scopes declared on the way to it.
    const places = roots.map((unionKeys) => {
      const place = placeByUnionKeys(union, declaration, unionKeys, witness);
      if (!place.present) {
        throw new Error(`internal: a region of ${declaration.manifest.kind}/${declaration.manifest.metadata?.name} is absent where it is read.`);
      }
      return place;
    });
    const memberRegions = scopeMemberPlaces(union, declaration, places, witness, this.input.scopeFieldsOf).map((place) => {
      if (template) {
        const written = valueAtKeys(template.expansion.definition, place.at) as Record<string, unknown> | undefined;
        const content: Record<string, unknown> = {};
        for (const field of ["kind", "metadata"]) if (written?.[field] !== undefined) content[field] = written[field];
        return { place, content: content as unknown, inner: [] as PlaceMapping[] };
      }
      const identity = memberIdentity(union, place, witness);
      return { place, content: identity.value as unknown, inner: identity.mappings };
    });
    const regions = places.map((place) => {
      const beneath = carved.filter((keys) => keys.length > place.unionKeys.length && isAtOrAbove(place.unionKeys, keys));
      if (template) {
        let content = valueAtKeys(template.expansion.definition, place.at);
        for (const keys of beneath) {
          const at = placeByUnionKeys(union, declaration, keys, witness);
          if (at.present) content = replacedAt(content, at.at.slice(place.at.length), standIn(keys));
        }
        return { place, content, inner: [] as PlaceMapping[] };
      }
      const node = beneath.reduce<unknown>(
        (value, keys) => union.carve(value, [keys.slice(place.unionKeys.length)], standIn(keys)),
        place.node,
      );
      const projected = union.project(node, witness.assignment, witness.forcing);
      return { place, content: projected.value, inner: projected.places.mappings };
    });
    regions.push(...memberRegions);
    const identity = { kind: declaration.manifest.kind, metadata: declaration.manifest.metadata };
    const mappings = regionMappings(this.rootMappingsOf(declaration, witness), regions);
    const skeleton = regionSkeleton(identity, regions);
    const key = `${template ? this.projectionIdOf(template) : ""}\0${stableJson([
      regions.map((r) => [r.place.at, r.place.written, r.content, [...r.place.enclosing]]),
      mappings,
    ])}`;
    let byContent = this.regions.get(declaration);
    if (!byContent) this.regions.set(declaration, (byContent = new Map()));
    const built = byContent.get(key) ?? [];
    for (const part of built) {
      if (part.lookups.every((lookup) => sameOutcome(lookup.outcome, this.outcomeAt(lookup, witness))) && this.sameSlots(part.slots, witness)) return part;
    }
    const root = this.position.get(declaration)!;
    const nodes = countNodes(skeleton);
    const lookups: Lookup[] = [];
    const slots: SlotLookup[] = [];
    const { list, collected } = this.atWitness(witness, slots, () => {
      const list = normalizeInlineResources([skeleton], defs, aliases, aliasesByModule, (owner, entry, keys) =>
        template && definition && templateKeyOf(owner) === templateKeyOf(definition)
          ? emittedInlineName(template.expansion, ["resources", entry, ...keys])
          : undefined,
      );
      resolveRefSentinels(list, aliases, aliasesByModule, this.recordingResolution(witness, lookups), defs);
      return { list, collected: collectScopeMembers(list, (d) => defs.referenceSites(d, aliases, aliasesByModule)) };
    });
    list.forEach((m, i) => ranks.set(m, [0, i === 0 ? 0 : 1, root, i]));
    const members = collected.analysed.map((member) => member.declaration);
    members.forEach((m, i) => ranks.set(m, [1, 0, root, i]));
    const manifests = [...list, ...members];
    // A kind document is read as written: its canonical form is the registry's.
    resolveSchemaTypeRefs(manifests.filter((m) => !isKindDocument(m)), aliases, aliasesByModule, defs);
    const resource = this.rootResourceOf(declaration, witness);
    const part: RegionPart = {
      declaration,
      at: regions[0]?.place.at ?? [],
      written: regions[0]?.place.written ?? declaration.at,
      roots: regions.map((r) => ({ at: r.place.at, written: r.place.written })),
      manifests,
      raw: skeleton as ResourceManifest,
      projection: {
        present: true,
        value: list[0],
        taken: TRUE,
        places: { mappings, ...(resource ? { resource } : {}) },
      },
      nodes,
      members: collected.analysed,
      kindMembers: collected.kindDocuments,
      lookups,
      slots,
    };
    built.push(part);
    byContent.set(key, built);
    reportKeyCost({ kind: "region", declaration, nodes: regions.reduce((n, r) => n + countNodes(r.content), 0) });
    return part;
  }

  /** Whether `definition` is a template definition whose body is lifted. */
  lifted(definition: ResourceManifest): boolean {
    return this.definitions.has(definition);
  }

  /** `definition`'s body as `witness` decides it — its reading projected at the
   *  witness's assignment of the definition's own dimensions and of the
   *  configuration dimensions its body reads, one it leaves out at its first
   *  value, with the body choices it forces forced. */
  bodyOf(definition: ResourceManifest, witness: World): DefinitionProjection {
    const templates = this.input.templates!;
    const local: Record<string, unknown> = {};
    for (const dimension of templates.dimensionsOf(definition)) {
      local[dimension.definition!.key] = Object.hasOwn(witness.assignment, dimension.key)
        ? witness.assignment[dimension.key]
        : dimension.values[0];
    }
    for (const dimension of templates.configurationDimensionsOf(definition)) {
      local[dimension.key] = Object.hasOwn(witness.assignment, dimension.key)
        ? witness.assignment[dimension.key]
        : dimension.values[0];
    }
    return templates.projectionAt(definition, local, witness.bodyForcing);
  }

  /** The extent of the regions of `declaration` rooted at `roots` (union keys)
   *  at `witness`, counted from the union as written ({@link regionExtent}). */
  extentAt(declaration: ConditionedDeclaration, roots: readonly (readonly (string | number)[])[], witness: World): number {
    return regionExtent(this.input.union, declaration, roots, [], witness, this.input.scopeFieldsOf);
  }

  /** How `declaration`'s root is written: a whole document's tag moves it. */
  private rootMappingsOf(declaration: ConditionedDeclaration, witness: World): PlaceMapping[] {
    return this.rootPlaces(declaration, witness).mappings.filter((m) => m.from.length === 0);
  }

  private rootResourceOf(declaration: ConditionedDeclaration, witness: World): { kind: string; name: string } | undefined {
    return this.rootPlaces(declaration, witness).resource;
  }

  /** The place map of `declaration`'s root, the same at every witness holding
   *  it; read once. */
  private rootPlaces(declaration: ConditionedDeclaration, witness: World): PlaceMap {
    let known = this.roots.get(declaration);
    if (!known) {
      const places = this.input.union.project(declaration.manifest, witness.assignment, witness.forcing).places;
      known = { mappings: places.mappings.filter((m) => m.from.length === 0), ...(places.resource ? { resource: places.resource } : {}) };
      this.roots.set(declaration, known);
    }
    return known;
  }

  private projectionIdOf(projection: DefinitionProjection): number {
    let id = this.projectionIds.get(projection);
    if (id === undefined) this.projectionIds.set(projection, (id = this.nextProjectionId++));
    return id;
  }

  private outcomeAt(lookup: Lookup, witness: World): ResolutionOutcome {
    const { names } = this.input;
    if (lookup.locate) {
      return names.locateAt(lookup.population, lookup.name, lookup.locate.fromModule, lookup.locate.within, witness).outcome;
    }
    return names.inModuleAt(lookup.population, lookup.name, lookup.inModule!.module, lookup.inModule!.importPath, witness).outcome;
  }

  private normalize(
    declaration: ConditionedDeclaration,
    projection: Projected,
    template: TemplateVariantOf | undefined,
    witness: World,
  ): DeclarationPart {
    const { defs, aliases, aliasesByModule } = this.input;
    const root = this.position.get(declaration)!;
    const written = template ? template.variant.expansion.definition : (projection.value as ResourceManifest);
    const lookups: Lookup[] = [];
    const slots: SlotLookup[] = [];
    const { list, collected } = this.atWitness(witness, slots, () => {
      const list = normalizeInlineResources([written], defs, aliases, aliasesByModule, (definition, entry, keys) =>
        template && templateKeyOf(definition) === templateKeyOf(written) ? emittedInlineName(template.variant.expansion, ["resources", entry, ...keys]) : undefined,
      );
      resolveRefSentinels(list, aliases, aliasesByModule, this.recordingResolution(witness, lookups), defs);
      return { list, collected: collectScopeMembers(list, (d) => defs.referenceSites(d, aliases, aliasesByModule)) };
    });
    // Extraction places what it draws out breadth first, so a declaration's
    // depth below the one written orders it as the whole list's pass would.
    const depthOf = new Map<string, number>();
    list.forEach((m, i) => {
      const name = m.metadata?.name as string;
      const parent = (m.metadata as { xTeloOrigin?: { parentName?: string } } | undefined)?.xTeloOrigin?.parentName;
      const depth = i === 0 ? 0 : (depthOf.get(parent ?? "") ?? 0) + 1;
      depthOf.set(name, depth);
      ranks.set(m, [0, depth, root, i]);
    });
    const members = collected.analysed.map((member) => member.declaration);
    members.forEach((m, i) => ranks.set(m, [1, 0, root, i]));
    const manifests = [...list, ...members];
    // A kind document is read as written: its canonical form is the registry's.
    resolveSchemaTypeRefs(manifests.filter((m) => !isKindDocument(m)), aliases, aliasesByModule, defs);
    return {
      declaration,
      projection,
      manifests,
      raw: written,
      members: collected.analysed,
      kindMembers: collected.kindDocuments,
      ...(template ? { template } : {}),
      fixed: lookups.every((lookup) => lookup.fixed) && slots.length === 0,
      lookups,
      slots,
    };
  }

  /**
   * `body` with the reference reach decided at `witness`: a slot a varying
   * named shape declares — a cut point of the declaration — held where its
   * condition holds there, each decision recorded in `slots`, so a part is
   * reused only where every slot it read is decided alike.
   */
  private atWitness<T>(witness: World, slots: SlotLookup[], body: () => T): T {
    const { varying, defs, union } = this.input;
    if (!varying) return body();
    const seen = new Map<Condition, boolean>();
    const holds = (condition: Condition): boolean => {
      if (condition === TRUE) return true;
      const known = seen.get(condition);
      if (known !== undefined) return known;
      const held = union.space.holds(condition, witness.assignment);
      seen.set(condition, held);
      slots.push({ condition, held });
      return held;
    };
    return defs.withDecidedReach(varying, holds, body, holds);
  }

  /** Whether every slot `slots` recorded is decided at `witness` as it was. */
  private sameSlots(slots: readonly SlotLookup[], witness: World): boolean {
    const { space } = this.input.union;
    return slots.every((slot) => space.holds(slot.condition, witness.assignment) === slot.held);
  }

  /** The resolution `!ref` stamps are taken from at `witness`, recording each
   *  lookup and whether its outcome is the same at every witness. */
  private recordingResolution(witness: World, lookups: Lookup[]): RefResolution {
    const { names } = this.input;
    const population = (p: NamePopulation): NameResolution => ({
      locate: (name, fromModule, within, accept) => {
        const { outcome } = names.locateAt(p, name, fromModule, within, witness);
        lookups.push({ population: p, name, locate: { fromModule, within }, outcome, fixed: names.locateFixed(p, name, within) });
        return accept && outcome.status !== "unresolved" && !accept(outcome.declaration) ? UNRESOLVED : outcome;
      },
      inModule: (name, module, importPath) => {
        const { outcome } = names.inModuleAt(p, name, module, importPath, witness);
        lookups.push({ population: p, name, inModule: { module, importPath }, outcome, fixed: names.inModuleFixed(p, name, module) });
        return outcome;
      },
      declareScope: () => {},
    });
    return { local: population("local"), exported: population("exported"), declared: population("declared") };
  }
}

/** `root` with the value at `keys` replaced by `value`, copied along the way. */
function replacedAt(root: unknown, keys: readonly (string | number)[], value: unknown): unknown {
  if (keys.length === 0) return value;
  if (root === null || typeof root !== "object") return root;
  const copy = (Array.isArray(root) ? [...root] : { ...root }) as Record<string | number, unknown>;
  const [key, ...rest] = keys;
  if (copy[key as string] === undefined) return root;
  copy[key as string] = replacedAt(copy[key as string], rest, value);
  return copy;
}

function outcomeText(outcome: ResolutionOutcome): string {
  return outcome.status === "unresolved" ? "unresolved" : `${outcome.status}:${outcome.address.key}`;
}
