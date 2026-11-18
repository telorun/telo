/**
 * The need table's refusals over every configuration at once.
 *
 * A module document, an import and a kind document never vary outside a
 * template body, so every need, need type and import the table reads is read
 * once. A lifted template body's reference sites are read unit by unit over
 * its reading (`lifted-body-findings.ts`), each held where the units it was
 * read under hold as there: a refusal about the body is held over the
 * definition's own dimensions, every other one reads the body's sites where
 * some value the definition can be given makes them hold. What varies is the entry's own
 * declarations and the reference sites in them: each is a reading of the
 * conditioned call graph — a declaration, what extraction draws out of it, a
 * scope member, a forward view — held under its reading's condition, a
 * reference site kept by the reading whose chain of options is exactly the
 * options enclosing it, a fulfilment's `fields:` keys each where it is written.
 * The table's one rule (`resolveNeedTable`) then decides each refusal with
 * where it holds, an optional need's presence read from the configuration's
 * dimensions; a refusal about a declaration is rendered where it holds, as a
 * run renders its own.
 *
 * Browser-safe.
 */
import { aboutDeclaration } from "./placement.js";
import type { ResourceManifest } from "@telorun/sdk";
import { reportKeyCost } from "./cel-site-judgements.js";
import type { ConditionedCallGraph, HeldAt, HeldGraphNode, HeldView } from "./conditioned-call-graph.js";
import type { ChoiceDecider, ConditionedDeclaration, ConditionedExpansion, World } from "./conditioned-expansion.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import type { KeyParts } from "./key-parts.js";
import { isKindDocument } from "./kind-declaration.js";
import { placedInPart, underBranch, unitAt, unitReadings } from "./lifted-body-findings.js";
import type { ModuleDocuments } from "./module-documents.js";
import { isModuleKind } from "./module-kinds.js";
import {
  declarationReferences,
  needGraphFromManifests,
  resolveNeedTable,
  templateBodyReferences,
  type NeedGraph,
  type NeedGraphDeclaration,
  type NeedGraphReference,
  type NeedGraphScope,
  type NeedLogic,
  type NeedProblem,
} from "./need-table.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { isInjectedDeclaration } from "./resource-input.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";
import { parseKeys, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type PassBodyFinding, type PassTable } from "./union-passes.js";
import { needProblemDiagnostics } from "./validate-needs.js";
import { deadBranchReader, type DeadBranchRun } from "./world-reader.js";

type Keys = readonly (string | number)[];

