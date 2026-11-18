/**
 * `x-telo-sensitive` / `x-telo-span-attribute` reach over every configuration
 * at once: each declaration holding a contract is read once per distinct
 * normalization, beside the named shapes its contracts reach, and each mark
 * once per distinct normalization of its own declaration — never once per
 * configuration.
 *
 * A contract's walk holds where its declaration normalizes as it did and
 * every named shape it looked up resolves as it did; a mark reached by none
 * is reported where its declaration holds it and no contract reaching it
 * does. A mark is told apart across readings by the place it is written at.
 * A lifted template body is read per unit, its readings held where the units
 * they read hold as there: what a contract in it reaches outside its own
 * definition is reached where some value the definition can be given makes
 * it, and what is found in it is a finding of the body, as written. Every
 * other finding is held in the raw form a configuration run's own would
 * take, so the union world places it as a run places the rest.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import { reportKeyCost } from "./cel-site-judgements.js";
import { relocatePath } from "./choice-expansion.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import {
  isAlternatives,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  World,
} from "./conditioned-expansion.js";
import {
  contractSites,
  isExportedShape,
  markedNodes,
  namedShapeResolver,
  writtenNodeIndex,
  type KindCapability,
  type WrittenAt,
} from "./contract-mark-reach.js";
import { listRequests, type DeclarationRequests } from "./declaration-requests.js";
import { sensitivePaths } from "./invocation-contract.js";
import { analysisOrder, type DeclarationPart, type KeyParts, type RegionPart, type TemplateVariantOf } from "./key-parts.js";
import { isKindDocument } from "./kind-declaration.js";
import { placeByUnionKeys } from "./region-part.js";
import { isAtOrAbove } from "./relation-sites.js";
import { SCHEMA_REGION_KEYS } from "./schema-region.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { placedInPart, rawInPart } from "./lifted-body-findings.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";
import { parseKeys, pathText, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import { deadFindings, type PassBodyFinding, type PassTable, type ReadFinding } from "./union-passes.js";
import type { DeadBranchRun } from "./world-reader.js";
import { Placement } from "./placement.js";
import { syntheticOrigins } from "./rewrite-synthetic-origins.js";
import { ScopeMembers } from "./scope-members.js";
import { X_TELO_SPAN_ATTRIBUTE } from "./span-attribute.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import {
  SENSITIVE_ANNOTATION,
  sensitiveMarkIssue,
  sensitiveNeedFields,
  type SensitiveSlotIssue,
} from "./validate-sensitive-slots.js";
import {
  spanContractIssues,
  spanIssueKey,
  spanIssueReporter,
  spanMarkIssues,
  type SpanAttributeIssue,
} from "./validate-span-attributes.js";

const SOURCE = "telo-analyzer";
const CONTRACT_KEYS = new Set(["inputType", "outputType"]);

export interface MarkReachInputs {
  readonly union: ConditionedExpansion;
  readonly parts: KeyParts;
  readonly names: ConditionedNameIndex;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly rootModules: ReadonlySet<string>;
  /** Each lifted definition's body units. */
  readonly bodyUnits: ReadonlyMap<ResourceManifest, readonly TemplateBodyUnit[]>;
  readonly capabilityOf: KindCapability;
  readonly isNamedShape: (m: ResourceManifest) => boolean;
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** One finding held where `condition` does — or a lifted body's finding —
 *  at its place in the order a run reports it. */
interface Entry {
  readonly diagnostic: AnalysisDiagnostic;
  readonly condition: Condition;
  readonly order: Order;
  /** What tells a span-attribute issue from another: one is reported once. */
  readonly key?: string;
  readonly body?: number;
}

/** Where a finding stands among a run's: its declaration, then its place
 *  among what that declaration produces — what its own manifest finds, in
 *  written order, then what extraction drew out of it, then its scope members. */
interface Order {
  readonly view: number | undefined;
  readonly declaration: number;
  readonly index: readonly number[];
}

