/**
 * Passes over the whole application that carry presence conditions: each runs
 * once over the union of every configuration's expansion, plus once in each
 * branch no configuration takes, and never once per configuration.
 *
 * A pass's table lists its findings, each with the condition it holds under
 * and what it says there in the raw form a configuration's own finding takes
 * — rendered with a reader of where it holds, so a text naming what a choice
 * decides is split by that choice alone ({@link splitByReads}) — and what it
 * finds in each branch no configuration takes. The union world places each
 * where it is written (`union-placement.ts`). A finding inside a lifted
 * template body holds over the definition's own dimensions as well; the
 * analysis labels it from its condition and emits it once.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isRefSentinel } from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { buildCallGraph } from "./call-graph.js";
import { Alternatives, isAlternatives, type ConditionedDeclaration, type ConditionedExpansion } from "./conditioned-expansion.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { isForwardedDeclaration } from "./forwarded-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { injectedNeedOf } from "./need-type.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import type { FindingOrder } from "./finding-order.js";
import { duplicateNameDiagnostic } from "./validate-references.js";
import { sinkUnattachedDiagnostic } from "./validate-sink-attachment.js";
import { observedStateRequiredDiagnostics } from "./validate-observed-state.js";
import { validateUnusedDeclarations } from "./validate-unused-declarations.js";
import type { DeadBranchRun, WorldReader } from "./world-reader.js";
import { reportPassBranch } from "./cel-site-judgements.js";
import type { UnionPassName } from "./analysis-families.js";
export type { UnionPassName };

/** One finding of a pass over the configurations: where it holds, and what it
 *  says where `read` reads, in a run's raw form. */
export interface ReadFinding {
  readonly held: Condition;
  render(read: WorldReader<Condition>): readonly AnalysisDiagnostic[];
}

/** What a pass finds in one branch no configuration takes. */
export interface DeadFinding {
  readonly branch: DeadBranchRun;
  render(read: WorldReader<boolean>): readonly AnalysisDiagnostic[];
}

/** What a pass found: over the configurations, in each branch no
 *  configuration takes, and inside lifted template bodies. */
export interface PassTable {
  readonly found: readonly ReadFinding[];
  readonly dead: readonly DeadFinding[];
  /** Its findings inside lifted template bodies, which no configuration
   *  lists: each is labelled from its condition and emitted once. */
  readonly body?: readonly PassBodyFinding[];
}

/**
 * A pass's finding inside a lifted template body, as written: held where
 * `live` does — over the definition's own dimensions and the configurations —
 * or, found only in a branch no value the definition can be given takes
 * (`dead`), in the configurations `configuration` holds.
 */
export interface PassBodyFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly definition: ResourceManifest;
  readonly live?: Condition;
  readonly dead?: { readonly sentinel: object; readonly branch: string };
  /** The configurations it holds in: `live` with the definition's dimensions
   *  projected out. */
  readonly configuration: Condition;
}

/** One finding of a pass that reads nothing of where it holds. */
export interface PassFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly condition: Condition;
}

/** `found` as findings that read nothing of where they hold. */
export function fixedFindings(found: readonly PassFinding[]): ReadFinding[] {
  return found.map(({ diagnostic, condition }) => ({ held: condition, render: () => [diagnostic] }));
}

/** One entry of a pass's table: a finding held where its condition is, or
 *  one inside a lifted template body. */
export type PassEntry = PassFinding | { readonly body: PassBodyFinding };

/** A table of `entries`, which no branch no configuration takes varies. */
export function passTableOf(entries: readonly PassEntry[]): PassTable {
  const body: PassBodyFinding[] = [];
  const found: PassFinding[] = [];
  for (const entry of entries) {
    if ("body" in entry) body.push(entry.body);
    else found.push(entry);
  }
  return { found: fixedFindings(found), dead: [], body };
}

