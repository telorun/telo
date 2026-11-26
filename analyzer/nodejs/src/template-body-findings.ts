/**
 * The template body checks over every configuration at once: a body's
 * reference surface (`validate-template-body.ts`) and the schema a templated
 * kind declares for what it forwards (`validate-template-forward.ts`).
 *
 * A kind document never varies outside its template body. A definition whose
 * body holds a choice is read unit by unit over its reading
 * (`lifted-body-findings.ts`), each finding held over the definition's own
 * dimensions; every other one is read once. What a body's bare `!ref` reaches
 * beyond its siblings is the one input that varies with the configuration:
 * each resource of the defining module present under the condition the call
 * graph holds it under, so `TEMPLATE_REF_UNKNOWN` — and the name it suggests —
 * hold where the resources present make them. What a message lists of the
 * body is the body as written: every way of deciding it.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import type { AliasResolver } from "./alias-resolver.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import type { ConditionedCallGraph } from "./conditioned-call-graph.js";
import type { ConditionedDeclaration, ConditionedExpansion, World } from "./conditioned-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { DeclarationPart, KeyParts, TemplateVariantOf } from "./key-parts.js";
import { isKindDocument } from "./kind-declaration.js";
import { liftedBodyFindings, type RawBodyFinding } from "./lifted-body-findings.js";
import { isModuleKind } from "./module-kinds.js";
import { nearestNameWhere, type NameLogic } from "./nearest-name.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import type { TemplateBodyUnit } from "./template-body-sites.js";
import type { AnalysisDiagnostic } from "./types.js";
import { passTableOf, type PassEntry, type PassTable, type UnionPassName } from "./union-passes.js";
import { validateTemplateBody, type TemplateBodyReach } from "./validate-template-body.js";
import { validateTemplateForwards } from "./validate-template-forward.js";
import { callableSlotContextOf } from "./validate-references.js";

export interface TemplateBodyFindingsInputs {
  readonly union: ConditionedExpansion;
  readonly parts: KeyParts;
  readonly graph: ConditionedCallGraph;
  /** A configuration the definitions are read at. */
  readonly base: World;
  /** The configurations kept. */
  readonly universe: Condition;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  /** The definitions the analysis reads: the entry's own and each dependency's
   *  it reaches. */
  readonly reads: (definition: ResourceManifest) => boolean;
  /** Whether a definition read is the entry's own: a dependency's findings are
   *  held apart, as a lifted body's are, and never listed by a run. */
  readonly isOwn: (definition: ResourceManifest) => boolean;
  /** Each lifted definition's body units. */
  readonly bodyUnits: ReadonlyMap<ResourceManifest, readonly TemplateBodyUnit[]>;
  /** The entries each lifted definition's body declares as written. */
  readonly writtenEntries: (definition: ResourceManifest) => readonly string[] | undefined;
  /** The loop bindings in scope at `path` of a definition expanded as `template`. */
  readonly bindingsAt: (template: TemplateVariantOf, definition: ResourceManifest, path: string) => readonly string[];
  /** What else a run reports with the body checks of a definition whose body
   *  is decided as `template`. */
  readonly spliceIssues: (template: TemplateVariantOf) => readonly AnalysisDiagnostic[];
  readonly keep: (diagnostic: AnalysisDiagnostic) => boolean;
}

/** The imports of the union present at the base witness, and each kind
 *  document in order, as a run lists them. */
function documentsOf(inputs: Pick<TemplateBodyFindingsInputs, "union" | "parts" | "base" | "reads">) {
  const imports: ResourceManifest[] = [];
  const kinds: ConditionedDeclaration[] = [];
  for (const declaration of inputs.union.declarations) {
    if (declaration.condition === FALSE || declaration.unreachable) continue;
    if (declaration.manifest.kind === "Telo.Import") {
      imports.push(inputs.parts.partAt(declaration, inputs.base).manifests[0]!);
      continue;
    }
    if (!isKindDocument(declaration.manifest)) continue;
    if (declaration.manifest.kind === "Telo.Definition" && !inputs.reads(declaration.manifest)) continue;
    kinds.push(declaration);
  }
  return { imports, kinds };
}

/** A pass over each kind document — one reading of a document no body choice
 *  varies, read unit by unit over its reading where one does. */
function definitionTable(
  inputs: Pick<TemplateBodyFindingsInputs, "union" | "parts" | "base" | "universe" | "bodyUnits" | "reads" | "isOwn">,
  pass: UnionPassName & ("templateBody" | "templateForwards" | "templateRelations"),
  find: (manifests: ResourceManifest[], part: DeclarationPart) => readonly RawBodyFinding[],
): PassTable {
  const { union, parts } = inputs;
  const { space } = union;
  const { imports, kinds } = documentsOf(inputs);
  const reading = (declaration: ConditionedDeclaration) => {
    if (pass === "templateBody") reportKeyCost({ kind: "pass-reading", pass, declaration });
  };
  const entries: PassEntry[] = [];
  for (const declaration of kinds) {
    const units = inputs.bodyUnits.get(declaration.manifest);
    if (!units || !parts.lifted(declaration.manifest)) {
      reading(declaration);
      const part = parts.partAt(declaration, inputs.base);
      const own = inputs.isOwn(declaration.manifest);
      for (const { diagnostic, held } of find([...imports, ...part.manifests.slice(0, 1)], part)) {
        entries.push(own ? { diagnostic, condition: held } : { body: { diagnostic, definition: declaration.manifest, live: held, configuration: held } });
      }
      continue;
    }
    const body = liftedBodyFindings({
      space,
      universe: inputs.universe,
      declaration,
      units,
      partAt: (witness) => {
        reading(declaration);
        return parts.partAt(declaration, witness.over(inputs.base.assignment));
      },
      find: (part) => find([...imports, ...part.manifests.slice(0, 1)], part),
    });
    for (const finding of body) entries.push({ body: finding });
  }
  reportKeyCost({ kind: "pass-table", pass, entries: entries.length });
  return passTableOf(entries);
}

