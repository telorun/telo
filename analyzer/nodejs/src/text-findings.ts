/**
 * The text vocabulary's checks (`validate-texts.ts`) over every configuration
 * at once.
 *
 * Each declaration and forward view is read in REGIONS — each top-level field,
 * each item of a top-level list on its own, a kind document whole — merged
 * where a judgement reads
 * across two (a text and its values, a catalog or a keyed set read whole) or
 * reads the whole declaration (a kind whose whole schema is a text fragment).
 * A region is read once per distinct content: where its places, its references
 * and what its expressions were typed as hold as at the witness, and each call's
 * callee as there. So `k` independent choices in `k` regions cost `2k + 1`
 * readings, never `2^k`. A reading judges its manifests as a run judges a
 * declaration's, and holds what it finds, the texts it shows, the catalogs and
 * kinds it holds, where its class holds. A lifted template body is read whole
 * once per class of each of its units (`lifted-body-findings.ts`), keeping
 * what that unit holds: a finding in it is the body's, held over the
 * definition's own dimensions, and what it shows counts where some value the
 * definition can be given makes it.
 *
 * Coverage reads those over the application: `MESSAGE_TEXT_UNUSED` holds where
 * its catalog does and no module of the catalog's closure shows the entry;
 * `MESSAGE_TRANSLATION_MISSING`, whose wording lists what is missing, is decided
 * by coverage's own rule over conditions first, then rendered once per class of
 * the conditions its listed items hold under — as many as its wordings.
 *
 * Every finding is held in the raw form a run's own takes, ranked as a run
 * lists it. Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { resolveSignature } from "./callable-signature.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import { celSiteId } from "./cel-site-name.js";
import type { CelOccurrenceFacts, CelSiteSolution } from "./cel-site-solve.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { World, type ConditionedDeclaration, type ConditionedExpansion, type ConditionedView, type PlaceMap } from "./conditioned-expansion.js";
import { listRequests } from "./declaration-requests.js";
import type { KeyParts, RegionPart, TemplateVariantOf } from "./key-parts.js";
import { namedDependencies, placedInPart, rawInPart, underBranch, unitAt } from "./lifted-body-findings.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";
import { importTextParameters } from "./import-inputs.js";
import { isKindDocument } from "./kind-declaration.js";
import { SELF_ALIAS } from "./module-call-names.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { placeByProjectedKeys, placeByUnionKeys } from "./region-part.js";
import { isAtOrAbove } from "./relation-sites.js";
import { isResolvedReference } from "./resolved-reference.js";
import { Placement } from "./placement.js";
import { syntheticOrigins } from "./rewrite-synthetic-origins.js";
import { parseKeys, pathText, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import type { MessageValueKind } from "./text-judgement.js";
import type { TextFragment } from "./text-slot.js";
import type { CoverageLogic, TranslationLayer } from "./translation-coverage.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { deadFindings, fixedFindings, type PassBodyFinding, type PassFinding, type PassTable, type ReadFinding } from "./union-passes.js";
import { splitByReads, type DeadBranchRun } from "./world-reader.js";
import {
  bodyEntryOfWriting,
  builtinShownTexts,
  ClosureTexts,
  KindWalk,
  TextLanguageScope,
  textCoverage,
  textReader,
  unusedTextDiagnostic,
  type CatalogRead,
  type InstantiatedKind,
  type ManifestTexts,
  type TextDefResolver,
  type TextPassOptions,
} from "./validate-texts.js";

type Keys = readonly (string | number)[];
/** Where a contribution stands in the order a run meets it. */
type Rank = readonly number[];