/** What `pass` finds in each branch no configuration takes, each read once. */
export function readDeadBranches(
  pass: UnionPassName,
  deadBranches: readonly DeadBranchRun[],
  find: (branch: DeadBranchRun) => readonly DeadFinding[],
): DeadFinding[] {
  return deadBranches.flatMap((branch) => {
    reportPassBranch(pass, branch);
    return find(branch);
  });
}

/** What `find` finds of `pass` in each branch no configuration takes, read
 *  once each, as it stands there. */
export function deadFindings(
  pass: UnionPassName,
  deadBranches: readonly DeadBranchRun[],
  find: (run: DeadBranchRun) => readonly AnalysisDiagnostic[],
): DeadFinding[] {
  return readDeadBranches(pass, deadBranches, (branch) => {
    const found = find(branch);
    return found.length === 0 ? [] : [{ branch, render: () => found }];
  });
}

/** What a pass finds over every configuration at once, the same in every
 *  template variant; a branch no configuration takes finds nothing of it
 *  inside the branch. */
export function fixedPassTable(found: readonly PassFinding[]): PassTable {
  return { found: fixedFindings(found), dead: [] };
}

/** One option of a choice a declaration holds, taken. */
type ChoiceTaken = { readonly alternatives: Alternatives; readonly option: number };

/**
 * A declaration as it stands under each combination of choices some reference
 * sits beneath, with the condition it holds under: the choices taken are
 * resolved to their options and every other choice is left out, so what the
 * graph reads off a view is exactly what that combination references.
 */
function referenceGroups(
  holder: ConditionedDeclaration,
  space: ConditionSpace,
): { view: ResourceManifest; condition: Condition }[] {
  const groups = new Map<string, { taken: ChoiceTaken[]; condition: Condition }>();
  const ids = new Map<object, number>();
  const idOf = (o: object): number => {
    let id = ids.get(o);
    if (id === undefined) ids.set(o, (id = ids.size));
    return id;
  };
  const visit = (value: unknown, taken: ChoiceTaken[], condition: Condition, seen: Set<object>): void => {
    if (condition === FALSE) return;
    if (isAlternatives(value)) {
      value.options.forEach((option, index) => {
        if (!option.present) return;
        visit(option.value, [...taken, { alternatives: value, option: index }], space.and(condition, option.condition), seen);
      });
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (isRefSentinel(value)) {
      const target = refSentinelTarget(value);
      if (!target || target.indexes.length > 0) return;
      const key = taken.map((t) => `${idOf(t.alternatives)}:${t.option}`).join(",");
      const group = groups.get(key) ?? { taken, condition: FALSE };
      group.condition = space.or(group.condition, condition);
      groups.set(key, group);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    for (const member of Array.isArray(value) ? value : Object.values(value)) visit(member, taken, condition, seen);
    seen.delete(value);
  };
  visit(holder.manifest, [], holder.condition, new Set());
  return [...groups.values()].map(({ taken, condition }) => ({
    view: resolvedView(holder.manifest, new Map(taken.map((t) => [t.alternatives, t.option]))) as ResourceManifest,
    condition,
  }));
}

/** `value` with the choices in `taken` resolved to their option and every
 *  other choice replaced by null; what holds no choice is shared. */
function resolvedView(value: unknown, taken: ReadonlyMap<Alternatives, number>, seen = new Set<object>()): unknown {
  if (isAlternatives(value)) {
    const index = taken.get(value);
    return index === undefined ? null : resolvedView(value.options[index]!.value, taken, seen);
  }
  if (value === null || typeof value !== "object" || isRefSentinel(value) || seen.has(value)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => resolvedView(item, taken, seen));
      return items.some((item, i) => item !== value[i]) ? items : value;
    }
    let copy: Record<string | symbol, unknown> | undefined;
    for (const key of Reflect.ownKeys(value)) {
      const member = (value as Record<string | symbol, unknown>)[key];
      const resolved = resolvedView(member, taken, seen);
      if (resolved !== member) (copy ??= { ...value })[key] = resolved;
    }
    return copy ?? value;
  } finally {
    seen.delete(value);
  }
}

