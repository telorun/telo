/**
 * Passes over the whole application that carry presence conditions: each runs
 * once over the union of every configuration's expansion and answers its
 * findings with the condition each holds under, never once per configuration.
 *
 * A configuration run reads its findings back from the table the pass built
 * ({@link PassFindings.holdingAt}) — the table lists what the pass would find
 * in a configuration, in the raw form a run's own findings take, so they are
 * relocated and labelled the way every other finding of the run is.
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
import { moduleAliasScope } from "./module-alias-scope.js";
import type { Assignment } from "./configuration-dimensions.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import type { AnalysisDiagnostic } from "./types.js";
import { duplicateNameDiagnostic } from "./validate-references.js";
import { sinkUnattachedDiagnostic } from "./validate-sink-attachment.js";
import { observedStateRequiredDiagnostics } from "./validate-observed-state.js";
import { validateUnusedDeclarations } from "./validate-unused-declarations.js";

/** The whole-application passes that carry conditions. */
export type UnionPassName = "duplicateNames" | "unusedDeclarations" | "sinkAttachment" | "observedStateDeclarations";

/** One finding of a pass and the configurations it holds in. */
export interface PassFinding {
  readonly diagnostic: AnalysisDiagnostic;
  readonly condition: Condition;
}

/** What a pass finds over every configuration at once. */
export class PassFindings {
  constructor(
    private readonly space: ConditionSpace,
    readonly findings: readonly PassFinding[],
  ) {}

  /** The findings that hold in `assignment`, in the pass's order. */
  holdingAt(assignment: Assignment): AnalysisDiagnostic[] {
    return this.findings.filter((f) => this.space.holds(f.condition, assignment)).map((f) => f.diagnostic);
  }
}

/** The findings a configuration run reads back, by pass. */
export type PassFindingsAt = (pass: UnionPassName) => readonly AnalysisDiagnostic[];

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
 * Scope members are the run's: a member's place is a position of its holder's
 * projection.
 */
export function duplicateNameFindings(
  union: ConditionedExpansion,
  resources: readonly ResourceManifest[],
): PassFindings {
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
      list.forEach((first, i) => {
        const firstHolds = space.and(first.condition, space.not(before));
        before = space.or(before, first.condition);
        for (const dup of list.slice(i + 1)) {
          const condition = space.and(firstHolds, dup.condition);
          if (condition === FALSE) continue;
          const diagnostic = duplicateNameDiagnostic(dup.manifest, first.manifest, name, resources);
          if (diagnostic) findings.push({ diagnostic, condition });
        }
      });
    }
  }
  return new PassFindings(space, findings);
}

/**
 * `UNUSED_DECLARATION`: an Application input no expression reads. A run counts
 * every expression as written whichever branch it takes, so a read holds in
 * every configuration and so does the finding.
 */
export function unusedDeclarationFindings(
  space: ConditionSpace,
  written: readonly ResourceManifest[],
): PassFindings {
  return new PassFindings(
    space,
    validateUnusedDeclarations([...written]).map((diagnostic) => ({ diagnostic, condition: TRUE })),
  );
}

/**
 * `SINK_UNATTACHED` at module level: a present sink no present declaration
 * references, unless its module exports it. A reference is the call graph's:
 * each declaration is read by the graph builder as it stands under every
 * combination of choices a reference sits beneath, and an edge it finds holds
 * where that combination does and the sink is what its name resolves to in the
 * conditioned name index. A sink declared in a scope is the run's.
 */
export function sinkAttachmentFindings(
  union: ConditionedExpansion,
  names: ConditionedNameIndex,
  defs: DefinitionRegistry,
  aliases: AliasResolver,
  aliasesByModule: Map<string, AliasResolver> | undefined,
  rootModules: ReadonlySet<string>,
): PassFindings {
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
  if (sinks.length === 0) return new PassFindings(space, []);
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
  return new PassFindings(space, findings);
}

/**
 * `OBSERVED_STATE_REQUIRED_FORBIDDEN`: a kind document listing `required:` in
 * its `status:`. A kind's schema, contract and status are the same in every
 * configuration (a choice there is `BRANCH_POSITION_INVALID`), so the finding
 * holds in every one.
 */
export function observedStateDeclarationFindings(
  space: ConditionSpace,
  written: readonly ResourceManifest[],
): PassFindings {
  return new PassFindings(
    space,
    observedStateRequiredDiagnostics(written).map((diagnostic) => ({ diagnostic, condition: TRUE })),
  );
}