function compareOrder(a: Order, b: Order): number {
  // A run lists its forward views after every other declaration.
  if ((a.view === undefined) !== (b.view === undefined)) return a.view === undefined ? -1 : 1;
  if (a.view !== undefined && a.view !== b.view) return a.view - b.view!;
  if (a.declaration !== b.declaration) return a.declaration - b.declaration;
  for (let i = 0; i < Math.max(a.index.length, b.index.length); i++) {
    const x = a.index[i] ?? -1;
    const y = b.index[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

type Keys = readonly (string | number)[];

/** One region of a declaration the passes read on its own, by union keys: a
 *  contract, or the schema region holding marks. */
interface Root {
  readonly keys: Keys;
  contracts: boolean;
  marks: boolean;
}

/**
 * The regions of `manifest` (a union value) the passes read, in written
 * order: each `inputType` / `outputType` outside every schema region — where
 * `contractSites` finds a contract — and, for `marks`, the region holding each
 * mark: the outermost schema region above it, else its top-level field. A
 * region beneath another is the other's.
 */
function rootsOf(manifest: unknown, marks: boolean): Root[] {
  const found = new Map<string, Root>();
  const add = (keys: Keys, flag: "contracts" | "marks") => {
    const text = JSON.stringify(keys);
    let root = found.get(text);
    if (!root) found.set(text, (root = { keys, contracts: false, marks: false }));
    root[flag] = true;
  };
  const visit = (value: unknown, keys: Keys, region: Keys | undefined, top: Keys | undefined, seen: Set<object>): void => {
    if (isAlternatives(value)) {
      for (const option of value.options) visit(option.value, keys, region, top, seen);
      return;
    }
    if (value === null || typeof value !== "object" || isRefSentinel(value) || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...keys, i], region, top, seen));
    } else {
      if (marks && (Object.hasOwn(value, SENSITIVE_ANNOTATION) || Object.hasOwn(value, X_TELO_SPAN_ATTRIBUTE))) {
        add(region ?? top ?? [], "marks");
      }
      for (const [key, child] of Object.entries(value)) {
        const at = [...keys, key];
        const schemaKey = SCHEMA_REGION_KEYS.includes(key);
        if (!region && CONTRACT_KEYS.has(key)) add(at, "contracts");
        visit(child, at, region ?? (schemaKey ? at : undefined), top ?? at, seen);
      }
    }
    seen.delete(value);
  };
  visit(manifest, [], undefined, undefined, new Set());
  const all = [...found.values()];
  const held = all.filter((root) => !all.some((other) => other !== root && other.keys.length < root.keys.length && isAtOrAbove(other.keys, root.keys)));
  for (const root of all) {
    if (held.includes(root)) continue;
    const holder = held.find((other) => isAtOrAbove(other.keys, root.keys))!;
    holder.contracts ||= root.contracts;
    holder.marks ||= root.marks;
  }
  return held;
}

/** The raw diagnostic of an issue at `manifest`/`path`, as a run builds it. */
function issueDiagnostic(issue: SensitiveSlotIssue | SpanAttributeIssue): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    code: issue.code,
    source: SOURCE,
    message: issue.message,
    data: {
      resource: { kind: issue.manifest.kind, name: issue.manifest.metadata?.name as string },
      filePath: (issue.manifest.metadata as { source?: string } | undefined)?.source,
      path: issue.path,
    },
  };
}

/** Entries in a run's order over every configuration, each where it holds: a
 *  span-attribute issue is reported once, by the first entry saying it. */
function settledOver(space: ConditionSpace, entries: readonly Entry[]): ReadFinding[] {
  const said = new Map<string, Condition>();
  const out: ReadFinding[] = [];
  for (const entry of entries) {
    // A lifted body's finding is emitted with the body's.
    if (entry.body !== undefined) continue;
    let held = entry.condition;
    if (entry.key !== undefined) {
      const before = said.get(entry.key) ?? FALSE;
      said.set(entry.key, space.or(before, held));
      held = space.and(held, space.not(before));
    }
    if (held !== FALSE) out.push({ held, render: () => [entry.diagnostic] });
  }
  return out;
}

/** Entries in a run's order, a span-attribute issue reported once. */
function settle(entries: readonly Entry[]): AnalysisDiagnostic[] {
  const seen = new Set<string>();
  const out: AnalysisDiagnostic[] = [];
  for (const entry of entries) {
    // A lifted body's finding is emitted outside every run.
    if (entry.body !== undefined) continue;
    if (entry.key !== undefined) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
    }
    out.push(entry.diagnostic);
  }
  return out;
}