/** A declaration of one name with the configurations it is declared in. */
interface DuplicateCandidate {
  readonly manifest: ResourceManifest;
  condition: Condition;
}

const present = (declaration: ConditionedDeclaration): boolean => declaration.condition !== FALSE && !declaration.unreachable;

/**
 * `DUPLICATE_RESOURCE_NAME` between declarations at module level: two present
 * declarations of one name in one module, reported at the later against the
 * earliest present — in the configurations holding both and no earlier one.
 * Collisions inside a scope are judged with the scope's members
 * (`scope-member-findings.ts`).
 */
export function duplicateNameFindings(
  union: ConditionedExpansion,
  order: FindingOrder,
): PassTable {
  const { space } = union;
  const moduleOf = (r: ResourceManifest): string | undefined => (r.metadata as { module?: string } | undefined)?.module;
  const declarations = union.declarations.filter(present);
  const moduleDocNames = new Set<string>();
  const stampedModules = new Set<string>();
  for (const { manifest: r } of declarations) {
    if (isModuleKind(r.kind) && typeof r.metadata?.name === "string") moduleDocNames.add(r.metadata.name);
    const m = moduleOf(r);
    if (m) stampedModules.add(m);
  }
  // scope → name → candidates in written order, a pipeline echo one candidate.
  const byScope = new Map<string, Map<string, (DuplicateCandidate & { fingerprint: string })[]>>();
  for (const { manifest: r, condition } of declarations) {
    if (!r.metadata?.name || isForwardedDeclaration(r)) continue;
    if ((r.metadata as { xTeloChoice?: unknown }).xTeloChoice) continue;
    // A need's collision is the need table's, at its `needs:` key.
    if (injectedNeedOf(r)) continue;
    const name = r.metadata.name as string;
    const module = isModuleKind(r.kind) ? (stampedModules.has(name) ? name : "") : (moduleOf(r) ?? "");
    if (module !== "" && moduleDocNames.size > 0 && !moduleDocNames.has(module)) continue;
    const meta = r.metadata as unknown as { source?: string; sourceLine?: number };
    const fingerprint = `${r.kind} ${name} ${meta.source} ${meta.sourceLine}`;
    let names = byScope.get(module);
    if (!names) byScope.set(module, (names = new Map()));
    const list = names.get(name) ?? [];
    names.set(name, list);
    const echo = list.find((c) => c.fingerprint === fingerprint);
    if (echo) {
      echo.condition = space.or(echo.condition, condition);
      continue;
    }
    list.push({ manifest: r, condition, fingerprint });
  }
  const findings: PassFinding[] = [];
  for (const names of byScope.values()) {
    for (const [name, list] of names) {
      if (list.length <= 1) continue;
      let before = FALSE as Condition;
      // The earliest as written is the one the others collide with.
      order.sortBy(list, (a, b) => order.compareDeclarations(a.manifest, b.manifest)).forEach((first, i) => {
        const firstHolds = space.and(first.condition, space.not(before));
        before = space.or(before, first.condition);
        for (const dup of list.slice(i + 1)) {
          const condition = space.and(firstHolds, dup.condition);
          if (condition === FALSE) continue;
          const diagnostic = duplicateNameDiagnostic(dup.manifest, first.manifest, name);
          if (diagnostic) findings.push({ diagnostic, condition });
        }
      });
    }
  }
  return fixedPassTable(findings);
}

/**
 * `UNUSED_DECLARATION`: an Application input no expression reads. A run counts
 * every expression as written whichever branch it takes, so a read holds in
 * every configuration and so does the finding.
 */
export function unusedDeclarationFindings(written: readonly ResourceManifest[]): PassTable {
  return fixedPassTable(validateUnusedDeclarations([...written]).map((diagnostic) => ({ diagnostic, condition: TRUE })));
}