export interface TextFindingsInputs {
  readonly union: ConditionedExpansion;
  readonly parts: KeyParts;
  readonly names: ConditionedNameIndex;
  /** The configurations kept. */
  readonly universe: Condition;
  /** Each lifted definition's body units. */
  readonly bodyUnits: ReadonlyMap<ResourceManifest, readonly TemplateBodyUnit[]>;
  /** The first configuration kept: what no choice varies is read there. */
  readonly base: World;
  readonly rootModules: ReadonlySet<string>;
  readonly resolveDef: TextDefResolver;
  /** What each kind means along `extends`. */
  readonly kinds: Pick<DefinitionRegistry, "effectiveSchemaOf">;
  /** The CEL names of each module. */
  readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  /** A named shape as `witness` holds it. */
  readonly schemaForId: (id: string, witness: World) => Record<string, any> | undefined;
  readonly accepts: TextPassOptions["accepts"];
  /** Every imported library's full documents. */
  readonly libraries: readonly ModuleDocuments[];
  /** What an expression was typed as, by its keys. */
  readonly facts: CelSiteSolution["factsAt"];
  /** What an expression's facts make it as a message's value. */
  readonly valueKindOf: (facts: CelOccurrenceFacts) => { kind: MessageValueKind; describe: string } | undefined;
  /** The definition whose body holds the entry a forward view instantiates. */
  readonly bodyWriterOf: (view: ConditionedView) => ResourceManifest | undefined;
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

function compareRank(a: Rank, b: Rank): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/** A finding, a shown text, a catalog, a kind or a listed layer: where it holds
 *  and where a run meets it. */
interface Held<T> {
  readonly value: T;
  readonly held: Condition;
  readonly rank: Rank;
  /** A lifted body's finding: the definition, and the branch no value takes
   *  it was found in. */
  readonly body?: { readonly definition: ResourceManifest; readonly dead?: { readonly sentinel: object; readonly branch: string } };
}

/** What the readings hold. */
interface VariantTexts {
  readonly findings: Held<AnalysisDiagnostic>[];
  readonly shown: Held<{ module: string; key: string; written: boolean }>[];
  readonly catalogs: Held<CatalogRead>[];
  readonly kinds: Held<InstantiatedKind>[];
  readonly listed: Held<TranslationLayer>[];
}

/** One reading of a region: where it holds, and the manifests it judged. */
interface Reading {
  readonly held: Condition;
  readonly witness: World;
  readonly part?: RegionPart;
  readonly read: readonly { readonly manifest: ResourceManifest; readonly index: number; readonly texts?: ManifestTexts }[];
  /** A place a judgement read outside the region. */
  readonly crossing?: Keys;
  /** A lifted body's: its body as the witness decides it, what each unit's
   *  facts held under, and the unit (`rest`: the definition beside every
   *  unit) — with the branch no value takes, for one read forced — whose
   *  contributions the reading keeps. */
  readonly lifted?: {
    readonly template: TemplateVariantOf;
    readonly units: readonly TemplateBodyUnit[];
    readonly byUnit: ReadonlyMap<TemplateBodyUnit, Condition>;
    readonly keeps?: TemplateBodyUnit | "rest";
    readonly dead?: TemplateBodyUnit["dead"][number];
  };
}

export function textFindings(inputs: TextFindingsInputs): PassTable {
  const { union, parts, names, universe, base, rootModules, resolveDef, libraries } = inputs;
  const { space } = union;
  const present = (d: ConditionedDeclaration) => d.condition !== FALSE && !d.unreachable;
  const all = [...union.declarations, ...union.views];
  const position = new Map(all.map((d, i) => [d, i] as const));
  const views = new Set<ConditionedDeclaration>(union.views);

  // Module documents and imports never vary outside `targets:`: read at the base.
  const fixed = union.declarations
    .filter((d) => present(d) && (isModuleKind(d.manifest.kind) || d.manifest.kind === "Telo.Import"))
    .map((d) => union.project(d.manifest, base.assignment).value as ResourceManifest);
  const scope = new TextLanguageScope(listRequests(fixed), rootModules, libraries);
  const coverage = textCoverage(resolveDef, scope);
  const closure = new ClosureTexts(fixed, scope, new Map());
  const documented = new Set(libraries.map((doc) => doc.module));

  // --- The reading in progress, which every hook records its class into. ---
  let current:
    | {
        declaration: ConditionedDeclaration;
        part: RegionPart;
        witness: World;
        template: TemplateVariantOf | undefined;
        held: Condition;
        places?: PlaceMap;
        units?: readonly TemplateBodyUnit[];
        byUnit?: Map<TemplateBodyUnit, Condition>;
      }
    | undefined;
  /** `condition` recorded into the reading — into the unit of a lifted body
   *  holding the written place `at` where there is one. */
  const record = (condition: Condition, at?: string) => {
    const r = current!;
    const unit = r.units && at !== undefined ? unitAt(r.units, at) : undefined;
    if (unit) r.byUnit!.set(unit, space.and(r.byUnit!.get(unit) ?? TRUE, condition));
    else r.held = space.and(r.held, condition);
  };

  /** Where an expression of the reading is written: its declaration's place, or
   *  a template body's site. */
  const placeOf = (manifest: ResourceManifest, path: string): { at: Parameters<CelSiteSolution["factsAt"]>[0]; written?: string } | undefined => {
    const r = current!;
    const own = r.part.manifests[0]!;
    let at = path;
    if (manifest !== own) {
      const meta = manifest.metadata as { name?: unknown; source?: unknown } | undefined;
      const [moved] = new Placement({ origins: syntheticOrigins(r.part.manifests) }).place(
        [{ severity: DiagnosticSeverity.Hint, code: "", source: "", message: "", data: { resource: { kind: manifest.kind, name: meta?.name }, filePath: meta?.source, path } }],
      );
      const data = moved!.data as { resource?: { name?: unknown }; path?: unknown };
      if (data.resource?.name !== own.metadata?.name || typeof data.path !== "string") return undefined;
      at = data.path;
    }
    const keys = parseKeys(at);
    if (r.declaration.manifest.kind === "Telo.Definition" && TEMPLATE_BODY_FIELDS.includes(String(keys[0]))) {
      const holder = r.declaration.holder;
      const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
      const written = r.template ? r.template.variant.expansion.relocate(at) : at;
      return { at: { body: celSiteId(holder.kind, meta?.name, meta?.source, written) }, written };
    }
    const place = placeByProjectedKeys(union, r.declaration, keys, r.witness);
    return place.present ? { at: { declaration: r.declaration, unionKeys: place.unionKeys } } : undefined;
  };
  const factsOf = (manifest: ResourceManifest, path: string): CelOccurrenceFacts | undefined => {
    // A library's own documents are read outside every configuration: nothing
    // it holds is judged.
    if (!current) return undefined;
    const at = placeOf(manifest, path);
    const found = at && inputs.facts(at.at, current!.witness);
    if (!found) return undefined;
    record(found.condition, at.written);
    return found.facts[found.facts.length - 1];
  };

  /** A forward view's place map at the reading's witness. */
  const viewPlaces = (manifest: ResourceManifest): { view: ConditionedView; places: PlaceMap } | undefined => {
    const r = current;
    if (!r || !views.has(r.declaration) || manifest !== r.part.manifests[0] || !(r.declaration as ConditionedView).body) return undefined;
    r.places ??= union.project(r.declaration.manifest, r.witness.assignment, r.witness.forcing).places;
    return { view: r.declaration as ConditionedView, places: r.places };
  };
  const forwarded = (places: PlaceMap, keys: Keys, either: boolean) =>
    places.mappings.some((mapping) => isAtOrAbove(mapping.from, keys) || (either && isAtOrAbove(keys, mapping.from)));

  const callees = new UnionCallees(union, libraries, scope, resolveDef, fixed);
  const reader = textReader({
    resolveDef,
    kinds: inputs.kinds,
    scope,
    moduleCallNames: inputs.moduleCallNames,
    schemaForId: (id) => inputs.schemaForId(id, current?.witness ?? base),
    accepts: inputs.accepts,
    valueKindAt: (manifest, path) => {
      const facts = factsOf(manifest, path);
      return facts ? inputs.valueKindOf(facts) : undefined;
    },
    producedSchemaAt: (manifest, path) => factsOf(manifest, path)?.produced,
    writerAt: (manifest, path) => {
      const at = viewPlaces(manifest);
      return at && !forwarded(at.places, parseKeys(path), false) ? inputs.bodyWriterOf(at.view) : undefined;
    },
    bodyWroteWhole: (manifest, path) => {
      const at = viewPlaces(manifest);
      return !!at && !forwarded(at.places, parseKeys(path), true);
    },
    importTextParameters: (importManifest) => importTextParameters(importManifest, libraries),
    paramsOf: (qualified, module) => {
      const found = callees.paramsAt(qualified, module, current?.witness ?? base);
      if (current) record(found.condition);
      return found.params;
    },
  });

  /** Where every reference `part` stamped resolves as at `witness`. */
  const lookupsAt = (part: RegionPart, witness: World): Condition => {
    let condition = TRUE;
    for (const lookup of part.lookups) {
      const held = lookup.locate
        ? names.locateAt(lookup.population, lookup.name, lookup.locate.fromModule, lookup.locate.within, witness)
        : names.inModuleAt(lookup.population, lookup.name, lookup.inModule!.module, lookup.inModule!.importPath, witness);
      condition = space.and(condition, held.condition);
    }
    return condition;
  };

  /** A lifted definition's body units, for a kind document. */
  const liftedUnits = (declaration: ConditionedDeclaration): readonly TemplateBodyUnit[] | undefined =>
    views.has(declaration) || !parts.lifted(declaration.manifest) ? undefined : inputs.bodyUnits.get(declaration.manifest);

  /** The region of `declaration` at `roots` read at `witness`. */
  const readAt = (declaration: ConditionedDeclaration, roots: readonly Keys[], witness: World): Reading => {
    let held = declaration.condition;
    const kept: Keys[] = [];
    for (const root of roots) {
      const place = placeByUnionKeys(union, declaration, root, witness);
      if (!place.present) {
        held = space.and(held, place.path);
        continue;
      }
      kept.push(root);
      const taken = union.project(place.node, witness.assignment, witness.forcing).taken;
      held = space.and(held, space.and(place.path, space.and(place.position, taken)));
    }
    if (kept.length === 0) return { held, witness, read: [] };
    const part = parts.regionsAt(declaration, kept, witness);
    reportKeyCost({ kind: "pass-reading", pass: "texts", declaration });
    const units = liftedUnits(declaration);
    const template = parts.lifted(declaration.manifest) && !views.has(declaration)
      ? { variant: parts.bodyOf(declaration.manifest, witness), written: declaration.manifest }
      : undefined;
    current = {
      declaration,
      part,
      witness,
      template,
      held: space.and(held, lookupsAt(part, witness)),
      ...(units ? { units, byUnit: new Map() } : {}),
    };
    const members = new Set<object>(part.members.map((member) => member.declaration));
    const read: { manifest: ResourceManifest; index: number; texts?: ManifestTexts }[] = [];
    part.manifests.forEach((manifest, index) => {
      if (members.has(manifest)) return;
      const module = scope.moduleOf(manifest);
      const owned = scope.isOwned(manifest);
      read.push({ manifest, index, ...(!owned && documented.has(module) ? {} : { texts: reader(manifest, module, owned) }) });
    });
    // A scoped import's text inputs are its module's, as an `imports:` entry's are.
    part.kindMembers.forEach((member, at) => {
      const manifest = member.declaration;
      if (manifest.kind !== "Telo.Import") return;
      const module = scope.moduleOf(manifest);
      const owned = scope.isOwned(manifest);
      const index = part.manifests.length + at;
      read.push({ manifest, index, ...(!owned && documented.has(module) ? {} : { texts: reader(manifest, module, owned) }) });
    });
    const own = read.find((entry) => entry.index === 0)?.texts;
    const crossing = own?.extents.find((extent) => !part.roots.some((root) => isAtOrAbove(root.at, extent)));
    const reading: Reading = {
      held: current.held,
      witness,
      part,
      read,
      ...(crossing ? { crossing } : {}),
      ...(units && template ? { lifted: { template, units, byUnit: current.byUnit! } } : {}),
    };
    current = undefined;
    return reading;
  };

  /** Each reading of `roots` over the configurations kept. */
  const readingsOf = (declaration: ConditionedDeclaration, roots: readonly Keys[]): Reading[] => {
    const out: Reading[] = [];
    let remaining = space.and(declaration.condition, universe);
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      const reading = readAt(declaration, roots, witness);
      if (!space.holds(reading.held, witness.assignment)) {
        throw new Error(`internal: a text reading of ${declaration.manifest.kind}/${declaration.manifest.metadata?.name} does not hold where it was read.`);
      }
      out.push(reading);
      if (reading.crossing) return out;
      remaining = space.and(remaining, space.not(reading.held));
    }
    return out;
  };