interface Unit {
  readonly declaration: ConditionedDeclaration;
  /** Its place among the union's forward views, for one. */
  readonly view: number | undefined;
  /** Its declaration's place in the union. */
  readonly position: number;
  /** The region it reads, and that region's place among its declaration's. */
  readonly root: Keys;
  readonly order: number;
  readonly contracts: boolean;
  readonly marks: boolean;
  /** For a region of a lifted template body, its definition and the body
   *  units it overlaps. */
  readonly lifted?: { readonly definition: ResourceManifest; readonly units: readonly TemplateBodyUnit[] };
}

/** A unit's reading at one witness: its region, and the condition under which
 *  every configuration reads it alike. */
interface Reading {
  readonly part: RegionPart;
  readonly condition: Condition;
}

/** Any normalization the passes read a node of. */
type ReadPart = DeclarationPart | RegionPart;

export function markReachFindings(inputs: MarkReachInputs): PassTable {
  const { union, parts, names, universe, rootModules, capabilityOf, isNamedShape } = inputs;
  const { space } = union;
  const views = new Map(union.views.map((view, i) => [view as ConditionedDeclaration, i]));
  const units: Unit[] = [];
  [...union.declarations, ...union.views].forEach((declaration, position) => {
    const body = views.has(declaration) || !parts.lifted(declaration.manifest) ? undefined : inputs.bodyUnits.get(declaration.manifest);
    // A region of a lifted body holding several of its units is read unit by unit.
    const roots = rootsOf(declaration.manifest, !views.has(declaration)).flatMap((root) => {
      const under = (body ?? []).filter((unit) => unit.keys.length > root.keys.length && isAtOrAbove(root.keys, unit.keys));
      return under.length === 0 ? [root] : under.map((unit) => ({ ...root, keys: unit.keys }));
    });
    // What a run's forward view holds is what its consumer and its body wrote,
    // where a run finds each mark first.
    roots.forEach((root, order) => {
      const overlapping = (body ?? []).filter((unit) => isAtOrAbove(unit.keys, root.keys) || isAtOrAbove(root.keys, unit.keys));
      units.push({
        declaration,
        view: views.get(declaration),
        position,
        root: root.keys,
        order,
        contracts: root.contracts,
        marks: root.marks,
        ...(overlapping.length > 0 && TEMPLATE_BODY_FIELDS.includes(String(root.keys[0])) ? { lifted: { definition: declaration.manifest, units: overlapping } } : {}),
      });
    });
  });
  if (!units.some((unit) => unit.marks)) return { found: [], dead: [] };

  const shapes = union.declarations.filter((d) => isNamedShape(d.manifest));
  const kindDocuments = union.declarations.filter((d) => isKindDocument(d.manifest)).map((d) => d.manifest);
  const libraries = union.declarations.map((d) => d.manifest).filter((m) => m.kind === "Telo.Library");
  const exported = (manifest: ResourceManifest) => isExportedShape(manifest, libraries);

  /** The condition under which every reference `part` stamped resolves as at
   *  `witness`. */
  const lookupsAt = (part: ReadPart, witness: World): Condition => {
    let condition = TRUE;
    for (const lookup of part.lookups) {
      const held = lookup.locate
        ? names.locateAt(lookup.population, lookup.name, lookup.locate.fromModule, lookup.locate.within, witness)
        : names.inModuleAt(lookup.population, lookup.name, lookup.inModule!.module, lookup.inModule!.importPath, witness);
      condition = space.and(condition, held.condition);
    }
    return condition;
  };

  /** The condition under which `declaration` normalizes at every configuration
   *  as at `witness`: a named shape, read whole. */
  const classOf = (declaration: ConditionedDeclaration, part: DeclarationPart, witness: World): Condition =>
    space.and(space.and(declaration.condition, union.project(declaration.manifest, witness.assignment).taken), lookupsAt(part, witness));

  /** Each named shape present at `witness`, normalized, with the condition
   *  under which each name resolves among them as it does there. */
  const worlds = new WeakMap<World, { manifests: ResourceManifest[]; partOf: Map<ResourceManifest, ReadPart>; nameClass: (name: string) => Condition }>();
  const worldAt = (witness: World) => {
    const known = worlds.get(witness);
    if (known) return known;
    const partOf = new Map<ResourceManifest, ReadPart>();
    const present = new Map<ConditionedDeclaration, DeclarationPart>();
    for (const shape of shapes) {
      if (!parts.presentAt(shape, witness)) continue;
      const part = parts.partAt(shape, witness);
      present.set(shape, part);
      for (const m of part.manifests) partOf.set(m, part);
    }
    const byName = new Map<string, Condition>();
    const nameClass = (name: string): Condition => {
      let condition = byName.get(name);
      if (condition !== undefined) return condition;
      condition = TRUE;
      for (const shape of shapes) {
        if (shape.manifest.metadata?.name !== name) continue;
        const part = present.get(shape);
        condition = space.and(condition, part ? classOf(shape, part, witness) : space.not(shape.condition));
      }
      byName.set(name, condition);
      return condition;
    };
    const world = { manifests: [...partOf.keys()].sort(analysisOrder), partOf, nameClass };
    worlds.set(witness, world);
    return world;
  };

  /** Requests over `manifests`, recording every name looked up. */
  const recording = (manifests: ResourceManifest[]): { requests: DeclarationRequests; looked: Set<string> } => {
    const base = listRequests(manifests);
    const looked = new Set<string>();
    const names = new Proxy(base.names, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") looked.add(args[0]);
          return member.apply(target, args);
        };
      },
    });
    const requests: DeclarationRequests = {
      names,
      kindDocuments: () => base.kindDocuments(),
      moduleDocuments: () => base.moduleDocuments(),
      published: () => base.published(),
      callables: () => base.callables(),
      catchScope: () => base.catchScope(),
      referrersOf: (m) => base.referrersOf(m),
    };
    return { requests, looked };
  };

  /** A unit's region and its world's manifests, the unit's own declaration in
   *  place of its shape's. */
  const worldWith = (part: RegionPart, witness: World) => {
    const world = worldAt(witness);
    const own = new Set(part.manifests);
    const normalized = [...world.manifests.filter((m) => world.partOf.get(m)?.declaration !== part.declaration), ...own].sort(analysisOrder);
    const partOf = new Map(world.partOf);
    for (const m of own) partOf.set(m, part);
    return { world, manifests: [...kindDocuments, ...normalized], normalized, partOf };
  };

  /** The body `part` holds as `witness` decides it, for a template definition. */
  const templateOf = (part: ReadPart, witness: World): TemplateVariantOf | undefined => {
    if ("template" in part) return part.template;
    const definition = part.declaration.manifest;
    return parts.lifted(definition) ? { variant: parts.bodyOf(definition, witness), written: definition } : undefined;
  };

  /** Whether `path` of the definition `part` holds, as `witness` decides its
   *  body, is written inside a lifted unit's region. */
  const inUnit = (unit: Unit, part: ReadPart, manifest: ResourceManifest, path: Keys, witness: World): boolean => {
    if (!unit.lifted) return true;
    if (manifest !== part.manifests[0]) return false;
    const template = templateOf(part, witness);
    const written = template ? parseKeys(template.variant.expansion.relocate(pathText(path))) : path;
    return isAtOrAbove(unit.root, written);
  };

  /** Where a node of `part`, at `at`, is written: the same written place
   *  whichever reading holds it. */
  const writtenIdOf = (part: ReadPart, at: WrittenAt, witness: World): string => {
    let probe: AnalysisDiagnostic = {
      severity: DiagnosticSeverity.Hint,
      code: "",
      source: SOURCE,
      message: "",
      data: {
        resource: { kind: at.manifest.kind, name: at.manifest.metadata?.name as string },
        filePath: (at.manifest.metadata as { source?: string } | undefined)?.source,
        path: at.path.join("."),
      },
    };
    [probe] = new Placement({
      scopeMembers: new ScopeMembers([...part.members, ...part.kindMembers]),
      origins: syntheticOrigins(part.manifests),
    }).place([probe]);
    let path = String((probe.data as { path?: unknown }).path ?? "");
    const template = templateOf(part, witness);
    if (template) path = template.variant.expansion.relocate(path);
    const moved = relocatePath(path, part.projection.places.mappings);
    const view = views.get(part.declaration);
    // A view's own place no mapping moves is the view's, never its consumer's.
    if (view !== undefined && moved === path && !part.projection.places.mappings.some((m) => m.from.length === 0)) {
      return JSON.stringify(["view", view, path]);
    }
    const holder = part.declaration.holder;
    const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
    return JSON.stringify([holder.kind, meta?.name, meta?.source, moved]);
  };

  /** `found` moved off a scope member of `part`, or off what extraction drew
   *  out of it, onto its place: the place a run gives it, whatever the
   *  reading's own members and extractions are named. */
  const raw = (part: ReadPart | undefined, found: AnalysisDiagnostic): AnalysisDiagnostic => (part ? rawInPart(part, [found])[0]! : found);

  /** Where what `manifest` of a unit's region finds stands among its
   *  declaration's findings: the region's own manifest in written order, then
   *  what extraction drew out of it, then its scope members. */
  const orderOf = (unit: Unit, part: RegionPart, manifest: ResourceManifest, index: readonly number[]): Order => {
    const at = part.manifests.indexOf(manifest);
    const member = part.members.some((m) => m.declaration === manifest);
    const section = at <= 0 ? [0, unit.order] : member ? [2, unit.order, at] : [1, unit.order, at];
    return { view: unit.view, declaration: unit.position, index: [...section, ...index] };
  };

  /** What a unit's contract reaches at `witness`, and the issues the walks
   *  find there. */
  const contractsAt = (unit: Unit, part: RegionPart, witness: World) => {
    const { world, manifests, normalized, partOf } = worldWith(part, witness);
    const { requests, looked } = recording(manifests);
    const resolveRef = namedShapeResolver(requests);
    let index: Map<object, WrittenAt> | undefined;
    const locate = (node: object) => (index ??= writtenNodeIndex(normalized)).get(node);
    const sensitive = new Set<string>();
    const span = new Set<string>();
    const problems: { diagnostic: AnalysisDiagnostic; key: string; order: Order }[] = [];
    const idOfNode = (node: object): string | undefined => {
      const at = locate(node);
      const owner = at && partOf.get(at.manifest);
      return at && owner ? writtenIdOf(owner, at, witness) : undefined;
    };
    const siteIndex = new Map<ResourceManifest, number>();
    const own = part.manifests[0];
    // What the region's own manifest holds beside its region is no contract of it.
    const sites = contractSites(part.manifests, requests).filter((site) =>
      unit.lifted ? inUnit(unit, part, site.manifest, site.path, witness) : site.manifest !== own || isAtOrAbove(part.at, site.path),
    );
    for (const site of sites) {
      const position = siteIndex.get(site.manifest) ?? 0;
      siteIndex.set(site.manifest, position + 1);
      const reached = new Set<object>();
      sensitivePaths(site.schema, resolveRef, reached);
      for (const node of reached) {
        const id = idOfNode(node);
        if (id) sensitive.add(id);
      }
      let problem = 0;
      const report = spanIssueReporter(rootModules, (issue) => {
        const owner = partOf.get(issue.manifest);
        problems.push({
          diagnostic: raw(owner, issueDiagnostic(issue)),
          key: spanIssueKey(issue),
          order: orderOf(unit, part, site.manifest, [position, problem++]),
        });
      });
      for (const node of spanContractIssues(site, resolveRef, locate, report)) {
        const id = idOfNode(node);
        if (id) span.add(id);
      }
    }
    let condition = TRUE;
    for (const name of looked) condition = space.and(condition, world.nameClass(name));
    return { sensitive, span, problems, condition };
  };

  /** A unit's marks at `witness`: each issue, and the reach it turns on. */
  const marksAt = (unit: Unit, part: RegionPart, witness: World) => {
    const { world, manifests } = worldWith(part, witness);
    const { requests, looked } = recording(manifests);
    const resolveRef = namedShapeResolver(requests);
    const out: { diagnostic: AnalysisDiagnostic; family: "sensitive" | "span"; id: string; unreached: boolean; key?: string; order: Order }[] = [];
    const needFields = sensitiveNeedFields(part.manifests);
    const ctx = { rootModules, capabilityOf, needFields, exported };
    const indexed = (annotation: string) => {
      const counters = new Map<ResourceManifest, number>();
      return [...markedNodes(part.manifests, annotation)].filter(([, written]) => inUnit(unit, part, written.manifest, written.path, witness)).map(([node, written]) => {
        const index = counters.get(written.manifest) ?? 0;
        counters.set(written.manifest, index + 1);
        return { node, written, index };
      });
    };
    for (const { node, written, index } of indexed(SENSITIVE_ANNOTATION)) {
      const id = writtenIdOf(part, written, witness);
      const reachedIssue = sensitiveMarkIssue(node, written, true, ctx);
      const unreachedIssue = sensitiveMarkIssue(node, written, false, ctx);
      const order = orderOf(unit, part, written.manifest, [index]);
      if (reachedIssue) {
        out.push({ diagnostic: raw(part, issueDiagnostic(reachedIssue)), family: "sensitive", id, unreached: false, order });
      } else if (unreachedIssue) {
        out.push({ diagnostic: raw(part, issueDiagnostic(unreachedIssue)), family: "sensitive", id, unreached: true, order });
      }
    }
    for (const { node, written, index } of indexed(X_TELO_SPAN_ATTRIBUTE)) {
      const id = writtenIdOf(part, written, witness);
      let issue = 0;
      const report = spanIssueReporter(rootModules, (found) =>
        out.push({
          diagnostic: raw(part, issueDiagnostic(found)),
          family: "span",
          id,
          unreached: true,
          key: spanIssueKey(found),
          order: orderOf(unit, part, written.manifest, [index, issue++]),
        }),
      );
      spanMarkIssues(node, written, capabilityOf, exported, resolveRef, report);
    }
    let condition = TRUE;
    for (const name of looked) condition = space.and(condition, world.nameClass(name));
    return { issues: out, condition };
  };

  /** A lifted definition read whole at `witness`, as a region of it. */
  const wholeAt = (declaration: ConditionedDeclaration, witness: World): RegionPart => {
    const part = parts.partAt(declaration, witness);
    return { ...part, at: [], written: [], roots: [{ at: [], written: [] }], nodes: 0 } as unknown as RegionPart;
  };

  /** A unit's region at `witness`, where it is there, and the condition under
   *  which every configuration holds it alike — what lies outside it aside. */
  const regionAt = (unit: Unit, witness: World): { part?: RegionPart; condition: Condition } => {
    const place = placeByUnionKeys(union, unit.declaration, unit.root, witness);
    if (!place.present) return { condition: place.path };
    const part = unit.lifted ? wholeAt(unit.declaration, witness) : parts.regionAt(unit.declaration, unit.root, witness);
    const taken = union.project(place.node, witness.assignment, witness.forcing).taken;
    // A lifted body's region holds where the body units it overlaps hold as here.
    const body = (unit.lifted?.units ?? []).reduce(
      (held, each) => space.and(held, each.classAt(witness, witness.bodyForcing !== undefined).condition),
      TRUE as Condition,
    );
    return { part, condition: space.and(space.and(space.and(place.path, space.and(place.position, taken)), lookupsAt(part, witness)), body) };
  };

  /** Each reading of `unit` over the configurations kept, with the condition
   *  each holds under. */
  const readings = (unit: Unit, read: (reading: Reading, witness: World) => Condition): void => {
    let remaining = space.and(unit.declaration.condition, universe);
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      const region = regionAt(unit, witness);
      reportKeyCost({ kind: "pass-reading", pass: "markReach", declaration: unit.declaration });
      const condition = region.part ? read({ part: region.part, condition: region.condition }, witness) : region.condition;
      if (!space.holds(condition, witness.assignment)) {
        throw new Error(`internal: a mark reading of ${unit.declaration.manifest.kind}/${unit.declaration.manifest.metadata?.name} does not hold where it was read.`);
      }
      remaining = space.and(remaining, space.not(condition));
    }
  };

  // What each contract reaches, by the declaration holding it: a lifted
  // body's reach is its definition's own beside its body, and existential
  // outside it.
  const reachedSensitive = new Map<string, Map<ConditionedDeclaration, Condition>>();
  const reachedSpan = new Map<string, Map<ConditionedDeclaration, Condition>>();
  const reach = (into: typeof reachedSensitive, ids: Iterable<string>, from: ConditionedDeclaration, condition: Condition) => {
    for (const id of ids) {
      let by = into.get(id);
      if (!by) into.set(id, (by = new Map()));
      by.set(from, space.or(by.get(from) ?? FALSE, condition));
    }
  };
  const reachedAt = (from: typeof reachedSensitive, id: string, at: ConditionedDeclaration): Condition => {
    let out = FALSE as Condition;
    for (const [declaration, condition] of from.get(id) ?? []) {
      out = space.or(out, declaration === at ? condition : space.existsDefinitions(condition));
    }
    return out;
  };
  // A lifted body's findings, as written, by what they say.
  const bodyFound = new Map<string, { diagnostic: AnalysisDiagnostic; definition: ResourceManifest; live?: Condition; configuration: Condition; dead?: { sentinel: object; branch: string }; order: Order; family: 0 | 1 | 2; key?: string }>();
  const aboutDefinition = (diagnostic: AnalysisDiagnostic, definition: ResourceManifest): boolean => {
    const data = diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown } | undefined;
    const meta = definition.metadata as { name?: unknown; source?: unknown } | undefined;
    return data?.resource?.kind === definition.kind && data.resource.name === meta?.name && data.filePath === meta?.source;
  };
  const inBody = (
    unit: Unit,
    part: RegionPart,
    witness: World,
    found: { diagnostic: AnalysisDiagnostic; order: Order; key?: string },
    family: 0 | 1 | 2,
    held: Condition,
    dead?: { sentinel: object; branch: string; path: string },
  ): boolean => {
    const definition = unit.lifted?.definition;
    if (!definition || !aboutDefinition(found.diagnostic, definition)) return false;
    const [diagnostic] = placedInPart(part, [found.diagnostic], templateOf(part, witness));
    const path = String((diagnostic!.data as { path?: unknown } | undefined)?.path ?? "");
    if (dead && !(path === dead.path || path.startsWith(`${dead.path}.`) || path.startsWith(`${dead.path}[`))) return true;
    const data = diagnostic!.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown } | undefined;
    const id = JSON.stringify([dead ? "dead" : "live", diagnostic!.code, data?.resource?.name, data?.filePath, path, diagnostic!.message]);
    const known = bodyFound.get(id);
    const configuration = space.existsDefinitions(held);
    if (known) {
      if (!dead) known.live = space.or(known.live!, held);
      known.configuration = space.or(known.configuration, configuration);
      return true;
    }
    bodyFound.set(id, {
      diagnostic: diagnostic!,
      definition,
      ...(dead ? { dead: { sentinel: dead.sentinel, branch: dead.branch } } : { live: held }),
      configuration,
      order: found.order,
      family,
      ...(found.key !== undefined ? { key: found.key } : {}),
    });
    return true;
  };
  const problems: Entry[] = [];
  for (const unit of units) {
    if (!unit.contracts) continue;
    readings(unit, (reading, witness) => {
      const found = contractsAt(unit, reading.part, witness);
      const condition = space.and(reading.condition, found.condition);
      reach(reachedSensitive, found.sensitive, unit.declaration, condition);
      reach(reachedSpan, found.span, unit.declaration, condition);
      for (const problem of found.problems) {
        if (inBody(unit, reading.part, witness, problem, 1, condition)) continue;
        problems.push({ diagnostic: problem.diagnostic, condition: space.existsDefinitions(condition), order: problem.order, key: problem.key });
      }
      return condition;
    });
  }
  const sensitive: Entry[] = [];
  const span: Entry[] = [];
  for (const unit of units) {
    if (!unit.marks) continue;
    readings(unit, (reading, witness) => {
      const found = marksAt(unit, reading.part, witness);
      const condition = space.and(reading.condition, found.condition);
      for (const issue of found.issues) {
        const reached = reachedAt(issue.family === "sensitive" ? reachedSensitive : reachedSpan, issue.id, unit.declaration);
        const holds = issue.unreached ? space.and(condition, space.not(reached)) : condition;
        if (holds === FALSE) continue;
        if (inBody(unit, reading.part, witness, issue, issue.family === "sensitive" ? 0 : 2, holds)) continue;
        (issue.family === "sensitive" ? sensitive : span).push({
          diagnostic: issue.diagnostic,
          condition: space.existsDefinitions(holds),
          order: issue.order,
          ...(issue.key !== undefined ? { key: issue.key } : {}),
        });
      }
      return condition;
    });
  }
  // A branch of a lifted body no value the definition can be given takes: read
  // at its baseline, forced, keeping what is found beneath it.
  for (const unit of units) {
    for (const body of unit.lifted?.units ?? []) {
      for (const branch of body.dead) {
        const under = branch.path;
        const keys = parseKeys(under);
        if (!isAtOrAbove(unit.root, keys) && !isAtOrAbove(keys, unit.root)) continue;
        const first = space.firstAssignment(space.and(unit.declaration.condition, universe));
        if (!first) continue;
        const witness: World = branch.world.asBody(first);
        const region = regionAt(unit, witness);
        if (!region.part) continue;
        const configuration = space.and(space.and(unit.declaration.condition, universe), lookupsAt(region.part, witness));
        const dead = { sentinel: branch.sentinel, branch: branch.branch, path: under };
        if (unit.contracts) {
          for (const problem of contractsAt(unit, region.part, witness).problems) inBody(unit, region.part, witness, problem, 1, configuration, dead);
        }
        if (unit.marks) {
          const ids = { sensitive: new Set<string>(), span: new Set<string>() };
          for (const other of units) {
            if (other.declaration !== unit.declaration || !other.contracts) continue;
            const at = regionAt(other, witness).part;
            if (!at) continue;
            const read = contractsAt(other, at, witness);
            for (const id of read.sensitive) ids.sensitive.add(id);
            for (const id of read.span) ids.span.add(id);
          }
          for (const issue of marksAt(unit, region.part, witness).issues) {
            const family = issue.family === "sensitive" ? reachedSensitive : reachedSpan;
            if (issue.unreached && (ids[issue.family].has(issue.id) || reachedAt(family, issue.id, unit.declaration) !== FALSE)) continue;
            inBody(unit, region.part, witness, issue, issue.family === "sensitive" ? 0 : 2, configuration, dead);
          }
        }
      }
    }
  }
  const body: PassBodyFinding[] = [];
  const families: Entry[][] = [sensitive, problems, span];
  for (const found of bodyFound.values()) {
    const index = body.push({
      diagnostic: found.diagnostic,
      definition: found.definition,
      ...(found.live !== undefined ? { live: found.live } : {}),
      ...(found.dead ? { dead: found.dead } : {}),
      configuration: found.configuration,
    }) - 1;
    families[found.family]!.push({ diagnostic: found.diagnostic, condition: found.configuration, order: found.order, body: index });
  }
  const byOrder = (a: Entry, b: Entry) => compareOrder(a.order, b.order);
  const entries: Entry[] = [...sensitive.sort(byOrder), ...problems.sort(byOrder), ...span.sort(byOrder)];
  reportKeyCost({ kind: "pass-table", pass: "markReach", entries: entries.length });

  // Each branch no configuration takes: read once, at its baseline with its forcing.
  const dead = (option: DeadBranchRun): readonly AnalysisDiagnostic[] => {
    const witness: World = option.world;
    const present = units
      .filter((unit) => parts.presentAt(unit.declaration, witness))
      .map((unit) => ({ unit, part: regionAt(unit, witness).part }))
      .filter((each): each is { unit: Unit; part: RegionPart } => each.part !== undefined);
    const sensitiveIds = new Set<string>();
    const spanIds = new Set<string>();
    const found: Entry[] = [];
    const problems: Entry[] = [];
    for (const { unit, part } of present) {
      if (!unit.contracts) continue;
      const read = contractsAt(unit, part, witness);
      for (const id of read.sensitive) sensitiveIds.add(id);
      for (const id of read.span) spanIds.add(id);
      for (const problem of read.problems) problems.push({ diagnostic: problem.diagnostic, condition: TRUE, order: problem.order, key: problem.key });
    }
    const span: Entry[] = [];
    for (const { unit, part } of present) {
      if (!unit.marks) continue;
      for (const issue of marksAt(unit, part, witness).issues) {
        if (issue.unreached && (issue.family === "sensitive" ? sensitiveIds : spanIds).has(issue.id)) continue;
        (issue.family === "sensitive" ? found : span).push({
          diagnostic: issue.diagnostic,
          condition: TRUE,
          order: issue.order,
          ...(issue.key !== undefined ? { key: issue.key } : {}),
        });
      }
    }
    const byOrder = (a: Entry, b: Entry) => compareOrder(a.order, b.order);
    return settle([...found.sort(byOrder), ...problems.sort(byOrder), ...span.sort(byOrder)]);
  };
  return {
    found: settledOver(space, entries),
    dead: deadFindings("markReach", inputs.deadBranches, dead),
    body,
  };
}