/** `TEMPLATE_*` of a body's reference surface, each where the resources the
 *  body may reach make it hold. */
export function templateBodyFindings(inputs: TemplateBodyFindingsInputs): PassTable {
  const { union, graph } = inputs;
  const { space } = union;
  const logic: NameLogic<Condition> = {
    TRUE,
    FALSE,
    and: (a, b) => space.and(a, b),
    or: (a, b) => space.or(a, b),
    not: (a) => space.not(a),
    isFalse: (a) => a === FALSE,
  };
  // Every resource a run's list holds, by declaring module: each reading of a
  // call-graph resource node but a kind, module or import document.
  const instances = new Map<string | undefined, { name: string; held: Condition }[]>();
  // …and each such reading by name, which a body's `!ref` is kind-checked against.
  const referents = new Map<string | undefined, Map<string, { manifest: ResourceManifest; held: Condition }[]>>();
  const readings: ResourceManifest[] = [];
  for (const node of graph.nodes) {
    if (node.node.type !== "resource") continue;
    const manifest = graph.manifestOf(node.id);
    if (isKindDocument(manifest) || manifest.kind === "Telo.Import" || isModuleKind(manifest.kind)) continue;
    const module = (manifest.metadata as { module?: string } | undefined)?.module;
    const list = instances.get(module) ?? [];
    list.push({ name: node.node.name, held: node.condition });
    instances.set(module, list);
    let byName = referents.get(module);
    if (!byName) referents.set(module, (byName = new Map()));
    byName.set(node.node.name, [...(byName.get(node.node.name) ?? []), { manifest, held: node.condition }]);
    readings.push(manifest);
  }
  const callableSlots = callableSlotContextOf(readings, inputs.defs, inputs.aliases, inputs.aliasesByModule);
  return definitionTable(inputs, "templateBody", (manifests, part) => {
    const held = new Map<AnalysisDiagnostic, Condition>();
    const reach: TemplateBodyReach = {
      unknown: (module, target, siblings, candidates, suggest) => {
        if (siblings.includes(target)) return [];
        const present = instances.get(module) ?? [];
        const absent = space.not(space.some(present.filter((i) => i.name === target).map((i) => i.held)));
        if (absent === FALSE) return [];
        if (!suggest) return [{ suggestion: undefined, held: absent }];
        return nearestNameWhere(target, [...candidates.map((name) => ({ name, held: TRUE })), ...present], logic)
          .map(({ suggestion, held }) => ({ suggestion, held: space.and(absent, held) }))
          .filter(({ held }) => held !== FALSE);
      },
      referents: (module, target) => referents.get(module)?.get(target) ?? [],
      callableSlots,
      placed: (diagnostic, condition) => held.set(diagnostic, condition as Condition),
    };
    const template = part.template;
    const found = [
      ...validateTemplateBody(
        manifests,
        inputs.defs,
        inputs.aliases,
        inputs.aliasesByModule,
        inputs.rootModules,
        (m, path) => (template && m === part.manifests[0] ? inputs.bindingsAt(template, m, path) : []),
        reach,
        (m) => (template && m === part.manifests[0] ? inputs.writtenEntries(template.written) : undefined),
        (m) => m === part.manifests[0],
      ).filter(inputs.keep),
      ...(template ? inputs.spliceIssues(template) : []),
    ];
    return found.map((diagnostic) => ({ diagnostic, held: held.get(diagnostic) ?? TRUE }));
  });
}

/** `TEMPLATE_FORWARD_INCOMPATIBLE`: what a kind declares for a forwarded path
 *  read against the entry field, the same in every configuration. */
export function templateForwardFindings(
  inputs: Pick<
    TemplateBodyFindingsInputs,
    "union" | "parts" | "base" | "universe" | "bodyUnits" | "defs" | "aliases" | "aliasesByModule" | "rootModules" | "reads" | "isOwn"
  >,
): PassTable {
  return definitionTable(inputs, "templateForwards", (manifests) =>
    validateTemplateForwards(manifests, inputs.defs, inputs.aliases, inputs.aliasesByModule, inputs.rootModules).map(
      (diagnostic) => ({ diagnostic, held: TRUE }),
    ),
  );
}

/** The resource and referrer rules among each body's entries, judged where the
 *  body alone decides them (`judge`, over the definition its reading decides). */
export function templateRelationTable(
  inputs: Pick<TemplateBodyFindingsInputs, "union" | "parts" | "base" | "universe" | "bodyUnits" | "reads" | "isOwn">,
  judge: (definition: ResourceManifest) => readonly AnalysisDiagnostic[],
): PassTable {
  return definitionTable(inputs, "templateRelations", (manifests, part) =>
    judge(part.manifests[0]!).map((diagnostic) => ({ diagnostic, held: TRUE })),
  );
}