/**
 * `SINK_UNATTACHED` at module level: a present sink no present declaration
 * references, unless its module exports it. A reference is the call graph's:
 * each declaration is read by the graph builder as it stands under every
 * combination of choices a reference sits beneath, and an edge it finds holds
 * where that combination does and the sink is what its name resolves to in the
 * conditioned name index. A sink declared in a scope is judged with the
 * scope's members (`scope-member-findings.ts`).
 */
export function sinkAttachmentFindings(
  union: ConditionedExpansion,
  names: ConditionedNameIndex,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  rootModules: ReadonlySet<string>,
): PassTable {
  const { space } = union;
  const exported = new Map<string, Set<string>>();
  for (const { manifest: m } of union.declarations) {
    if (m.kind !== "Telo.Library") continue;
    const list = (m as { exports?: { resources?: unknown } }).exports?.resources;
    if (Array.isArray(list)) exported.set(m.metadata?.name as string, new Set(list.filter((n) => typeof n === "string")));
  }
  const sinks: ConditionedDeclaration[] = [];
  for (const declaration of union.declarations) {
    const m = declaration.manifest;
    if (!present(declaration) || typeof m.kind !== "string") continue;
    const module = (m.metadata as { module?: string } | undefined)?.module;
    if (module !== undefined && !rootModules.has(module)) continue;
    const canonical = moduleAliasScope(m.metadata, aliases, aliasesByModule).resolveKind(m.kind) ?? m.kind;
    const definition = defs.resolve(canonical);
    if (definition?.kind === "Telo.Abstract" || definition?.capability !== "Telo.Sink") continue;
    const name = m.metadata?.name as string | undefined;
    if (!name || (module !== undefined && exported.get(module)?.has(name))) continue;
    sinks.push(declaration);
  }
  if (sinks.length === 0) return fixedPassTable([]);
  // Where each sink is referenced: the call graph's edges into it, read off
  // each declaration as it stands in each combination of choices it holds.
  const attached = new Map<ResourceManifest, Condition>();
  for (const holder of union.declarations) {
    if (!present(holder) || isKindDocumentOrImport(holder.manifest)) continue;
    const module = (holder.manifest.metadata as { module?: string } | undefined)?.module;
    for (const group of referenceGroups(holder, space)) {
      const graph = buildCallGraph([group.view], defs, { aliases, aliasesByModule });
      for (const edge of graph.edges) {
        if (edge.moduleCall || edge.scoped || (edge.alias !== undefined && edge.alias !== "Self")) continue;
        // The view holds `!ref` sentinels, whose edge names the text as written.
        const local = edge.toName.startsWith("Self.") ? edge.toName.slice("Self.".length) : edge.toName;
        for (const { outcome, condition: held } of names.locate("local", local, module)) {
          if (outcome.status !== "resolved") continue;
          const target = outcome.declaration as ResourceManifest;
          attached.set(target, space.or(attached.get(target) ?? FALSE, space.and(group.condition, held)));
        }
      }
    }
  }
  const findings: PassFinding[] = [];
  for (const sink of sinks) {
    const condition = space.and(sink.condition, space.not(attached.get(sink.manifest) ?? FALSE));
    if (condition === FALSE) continue;
    findings.push({ diagnostic: sinkUnattachedDiagnostic(sink.manifest, false), condition });
  }
  return fixedPassTable(findings);
}

/**
 * `OBSERVED_STATE_REQUIRED_FORBIDDEN`: a kind document listing `required:` in
 * its `status:`. A kind's schema, contract and status are the same in every
 * configuration (a choice there is `BRANCH_POSITION_INVALID`), so the finding
 * holds in every one.
 */
export function observedStateDeclarationFindings(written: readonly ResourceManifest[]): PassTable {
  return fixedPassTable(observedStateRequiredDiagnostics(written).map((diagnostic) => ({ diagnostic, condition: TRUE })));
}