  /** A lifted definition's readings: the definition beside every unit, read
   *  where its own reads hold alike; then each unit, read whole once per class
   *  of the unit, the units it depends on and its own reads; then each branch
   *  of a unit no value the definition can be given takes, forced. */
  const liftedReadings = (declaration: ConditionedDeclaration, units: readonly TemplateBodyUnit[]): Reading[] => {
    const out: Reading[] = [];
    const present = space.and(declaration.condition, universe);
    const keep = (reading: Reading, held: Condition, keeps: TemplateBodyUnit | "rest", dead?: TemplateBodyUnit["dead"][number]): Reading => ({
      ...reading,
      held,
      lifted: { ...reading.lifted!, keeps, ...(dead ? { dead } : {}) },
    });
    let remaining = present;
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      const reading = readAt(declaration, [[]], witness);
      if (!space.holds(reading.held, witness.assignment)) {
        throw new Error(`internal: a text reading of ${declaration.manifest.kind}/${declaration.manifest.metadata?.name} does not hold where it was read.`);
      }
      out.push(keep(reading, reading.held, "rest"));
      remaining = space.and(remaining, space.not(reading.held));
    }
    const dependsOn = namedDependencies(units);
    const first = space.firstAssignment(present);
    for (const unit of units) {
      const reach = [unit, ...dependsOn(unit)];
      let rest = present;
      while (rest !== FALSE) {
        const witness: World = World.key(space.firstAssignment(rest)!);
        const reading = readAt(declaration, [[]], witness);
        const classes = reach.reduce((held, each) => space.and(held, each.classAt(witness, false).condition), TRUE as Condition);
        const held = space.and(space.and(reading.held, classes), reading.lifted!.byUnit.get(unit) ?? TRUE);
        if (!space.holds(held, witness.assignment)) {
          throw new Error(`internal: a text reading of a body unit of ${declaration.manifest.metadata?.name} does not hold where it was read.`);
        }
        out.push(keep(reading, held, unit));
        rest = space.and(rest, space.not(held));
      }
      for (const branch of first ? unit.dead : []) {
        const reading = readAt(declaration, [[]], branch.world.asBody(first!));
        out.push(keep(reading, reading.held, unit, branch));
      }
    }
    return out;
  };

  /** A declaration's top-level fields, a list's items each on its own. */
  const unitsOf = (declaration: ConditionedDeclaration): Keys[] => {
    const out: Keys[] = [];
    for (const [key, value] of Object.entries(declaration.manifest)) {
      if (key === "kind" || key === "metadata") continue;
      if (Array.isArray(value)) value.forEach((_, i) => out.push([key, i]));
      else out.push([key]);
    }
    return out;
  };

  /** The readings of `declaration`, its regions merged until no judgement reads
   *  outside its own: each with its region's place among the declaration's. */
  const regionReadings = (declaration: ConditionedDeclaration): { order: number; readings: Reading[] }[] => {
    const lifted = liftedUnits(declaration);
    if (lifted) return [{ order: -1, readings: liftedReadings(declaration, lifted) }];
    const units = unitsOf(declaration);
    // A kind document varies only with its template body: read whole.
    let groups: number[][] = isKindDocument(declaration.manifest) ? [[-1]] : units.map((_, i) => [i]);
    for (;;) {
      const out: { order: number; readings: Reading[] }[] = [];
      let crossed: { group: number[]; reading: Reading } | undefined;
      for (const group of groups) {
        const roots = group[0] === -1 ? [[]] : group.map((i) => units[i]!);
        const readings = readingsOf(declaration, roots);
        const last = readings[readings.length - 1];
        if (last?.crossing) {
          crossed = { group, reading: last };
          break;
        }
        out.push({ order: group[0]!, readings });
      }
      if (!crossed) return out;
      // The unit holding the place read across, merged with the region.
      const { crossing, witness } = crossed.reading;
      const target =
        crossing!.length === 0
          ? -1
          : units.findIndex((unit) => {
              const place = placeByUnionKeys(union, declaration, unit, witness);
              return place.present && isAtOrAbove(place.at, crossing!);
            });
      const into = target === -1 ? undefined : groups.find((g) => g.includes(target));
      groups =
        !into || into === crossed.group || crossed.group[0] === -1
          ? [[-1]]
          : [
              ...groups.filter((g) => g !== into && g !== crossed!.group).map((g) => g),
              [...crossed.group, ...into].sort((a, b) => a - b),
            ].sort((a, b) => a[0]! - b[0]!);
    }
  };

  /** The reading each catalog was read in. */
  const readIn = new WeakMap<object, Reading>();
  /** `found`, read in `reading`, in the raw form a run's own finding takes. */
  const inRun = (reading: Reading | undefined, found: AnalysisDiagnostic): AnalysisDiagnostic =>
    reading?.part ? rawInPart(reading.part, [found])[0]! : found;
  /** MESSAGE_TEXT_UNUSED of a catalog's entry, as a run reports it. */
  const unusedOf = (catalog: Parameters<typeof unusedTextDiagnostic>[0], index: number): AnalysisDiagnostic =>
    inRun(readIn.get(catalog), unusedTextDiagnostic(catalog, index));

  /** What `reading` holds, ranked: `order` its region's place. */
  const take = (into: VariantTexts, declaration: ConditionedDeclaration, order: number, reading: Reading) => {
    const view = views.has(declaration) ? 1 : 0;
    const at = position.get(declaration)!;
    const lifted = reading.lifted;
    if (lifted?.keeps !== undefined) return takeLifted(into, declaration, reading);
    for (const { manifest, index, texts } of reading.read) {
      // A run lists a declaration's own manifest, then what extraction drew out.
      const rankOf = (writing: readonly [number, number], seq: number): Rank =>
        index === 0 ? [view, 0, at, writing[0], writing[1], order, seq] : [view, 1, at, order, index, writing[0], writing[1], seq];
      const kinds = new KindWalk();
      const module = scope.moduleOf(manifest);
      if (index === 0 && !isKindDocument(manifest)) {
        for (const [key, child] of Object.entries(manifest)) if (key !== "kind" && !key.startsWith("x-telo-")) kinds.walk(child, module);
      } else kinds.walk(manifest, module);
      kinds.found().forEach((kind, seq) =>
        into.kinds.push({ value: kind, held: reading.held, rank: [0, ...(index === 0 ? [view, 0, at, order] : [view, 1, at, order, index]), seq] }),
      );
      if (!texts) continue;
      texts.findings.forEach((f, seq) => into.findings.push({ value: inRun(reading, f.diagnostic), held: reading.held, rank: rankOf(f.order, seq) }));
      texts.shown.forEach((s, seq) => into.shown.push({ value: s, held: reading.held, rank: [0, 0, ...rankOf(s.order, seq)] }));
      texts.called.forEach((s, seq) => into.shown.push({ value: s, held: reading.held, rank: [1, 0, ...rankOf(s.order, seq)] }));
      texts.catalogs.forEach((c, seq) => {
        readIn.set(c, reading);
        into.catalogs.push({ value: c, held: reading.held, rank: rankOf(c.order, seq) });
      });
    }
  };

  /** What a lifted definition's reading keeps: its unit's findings as the
   *  body's, and what the unit shows, holds and instantiates where some value
   *  the definition can be given makes it — the rest beside every unit as a
   *  region's. */
  const takeLifted = (into: VariantTexts, declaration: ConditionedDeclaration, reading: Reading) => {
    const lifted = reading.lifted!;
    const { keeps, dead, template, units } = lifted;
    const view = views.has(declaration) ? 1 : 0;
    const at = position.get(declaration)!;
    const definition = declaration.manifest;
    const unitOfWritten = (path: string): TemplateBodyUnit | "rest" => unitAt(units, path) ?? "rest";
    const unitOfEntry = (entry: number): TemplateBodyUnit | "rest" =>
      unitOfWritten(template.variant.expansion.relocate(pathText(["resources", entry])));
    const unitOfWriting = (writing: number): TemplateBodyUnit | "rest" => {
      const entry = bodyEntryOfWriting(writing);
      return entry === undefined ? "rest" : unitOfEntry(entry);
    };
    const shownHeld = keeps === "rest" ? reading.held : space.existsDefinitions(reading.held);
    for (const { manifest, index, texts } of reading.read) {
      const rankOf = (writing: readonly [number, number], seq: number): Rank =>
        index === 0 ? [view, 0, at, writing[0], writing[1], -1, seq] : [view, 1, at, -1, index, writing[0], writing[1], seq];
      const module = scope.moduleOf(manifest);
      const own = index === 0;
      if (!dead) {
        const kinds = new KindWalk();
        if (!own) {
          if (keeps === "rest") kinds.walk(manifest, module);
        } else {
          const entries = (manifest as { resources?: unknown }).resources;
          if (keeps === "rest") kinds.walk({ ...manifest, resources: [] }, module);
          else if (Array.isArray(entries)) entries.forEach((entry, i) => unitOfEntry(i) === keeps && kinds.walk(entry, module));
        }
        kinds.found().forEach((kind, seq) =>
          into.kinds.push({ value: kind, held: shownHeld, rank: [0, ...(own ? [view, 0, at, -1] : [view, 1, at, -1, index]), seq] }),
        );
      }
      if (!texts) continue;
      const mine = (writing: number) => (own ? unitOfWriting(writing) : "rest") === keeps;
      texts.findings.forEach((f, seq) => {
        const raw = f.diagnostic;
        const [placed] = keeps === "rest" ? [raw] : placedInPart(reading.part!, [raw], template);
        const path = (placed!.data as { path?: unknown } | undefined)?.path;
        const unit = own && typeof path === "string" ? unitOfWritten(path) : "rest";
        if (unit !== keeps) return;
        if (keeps === "rest") {
          into.findings.push({ value: inRun(reading, raw), held: space.existsDefinitions(reading.held), rank: rankOf(f.order, seq) });
          return;
        }
        if (dead && !underBranch(dead.path, path)) return;
        into.findings.push({
          value: placed!,
          held: reading.held,
          rank: rankOf(f.order, seq),
          body: { definition, ...(dead ? { dead: { sentinel: dead.sentinel, branch: dead.branch } } : {}) },
        });
      });
      if (dead) continue;
      texts.shown.forEach((t, seq) => mine(t.order[0]) && into.shown.push({ value: t, held: shownHeld, rank: [0, 0, ...rankOf(t.order, seq)] }));
      texts.called.forEach((t, seq) => mine(t.order[0]) && into.shown.push({ value: t, held: shownHeld, rank: [1, 0, ...rankOf(t.order, seq)] }));
      texts.catalogs.forEach((c, seq) => {
        if (!mine(c.order[0])) return;
        readIn.set(c, reading);
        into.catalogs.push({ value: c, held: shownHeld, rank: rankOf(c.order, seq) });
      });
    }
  };

  // Every library's own documents, which no configuration varies.
  const fixedTexts: VariantTexts = { findings: [], shown: [], catalogs: [], kinds: [], listed: [] };
  libraries.forEach((library, at) => {
    library.manifests.forEach((manifest, index) => {
      const texts = reader(manifest, library.module, false);
      texts.shown.forEach((s, seq) => fixedTexts.shown.push({ value: s, held: TRUE, rank: [0, 1, at, index, ...s.order, seq] }));
      texts.called.forEach((s, seq) => fixedTexts.shown.push({ value: s, held: TRUE, rank: [1, 1, at, index, ...s.order, seq] }));
      const kinds = new KindWalk();
      kinds.walk(manifest, library.module);
      kinds.found().forEach((kind, seq) => fixedTexts.kinds.push({ value: kind, held: TRUE, rank: [1, at, index, seq] }));
    });
  });

  const application = fixed.find((m) => m.kind === "Telo.Application" && scope.isOwned(m));
  const applicationDeclaration = application
    ? union.declarations.find((d) => present(d) && d.manifest.kind === "Telo.Application" && scope.isOwned(d.manifest))
    : undefined;

  /** What one declaration's readings hold. */
  const declarationTexts = (declaration: ConditionedDeclaration) => {
    const texts: VariantTexts = { findings: [], shown: [], catalogs: [], kinds: [], listed: [] };
    if (typeof declaration.manifest.kind === "string" && !isKindDocument(declaration.manifest)) {
      texts.kinds.push({
        value: { kind: declaration.manifest.kind, module: scope.moduleOf(declaration.manifest) },
        held: space.and(declaration.condition, universe),
        rank: [0, views.has(declaration) ? 1 : 0, 0, position.get(declaration)!, -1],
      });
    }
    const regions = regionReadings(declaration);
    for (const { order, readings } of regions) for (const reading of readings) take(texts, declaration, order, reading);
    return { texts, regions };
  };

  /** What every declaration's readings hold. */
  const allTexts = (): VariantTexts => {
    const into: VariantTexts = { findings: [], shown: [...fixedTexts.shown], catalogs: [], kinds: [...fixedTexts.kinds], listed: [] };
    const readings = new Map<ConditionedDeclaration, { order: number; readings: Reading[] }[]>();
    for (const declaration of all) {
      if (!present(declaration)) continue;
      const found = declarationTexts(declaration);
      into.findings.push(...found.texts.findings);
      into.shown.push(...found.texts.shown);
      into.catalogs.push(...found.texts.catalogs);
      into.kinds.push(...found.texts.kinds);
      readings.set(declaration, found.regions);
    }
    into.listed.push(...listedLayers(readings));
    return into;
  };

  /** The layers the application's listed catalogs add, each where its listing
   *  and its catalog hold, ranked by its place in the list. */
  const listedLayers = (readings: Map<ConditionedDeclaration, { order: number; readings: Reading[] }[]>): Held<TranslationLayer>[] => {
    if (!application || !applicationDeclaration) return [];
    const appModule = scope.moduleOf(application);
    const importTargets = new Map<string, string>();
    for (const m of fixed) {
      const target = (m.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (m.kind === "Telo.Import" && typeof target === "string" && scope.moduleOf(m) === appModule) importTargets.set(String(m.metadata?.name), target);
    }
    // Every declaration a listing may name, each where its reading holds.
    const candidates = new Map<string, { manifest: ResourceManifest; held: Condition }[]>();
    for (const regions of readings.values()) {
      for (const { readings: list } of regions) {
        for (const reading of list) {
          for (const { manifest } of reading.read) {
            const name = manifest.metadata?.name;
            if (typeof name !== "string" || manifest.kind === "Telo.Import" || isModuleKind(manifest.kind as string) || isKindDocument(manifest)) continue;
            const key = `${scope.moduleOf(manifest)}\0${name}`;
            candidates.set(key, [...(candidates.get(key) ?? []), { manifest, held: reading.held }]);
          }
        }
      }
    }
    const out: Held<TranslationLayer>[] = [];
    for (const { readings: list } of readings.get(applicationDeclaration) ?? []) {
      for (const reading of list) {
        const own = reading.read.find((entry) => entry.index === 0)?.manifest;
        const catalogs = (own as { translations?: { catalogs?: unknown } } | undefined)?.translations?.catalogs;
        if (!Array.isArray(catalogs)) continue;
        catalogs.forEach((reference, index) => {
          if (!isResolvedReference(reference)) return;
          const local = reference.alias === undefined;
          const module = local ? appModule : importTargets.get(reference.alias!);
          if (module === undefined) return;
          for (const candidate of candidates.get(`${module}\0${reference.name}`) ?? []) {
            const meta = candidate.manifest.metadata as { forwardedExport?: unknown } | undefined;
            if (local ? !scope.isOwned(candidate.manifest) : meta?.forwardedExport !== true) continue;
            const layer = coverage.layerOf({ manifest: candidate.manifest, module });
            const held = space.and(reading.held, candidate.held);
            if (layer && held !== FALSE) out.push({ value: layer, held, rank: [index] });
          }
        });
      }
    }
    return out;
  };

  const sorted = <T>(list: readonly Held<T>[]) => [...list].sort((a, b) => compareRank(a.rank, b.rank));

  /** Coverage where `holds` says what holds. */
  const coverageBy = (texts: VariantTexts, holds: (h: Held<unknown>) => boolean): { lang: string; set?: string; diagnostic: AnalysisDiagnostic }[] => {
    if (!application) return [];
    const written = new Map<string, Set<string>>();
    for (const s of sorted(texts.shown)) {
      if (!s.value.written || !holds(s)) continue;
      let set = written.get(s.value.module);
      if (!set) written.set(s.value.module, (set = new Set()));
      set.add(s.value.key);
    }
    const kinds = new Map<string, InstantiatedKind>();
    for (const k of sorted(texts.kinds)) if (holds(k) && !kinds.has(`${k.value.module}\0${k.value.kind}`)) kinds.set(`${k.value.module}\0${k.value.kind}`, k.value);
    return coverage.missingTranslationDiagnostics({
      application,
      modules: closure.reach(scope.moduleOf(application)),
      written,
      kinds: [...kinds.values()],
      listed: sorted(texts.listed).filter(holds).map((l) => l.value),
    });
  };

  const logic: CoverageLogic<Condition> = {
    TRUE,
    FALSE,
    and: (a, b) => space.and(a, b),
    or: (a, b) => space.or(a, b),
    not: (a) => space.not(a),
    isFalse: (a) => a === FALSE,
  };

  /** Every finding, in a run's order, with where it holds. */
  const tableOf = (texts: VariantTexts): { found: ReadFinding[]; body: PassBodyFinding[] } => {
    const out: ({ diagnostic: AnalysisDiagnostic; condition: Condition } | { body: { -readonly [K in keyof PassBodyFinding]: PassBodyFinding[K] } })[] = [];
    const read: ReadFinding[] = [];
    // One finding several readings make — at a place each region holds — once.
    const byText = new Map<string, (typeof out)[number]>();
    for (const f of sorted(texts.findings)) {
      const text = JSON.stringify([f.value.code, f.value.message, f.value.data, f.body?.dead ? "dead" : f.body ? "live" : "run"]);
      const known = byText.get(text);
      if (known && "body" in known) {
        if (known.body.live !== undefined) known.body.live = space.or(known.body.live, f.held);
        known.body.configuration = space.or(known.body.configuration, space.existsDefinitions(f.held));
      } else if (known) known.condition = space.or(known.condition, f.held);
      else {
        const entry: (typeof out)[number] = f.body
          ? {
              body: {
                diagnostic: f.value,
                definition: f.body.definition,
                ...(f.body.dead ? { dead: f.body.dead } : { live: f.held }),
                configuration: space.existsDefinitions(f.held),
              },
            }
          : { diagnostic: f.value, condition: f.held };
        byText.set(text, entry);
        out.push(entry);
      }
    }
    // MESSAGE_TEXT_UNUSED: where its catalog holds and no module of the
    // catalog's closure shows the entry.
    const shownBy = new Map<string, Map<string, Condition>>();
    for (const s of texts.shown) {
      let byModule = shownBy.get(s.value.key);
      if (!byModule) shownBy.set(s.value.key, (byModule = new Map()));
      byModule.set(s.value.module, space.or(byModule.get(s.value.module) ?? FALSE, s.held));
    }
    const builtin = builtinShownTexts();
    for (const c of sorted(texts.catalogs)) {
      const reached = closure.reach(c.value.module);
      for (const entry of c.value.entries) {
        if (builtin.has(entry.key)) continue;
        let shown = FALSE;
        for (const [module, held] of shownBy.get(entry.key) ?? []) if (reached.has(module)) shown = space.or(shown, held);
        const held = space.and(c.held, space.not(shown));
        if (held !== FALSE) out.push({ diagnostic: unusedOf(c.value, entry.index), condition: held });
      }
    }
    // MESSAGE_TRANSLATION_MISSING: decided over conditions, each wording once
    // per class of the conditions its items hold under.
    if (application) {
      const written = new Map<string, Map<string, Condition>>();
      for (const s of texts.shown) {
        if (!s.value.written) continue;
        let keys = written.get(s.value.module);
        if (!keys) written.set(s.value.module, (keys = new Map()));
        keys.set(s.value.key, space.or(keys.get(s.value.key) ?? FALSE, s.held));
      }
      const kinds = new Map<string, InstantiatedKind & { held: Condition }>();
      for (const k of texts.kinds) {
        const id = `${k.value.module}\0${k.value.kind}`;
        const known = kinds.get(id);
        kinds.set(id, { ...k.value, held: known ? space.or(known.held, k.held) : k.held });
      }
      const entries = coverage.heldCoverage(logic, {
        application,
        modules: closure.reach(scope.moduleOf(application)),
        written,
        kinds: [...kinds.values()],
        listed: sorted(texts.listed).map((l) => ({ ...l.value, held: l.held })),
      });
      for (const entry of entries) {
        const any = entry.missing.reduce((held, item) => space.or(held, item.held), FALSE);
        // Each wording where what the coverage reads holds alike.
        for (const part of splitByReads(space, space.and(any, universe), (reader) =>
          coverageBy(texts, (h) => reader.holds(h.held as Condition)).filter((f) => f.lang === entry.lang && f.set === entry.set),
        )) {
          for (const at of part.value) read.push({ held: part.condition, render: () => [at.diagnostic] });
        }
      }
    }
    return {
      found: [...fixedFindings(out.flatMap((entry): PassFinding[] => ("body" in entry ? [] : [entry]))), ...read],
      body: out.flatMap((entry) => ("body" in entry ? [entry.body] : [])),
    };
  };

  const table = tableOf(allTexts());
  reportKeyCost({ kind: "pass-table", pass: "texts", entries: table.found.length + table.body.length });

  return {
    ...table,
    dead: deadFindings("texts", inputs.deadBranches, (run: DeadBranchRun): readonly AnalysisDiagnostic[] => {
      const witness: World = run.world;
      const texts: VariantTexts = { findings: [], shown: [...fixedTexts.shown], catalogs: [], kinds: [...fixedTexts.kinds], listed: [] };
      const readings = new Map<ConditionedDeclaration, { order: number; readings: Reading[] }[]>();
      for (const declaration of all) {
        if (!parts.presentAt(declaration, witness)) continue;
        const view = views.has(declaration) ? 1 : 0;
        const at = position.get(declaration)!;
        if (typeof declaration.manifest.kind === "string" && !isKindDocument(declaration.manifest)) {
          texts.kinds.push({ value: { kind: declaration.manifest.kind, module: scope.moduleOf(declaration.manifest) }, held: TRUE, rank: [0, view, 0, at, -1] });
        }
        const reading = readAt(declaration, [[]], witness);
        readings.set(declaration, [{ order: 0, readings: [reading] }]);
        // A lifted body's findings are its own reading's, never a run's.
        take(texts, declaration, 0, { ...reading, held: TRUE, ...(reading.lifted ? { lifted: { ...reading.lifted, keeps: "rest" as const } } : {}) });
      }
      texts.listed.push(...listedLayers(readings).map((l) => ({ ...l, held: TRUE })));
      // In a branch no configuration takes everything read is held there.
      return [
        ...sorted(texts.findings).map((f) => f.value),
        ...deadUnused(texts),
        ...coverageBy(texts, () => true).map((f) => f.diagnostic),
      ];
    }),
  };

  /** MESSAGE_TEXT_UNUSED at one witness, everything held there. */
  function deadUnused(texts: VariantTexts): AnalysisDiagnostic[] {
    const shown = new Map<string, Set<string>>();
    for (const s of texts.shown) {
      let set = shown.get(s.value.module);
      if (!set) shown.set(s.value.module, (set = new Set()));
      set.add(s.value.key);
    }
    const at = new ClosureTexts(fixed, scope, shown);
    const out: AnalysisDiagnostic[] = [];
    for (const c of sorted(texts.catalogs)) {
      const reached = at.of(c.value.module);
      for (const entry of c.value.entries) if (!reached.has(entry.key)) out.push(unusedOf(c.value, entry.index));
    }
    return out;
  }
}