export interface NeedTableFindingsInputs {
  readonly union: ConditionedExpansion;
  readonly graph: ConditionedCallGraph;
  readonly parts: KeyParts;
  /** The first configuration kept: what no choice varies is read there. */
  readonly base: World;
  /** The configurations kept. */
  readonly universe: Condition;
  /** Each lifted definition's body units. */
  readonly bodyUnits: ReadonlyMap<ResourceManifest, readonly TemplateBodyUnit[]>;
  readonly rootModules: ReadonlySet<string>;
  readonly scope: NeedGraphScope;
  readonly libraries: readonly ModuleDocuments[];
  /** Where a root module's optional need is proven present. */
  readonly presentNeed: (need: string) => Condition;
  /** The branches no configuration takes, each read once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** Where a declaration or a reference site of one is written: its call-graph
 *  node and its place in the node's declaration. */
interface Site {
  readonly id: string;
  readonly keys: Keys;
}

/** One finding over every configuration: where it holds, what the table
 *  found, whether it is about a call-graph node, and how a run reads it where
 *  `read` decides the choices. */
interface Found<T> {
  readonly held: T;
  readonly diagnostic: AnalysisDiagnostic;
  readonly located: boolean;
  render(read: ChoiceDecider): AnalysisDiagnostic;
}

const forwarded = (m: ResourceManifest): boolean => {
  const meta = m.metadata as { forwardedExport?: boolean; forwardedInternal?: boolean; forwardedShape?: boolean };
  return isForwardedDeclaration(m) || !!meta.forwardedExport || !!meta.forwardedInternal || !!meta.forwardedShape;
};

/** The value at `keys` of `root`. */
function valueAt(root: unknown, keys: Keys): unknown {
  let at = root;
  for (const key of keys) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

export function needTableFindings(inputs: NeedTableFindingsInputs): PassTable {
  const { union, graph, parts, base } = inputs;
  const { space } = union;
  const conditions: NeedLogic<Condition> = {
    TRUE,
    FALSE,
    and: (a, b) => space.and(a, b),
    or: (a, b) => space.or(a, b),
    not: (a) => space.not(a),
    isFalse: (a) => a === FALSE,
    atoms: (held) => space.atoms(held),
  };

  // What no choice varies: the module and kind documents, the imports and the
  // declarations injected for inputs and needs.
  const invariant: ResourceManifest[] = union.declarations.flatMap((declaration) => {
    const m = declaration.manifest;
    if (declaration.condition === FALSE || declaration.unreachable) return [];
    if (!isModuleKind(m.kind) && !isKindDocument(m) && m.kind !== "Telo.Import" && !isInjectedDeclaration(m)) return [];
    reportKeyCost({ kind: "pass-reading", pass: "needTable", declaration });
    return isKindDocument(m) ? [parts.partAt(declaration, base).manifests[0]!] : [union.project(m, base.assignment).value as ResourceManifest];
  });

  // Every lifted template body of an entry module: its reference sites over
  // its reading, by where each is written — each held where the units it was
  // read under hold, and those of each branch no value takes, read forced.
  interface BodySites {
    readonly definition: ResourceManifest;
    readonly holder: NeedGraphDeclaration;
    readonly live: { reference: NeedGraphReference; held: Condition }[];
    readonly dead: { branch: TemplateBodyUnit["dead"][number]; references: NeedGraphReference[] }[];
  }
  const lifted: BodySites[] = [];
  const atWitness = (witness: World): World => witness.over(base.assignment);
  for (const declaration of union.declarations as readonly ConditionedDeclaration[]) {
    const definition = declaration.manifest;
    const units = inputs.bodyUnits.get(definition);
    const module = (definition.metadata as { module?: string } | undefined)?.module;
    if (!units || !parts.lifted(definition) || declaration.condition === FALSE || declaration.unreachable) continue;
    if (module === undefined || !inputs.rootModules.has(module)) continue;
    const holder: NeedGraphDeclaration = { name: definition.metadata?.name as string, kind: definition.kind, manifest: definition };
    const meta = definition.metadata as { name?: string; source?: string } | undefined;
    const sitesAt = (witness: World) => {
      reportKeyCost({ kind: "pass-reading", pass: "needTable", declaration });
      const part = parts.partAt(declaration, atWitness(witness));
      const references = templateBodyReferences(module, part.manifests[0]!, holder, inputs.scope);
      const probes: AnalysisDiagnostic[] = references.map((reference) => ({
        severity: DiagnosticSeverity.Hint,
        code: "",
        source: "telo-analyzer",
        message: "",
        data: { resource: { kind: definition.kind, name: meta?.name }, filePath: meta?.source, path: reference.path },
      }));
      return placedInPart(part, probes, part.template).map((placed, i) => ({
        ...references[i]!,
        path: String((placed.data as { path?: unknown }).path),
      }));
    };
    const live = new Map<string, { reference: NeedGraphReference; held: Condition }>();
    const dead: BodySites["dead"] = [];
    unitReadings(
      { space, universe: inputs.universe, declaration, units },
      (witness, unit, condition, whole) => {
        for (const reference of sitesAt(witness)) {
          const at = unitAt(units, reference.path);
          if (at !== undefined && at !== unit) continue;
          const held = at ? condition : whole();
          const key = JSON.stringify([reference.path, reference.target, reference.observes, reference.childNeed ?? null]);
          const known = live.get(key);
          if (known) known.held = space.or(known.held, held);
          else live.set(key, { reference, held });
        }
      },
      (witness, branch) => dead.push({ branch, references: sitesAt(witness) }),
    );
    lifted.push({ definition, holder, live: [...live.values()], dead });
  }
  /** Whether `diagnostic` is about a lifted body of an entry module. */
  const inLiftedBody = (diagnostic: AnalysisDiagnostic): BodySites | undefined => {
    const data = diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
    if (data?.resource?.kind !== "Telo.Definition" || typeof data.path !== "string") return undefined;
    if (!TEMPLATE_BODY_FIELDS.includes(String(parseKeys(data.path)[0]))) return undefined;
    return lifted.find((body) => {
      const meta = body.definition.metadata as { name?: unknown; source?: unknown } | undefined;
      return meta?.name === data.resource!.name && meta?.source === data.filePath;
    });
  };
  /** Of a lifted body, the reference sites a reading of the table holds, and
   *  where. */
  type BodyHeld<T> = (body: BodySites) => { reference: NeedGraphReference; held: T }[];

  // The readings of every resource node, in the order a run lists its
  // declarations: the declarations and what extraction draws out of them, the
  // scope members, then the forward views.
  const byId = new Map<string, HeldGraphNode[]>();
  for (const node of graph.nodes) {
    if (node.node.type !== "resource") continue;
    const list = byId.get(node.id) ?? [];
    list.push(node);
    byId.set(node.id, list);
  }
  const views = new Set<object>(union.views);
  const moduleScope = graph.resourceNodes().map((node) => node.id);
  const ordered = [
    ...moduleScope.filter((id) => !views.has(byId.get(id)![0]!.declaration)),
    ...[...byId.keys()].filter((id) => byId.get(id)![0]!.site !== undefined),
    ...moduleScope.filter((id) => views.has(byId.get(id)![0]!.declaration)),
  ];
  const readings = new Map(ordered.map((id) => [id, byId.get(id)!] as const));
  const moduleOf = (id: string): string | undefined =>
    (graph.manifestOf(id).metadata as { module?: string } | undefined)?.module;

  const viewsOf = new Map<object, HeldView[]>();
  for (const view of graph.views) {
    const list = viewsOf.get(view.declaration) ?? [];
    list.push(view);
    viewsOf.set(view.declaration, list);
  }

  /** The graph of `variant`, the entry's own declarations and their sites each
   *  held as `heldOf` says. */
  const graphIn = <T>(
    logic: NeedLogic<T>,
    heldOf: (element: HeldAt) => T,
    presentNeed: (need: string) => T,
    sites: Map<object, Site>,
    bodyHeld: BodyHeld<T>,
  ): NeedGraph | undefined => {
    const built = needGraphFromManifests(invariant, inputs.rootModules, inputs.scope, inputs.libraries);
    if (!built) return undefined;
    for (const unit of built.modules.values()) {
      if (!unit.checked || !inputs.rootModules.has(unit.name)) continue;
      const declarations: NeedGraphDeclaration[] = [];
      const references: NeedGraphReference[] = [];
      for (const [id, held] of readings) {
        const first = held[0]!;
        const manifest = (first.node as { manifest: ResourceManifest }).manifest;
        if (moduleOf(id) !== unit.name || typeof manifest.kind !== "string") continue;
        if (isModuleKind(manifest.kind) || isKindDocument(manifest) || manifest.kind === "Telo.Import") continue;
        if (isInjectedDeclaration(manifest) || forwarded(manifest)) continue;
        reportKeyCost({ kind: "pass-reading", pass: "needTable", declaration: first.declaration });
        const type = inputs.scope.resolveKind(unit.name, manifest.kind);
        const declaration: NeedGraphDeclaration = {
          name: (first.node as { name: string }).name,
          kind: manifest.kind,
          ...(type ? { type } : {}),
          manifest,
          held: held.reduce((presence, reading) => logic.or(presence, heldOf(reading)), logic.FALSE),
        };
        sites.set(declaration, { id, keys: first.keys });
        declarations.push(declaration);
        // Each view of its declaration holds what that chain of options writes
        // in it: a `fields:` key, a reference site, each at home there.
        // One node may be declared by several declarations of the union — the
        // branches of a choice declaring it — each read where it is written.
        const fieldKeys = new Map<string, T>();
        const writers = new Map<object, Keys>();
        for (const reading of held) if (!writers.has(reading.declaration)) writers.set(reading.declaration, reading.keys);
        for (const [writer, at0] of writers) {
          for (const view of viewsOf.get(writer) ?? []) {
            const at = heldOf(view);
            if (logic.isFalse(at)) continue;
            const written = first.site
              ? valueAt(view.manifests[0]?.manifest, at0)
              : view.manifests.find((entry) => entry.id === id)?.manifest;
            if (!written || typeof written !== "object") continue;
            const fields = (written as Record<string, unknown>).fields;
            if (fields && typeof fields === "object" && !Array.isArray(fields)) {
              for (const key of Object.keys(fields)) {
                if (view.home([...at0, "fields", key])) fieldKeys.set(key, logic.or(fieldKeys.get(key) ?? logic.FALSE, at));
              }
            }
            const reading = { ...declaration, manifest: written as ResourceManifest };
            for (const reference of declarationReferences(unit.name, reading, inputs.scope)) {
              const keys = [...at0, ...parseKeys(reference.path)];
              if (!view.home(keys)) continue;
              const kept = { ...reference, declaration, held: at };
              sites.set(kept, { id, keys });
              references.push(kept);
            }
          }
        }
        declaration.fieldKeys = fieldKeys;
      }
      // A template body's entries vary only with its definition: a lifted
      // one's are read over its reading.
      for (const reference of unit.references ?? []) {
        if (!isKindDocument(reference.declaration.manifest)) continue;
        const meta = reference.declaration.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
        const body = lifted.find((each) => {
          const own = each.definition.metadata as { name?: unknown; source?: unknown } | undefined;
          return own?.name === meta?.name && own?.source === meta?.source;
        });
        if (!body) references.push(reference);
      }
      for (const body of lifted) {
        if ((body.definition.metadata as { module?: string } | undefined)?.module !== unit.name) continue;
        for (const { reference, held } of bodyHeld(body)) references.push({ ...reference, held });
      }
      unit.declarations = declarations;
      unit.references = references;
    }
    return {
      ...built,
      logic: logic as NeedLogic<unknown>,
      presentNeed: (module, need) => (inputs.rootModules.has(module) ? presentNeed(need) : logic.FALSE),
    };
  };

  /** The findings of `graph`, each rendered where it holds when it is about
   *  a declaration a run renders its own way. */
  const findingsOf = <T>(built: NeedGraph | undefined, sites: Map<object, Site>, logic: NeedLogic<T>): Found<T>[] => {
    if (!built) return [];
    const problems = resolveNeedTable(built).problems;
    return needProblemDiagnostics(built, problems, inputs.rootModules).map(({ diagnostic, problems: stands }) => {
      const site = siteOf(stands[0]!, sites);
      return {
        held: stands.reduce((held, p) => logic.or(held, (p.held ?? logic.TRUE) as T), logic.FALSE),
        diagnostic,
        located: site !== undefined,
        render: (read) => (site ? renderBy(diagnostic, stands[0]!.about!, site, read) : diagnostic),
      };
    });
  };

  const siteOf = (problem: NeedProblem, sites: Map<object, Site>): Site | undefined => {
    const about = problem.about;
    return about ? sites.get(about.reference ?? about.declaration) : undefined;
  };
  const renderBy = (diagnostic: AnalysisDiagnostic, about: NonNullable<NeedProblem["about"]>, site: Site, read: ChoiceDecider): AnalysisDiagnostic => {
    const identity = graph.identityBy(site.id, read);
    const path = about.reference ? graph.relativePathBy(site.id, site.keys, read) : "";
    const again = about.rerender(identity.kind, identity.name, path);
    const at = {
      resource: { kind: identity.kind, name: identity.name },
      filePath: (identity.manifest.metadata as { source?: string } | undefined)?.source,
      path: again.path,
    };
    return aboutDeclaration({ ...diagnostic, message: again.message, data: { ...(diagnostic.data as Record<string, unknown>), ...at } }, site.id);
  };
  // A finding about a call-graph node is about an instance, never a kind
  // document; one about a lifted body is about no node, and reads no choice.
  const bodyOf = (found: Found<unknown>): BodySites | undefined => (found.located ? undefined : inLiftedBody(found.diagnostic));

  // Two readings of the table: one where every lifted body's sites hold where
  // some value its definition can be given makes them — what decides every
  // refusal outside a body — and one holding them over the definitions' own
  // dimensions, which decides each refusal about a body.
  const sitesMay = new Map<object, Site>();
  const may = findingsOf(
    graphIn(conditions, (r) => r.condition, inputs.presentNeed, sitesMay, (body) =>
      body.live.map(({ reference, held }) => ({ reference, held: space.existsDefinitions(held) })),
    ),
    sitesMay,
    conditions,
  );
  const sitesOwn = new Map<object, Site>();
  const own = findingsOf(
    graphIn(conditions, (r) => r.condition, inputs.presentNeed, sitesOwn, (body) => body.live),
    sitesOwn,
    conditions,
  );
  const bodyFindings: PassBodyFinding[] = [];
  const bodyIndex = new Map<string, number>();
  const addBody = (diagnostic: AnalysisDiagnostic, body: BodySites, held: Condition, dead?: TemplateBodyUnit["dead"][number]) => {
    const configuration = space.existsDefinitions(held);
    if (configuration === FALSE) return;
    const data = diagnostic.data as { path?: unknown } | undefined;
    const key = JSON.stringify([dead ? "dead" : "live", diagnostic.code, (body.definition.metadata as { source?: unknown }).source, body.definition.metadata?.name, data?.path, diagnostic.message]);
    const known = bodyIndex.get(key);
    if (known !== undefined) {
      const found = bodyFindings[known]!;
      bodyFindings[known] = {
        ...found,
        ...(found.live !== undefined ? { live: space.or(found.live, held) } : {}),
        configuration: space.or(found.configuration, configuration),
      };
      return;
    }
    bodyIndex.set(key, bodyFindings.length);
    bodyFindings.push({
      diagnostic,
      definition: body.definition,
      ...(dead ? { dead: { sentinel: dead.sentinel, branch: dead.branch } } : { live: held }),
      configuration,
    });
  };
  for (const found of own) {
    const body = bodyOf(found);
    if (body) addBody(found.diagnostic, body, found.held);
  }
  // Each branch of a lifted body no value takes: the table read with that body
  // decided at the branch's witness, keeping what is found beneath it.
  for (const body of lifted) {
    for (const { branch, references } of body.dead) {
      const sites = new Map<object, Site>();
      const forced = findingsOf(
        graphIn(conditions, (r) => r.condition, inputs.presentNeed, sites, (each) =>
          each === body
            ? references.map((reference) => ({ reference, held: TRUE }))
            : each.live.map(({ reference, held }) => ({ reference, held: space.existsDefinitions(held) })),
        ),
        sites,
        conditions,
      );
      for (const found of forced) {
        if (bodyOf(found) !== body || !underBranch(branch.path, (found.diagnostic.data as { path?: unknown }).path)) continue;
        addBody(found.diagnostic, body, found.held, branch);
      }
    }
  }
  const plain = may.filter((found) => !bodyOf(found));
  reportKeyCost({ kind: "pass-table", pass: "needTable", entries: plain.length + bodyFindings.length });
  const oneConfiguration: NeedLogic<boolean> = {
    TRUE: true,
    FALSE: false,
    and: (a, b) => a && b,
    or: (a, b) => a || b,
    not: (a) => !a,
    isFalse: (a) => !a,
    atoms: () => [true],
  };
  return {
    body: bodyFindings,
    found: plain.map((found) => ({ held: found.held, render: (read) => [found.render(read)] })),
    // A branch no configuration takes is read at its witness: each reading
    // held where the witness takes it, a lifted body's sites where some value
    // its definition can be given makes them hold there.
    dead: readDeadBranches("needTable", inputs.deadBranches, (branch) => {
      const witness: World = branch.world;
      const sites = new Map<object, Site>();
      const built = graphIn(
        oneConfiguration,
        (reading) => graph.holdsAt(reading, witness),
        (need) => space.holds(inputs.presentNeed(need), branch.baseline),
        sites,
        (body) => body.live.map(({ reference, held }) => ({ reference, held: space.holds(space.existsDefinitions(held), branch.baseline) })),
      );
      return findingsOf(built, sites, oneConfiguration)
        .filter((found) => found.held && !bodyOf(found))
        .map((found) => found.render(deadBranchReader(space, branch)))
        .map((diagnostic) => ({ branch, render: () => [diagnostic] }));
    }),
  };
}