/** What a qualified call names, by the calling module's own names and imports,
 *  among the declarations present at a witness — read for the parameters it
 *  declares, with where the callee reads as there. */
class UnionCallees {
  private readonly imports = new Map<string, string>();
  private readonly declarations = new Map<string, ConditionedDeclaration[]>();
  private readonly fixed = new Map<string, ResourceManifest>();

  constructor(
    private readonly union: ConditionedExpansion,
    libraries: readonly ModuleDocuments[],
    private readonly scope: TextLanguageScope,
    private readonly resolveDef: TextDefResolver,
    fixedDocuments: readonly ResourceManifest[],
  ) {
    for (const m of fixedDocuments) {
      const target = (m.metadata as { resolvedModuleName?: unknown } | undefined)?.resolvedModuleName;
      if (m.kind === "Telo.Import" && typeof target === "string") this.imports.set(`${scope.moduleOf(m)}\0${String(m.metadata?.name)}`, target);
    }
    for (const d of union.declarations) {
      const name = d.manifest.metadata?.name;
      if (typeof name !== "string" || d.manifest.kind === "Telo.Import" || d.condition === FALSE) continue;
      const key = `${scope.moduleOf(d.manifest)}\0${name}`;
      this.declarations.set(key, [...(this.declarations.get(key) ?? []), d]);
    }
    for (const library of libraries) {
      for (const m of library.manifests) {
        const name = m.metadata?.name;
        if (typeof name === "string" && m.kind !== "Telo.Import") this.fixed.set(`${library.module}\0${name}`, m);
      }
    }
  }

  paramsAt(qualified: string, module: string, witness: World): { params: readonly { name?: unknown; schema?: unknown }[]; condition: Condition } {
    const { space } = this.union;
    const dot = qualified.indexOf(".");
    const receiver = qualified.slice(0, dot);
    const name = qualified.slice(dot + 1);
    const target = receiver === SELF_ALIAS || receiver === module ? module : this.imports.get(`${module}\0${receiver}`);
    if (!target) return { params: [], condition: TRUE };
    // A library's own documents override what the flattened set forwards.
    let declaration: ResourceManifest | undefined = this.fixed.get(`${target}\0${name}`);
    let condition = TRUE;
    if (!declaration) {
      for (const d of this.declarations.get(`${target}\0${name}`) ?? []) {
        const projected = this.union.project(d.manifest, witness.assignment, witness.forcing);
        const taken = projected.present && space.holds(d.condition, witness.assignment);
        condition = space.and(condition, taken ? space.and(d.condition, projected.taken) : space.not(d.condition));
        if (taken) declaration = projected.value as ResourceManifest;
      }
    }
    if (!declaration || typeof declaration.kind !== "string") return { params: [], condition };
    const definition = this.resolveDef.in(declaration.kind, target) as ResourceDefinition | undefined;
    return {
      params: resolveSignature(declaration, definition, (kind) => this.resolveDef.in(kind, target)).params ?? [],
      condition,
    };
  }
}
