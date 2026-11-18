/**
 * RESOURCE RULES AS A RELATION GROUP: a kind's `x-telo-resource-rules` judged
 * per declaration, from the places its rules read and — by name — in the
 * declarations their `resolve:` pointers reach, never from the declaration
 * whole. The group's reader (`analyzer.ts`) finds the instance; this file is
 * its judge and the reports a run makes of what the judge found.
 *
 * A finding about the rule itself (it threw, or ran out of budget) and the
 * fact of whether a rule met anything to iterate ride as carriers: the run
 * that places an instance's findings turns them into one report per rule, as
 * the analysis does — `RuleFailureLedger` for the first, the unexercised
 * report for the second.
 *
 * Browser-safe.
 */
import { inFamily } from "./analysis-families.js";
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { ModuleCallDispatch } from "@telorun/templating";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { buildCallGraph, nodeIdFor } from "./call-graph.js";
import type { ReachEnv } from "./reachable-walk.js";
import { stepBodiesOf } from "./step-bodies.js";
import type { DeclarationRequests } from "./declaration-requests.js";
import { reportRuleEvaluation } from "./cel-site-judgements.js";
import { governedCelEvalSites, type CelEvalSites } from "./eval-paths.js";
import type { DefResolver } from "./extends-resolution.js";
import { definitionInScope } from "./module-alias-scope.js";
import { analyzerPeerBinder, analyzerWritingModules, type PeerBinder } from "./peer-binding.js";
import { withQuotedPath } from "./quoted-place.js";
import { RuleFailureLedger } from "./rule-condition.js";
import { RuleDeclarationViews, type ForwardedReference } from "./rule-declaration-view.js";
import { resolvedReference } from "./resolved-reference.js";
import { RESOURCE_RULES_ANNOTATION, declaredResourceRules, readResourceRules, type ResourceRule } from "./resource-rule.js";
import type { RelationDoor, RelationFinding, DeclarationIdentity } from "./relation-sites.js";
import { importPathOf, importPathThrough } from "./scoped-name-resolver.js";
import {
  evaluateResourceRules,
  reportResourceRules,
  reportUnexercisedRule,
  ruleExercised,
  type CoReferrer,
  type CoReferrerGroup,
  type ResourceRuleDiagnostic,
} from "./validate-resource-rules.js";
import { compareCodePoints, type FindingOrder, type Place } from "./finding-order.js";
import { FALSE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { kindSatisfies } from "./validate-references.js";

const SOURCE = "telo-analyzer";

/** The code of a carrier: a report only the run that places the instance can
 *  settle. */
export const RESOURCE_RULE_REPORT = "RESOURCE_RULE_REPORT";

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
} as const;

/** A finding about a rule itself, or whether a rule met anything: the
 *  declaring kind and rule it is keyed by, and the report it stands for. */
export interface RuleReport {
  readonly type: "failure" | "exercise";
  /** The declaring kind and rule — what `RuleFailureLedger` and the exercise
   *  tally are keyed by. */
  readonly key: string;
  readonly rule: string;
  /** The declaring module, to anchor a failure at the import reaching it. */
  readonly module: string | undefined;
  readonly exercised?: boolean;
  readonly report: {
    readonly code: string;
    readonly severity: "error" | "warning" | "information";
    readonly message: string;
    readonly definition: { readonly kind: string; readonly name: string; readonly source: string | undefined };
    readonly path: string | undefined;
  };
}

/**
 * One referrer rule's verdict at one slot, as only the run placing it can
 * settle: a rule judges a referrer once however many of its slots reach the
 * resource (`once`) and stops at its first failure on one resource
 * (`subject`), and is exercised where it met a referrer. The diagnostics it
 * decides are written beside it, each marked with its `claim`.
 */
export interface ReferrerVerdict {
  readonly type: "referrer";
  readonly claim: string;
  /** Where the referrer writes the reference: the order verdicts settle in. */
  readonly at: Place;
  /** The resource and rule the verdict is about. */
  readonly subject: string;
  /** The referrer the verdict is the whole of; absent for a per-entry rule. */
  readonly once?: string;
  /** The exercise tally entry, for a rule of the entry's own modules. */
  readonly exercise?: { readonly key: string; readonly exercised: boolean; readonly violated: boolean };
  /** The rule's failure on this referrer. */
  readonly failure?: RuleReport;
}

/** The scope a rule reads declarations in. */
export type RuleDoor = Pick<
  RelationDoor,
  "defs" | "aliases" | "aliasesByModule" | "rootModules" | "libraries" | "requests" | "declared" | "moduleNames" | "subject" | "functions"
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The binder a rule resolves its references through, over the door's requests. */
export function binderOf(door: RuleDoor): PeerBinder {
  const { defs, aliases, aliasesByModule, requests, libraries, rootModules } = door;
  const sites = new WeakMap<object, CelEvalSites | undefined>();
  const writing = analyzerWritingModules(rootModules, aliasesByModule, requests.names, libraries);
  const forwardedKind = (kind: string, owner: string): string | undefined =>
    kind.startsWith("Self.") ? `${owner}.${kind.slice("Self.".length)}` : aliasesByModule.get(owner)?.resolveKind(kind);
  const forwardedReference: ForwardedReference = (target, module, writer) => {
    const local = target.alias === undefined || target.alias === "Self";
    const owner = local ? module : writing.moduleForAlias(module, target.alias!);
    const instance = local ? importPathOf(writer) : importPathThrough(writer, target.alias!);
    const declaration = owner === undefined ? undefined : writing.declaredIn(owner, target.name, instance);
    if (!owner || !declaration || typeof declaration.kind !== "string") return undefined;
    const kind = forwardedKind(declaration.kind, owner) ?? declaration.kind;
    return resolvedReference(kind, target.name, local ? undefined : target.alias);
  };
  const views = new RuleDeclarationViews(
    (declaration, module) => {
      const definition = definitionInScope(defs, declaration.kind, { module }, aliases, aliasesByModule) as unknown as ResourceDefinition | undefined;
      if (!definition) return undefined;
      if (!sites.has(definition)) sites.set(definition, governedCelEvalSites(definition, defs, defs.shapeLookup));
      return { sites: sites.get(definition) };
    },
    forwardedReference,
    forwardedKind,
    writing.isDependency,
  );
  return analyzerPeerBinder(
    defs,
    aliases,
    requests,
    (slotKinds, declarationKind) => slotKinds.some((target) => kindSatisfies(declarationKind, target, defs)),
    (declaration) => views.of(declaration),
    writing,
    reachEnvOf(door, writing.isDependency),
  );
}

/** What a `reachable:` walk reads of the registry: canonical kinds read in the
 *  scope of the module that wrote them, the subtype index, and each
 *  declaration's step `invoke:` slots from the call graph's own step walk. */
function reachEnvOf(door: RuleDoor, isDependency: (module: string) => boolean): ReachEnv {
  const { defs, aliases, aliasesByModule } = door;
  const descendants = new Map<string, ReadonlySet<string>>();
  return {
    canonicalKind: (declaration, writer) => {
      if (typeof declaration.kind !== "string") return undefined;
      const metadata = (declaration.metadata ?? writer.metadata) as { module?: unknown } | undefined;
      const definition = definitionInScope(defs, declaration.kind, metadata, aliases, aliasesByModule);
      return definition ? kindOf(definition) : undefined;
    },
    isKindOf: (candidate, ancestor) => {
      if (candidate === ancestor) return true;
      let below = descendants.get(ancestor);
      if (!below) descendants.set(ancestor, (below = new Set(defs.getByExtends(ancestor).map(kindOf))));
      return below.has(candidate);
    },
    isDependency,
    stepSlotsOf: (declaration, kind, writer) => {
      const definition = defs.resolve(kind);
      const schema = definition ? (defs.effectiveSchemaOf(definition) as Record<string, any> | undefined) : undefined;
      if (!schema || stepBodiesOf(declaration, schema).length === 0) return [];
      const metadata = (declaration.metadata ?? {}) as Record<string, unknown>;
      // An inline declaration is read as one of the module that wrote it.
      const probe = {
        ...declaration,
        kind,
        metadata: {
          ...(writer.metadata as Record<string, unknown> | undefined),
          ...metadata,
          name: typeof metadata.name === "string" ? metadata.name : `${String(writer.metadata?.name ?? "")}#inline`,
        },
      } as unknown as ResourceManifest;
      const graph = buildCallGraph([probe], defs, { aliases, aliasesByModule });
      return graph
        .steps(nodeIdFor(probe))
        .flatMap((step) => (step.refSlots ?? []).map((slot) => ({ path: slot.path, kinds: slot.kinds, uses: slot.uses })));
    },
  };
}

/** The groups a `coReferrers:` rule binds, built once per (declaring kind and
 *  rule, slot, target) for every request set — one per analysis, or per key. */
const coReferrerGroupsOf = new WeakMap<DeclarationRequests, Map<string, readonly CoReferrer[]>>();

const kindOf = (definition: ResourceDefinition): string => {
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  return module ? `${module}.${definition.metadata?.name}` : String(definition.metadata?.name);
};

/**
 * The declarations a rule of `declarer` judges that reach a target through a
 * slot: the target's referrers through exactly that slot whose kind is judged
 * by that rule — the declaring kind, or a descendant inheriting its rules.
 */
function coReferrerGroups(door: RuleDoor, declarer: ResourceDefinition, ruleDef: DefResolver): CoReferrerGroup {
  let cache = coReferrerGroupsOf.get(door.requests);
  if (!cache) coReferrerGroupsOf.set(door.requests, (cache = new Map()));
  const groups = cache;
  const declaring = kindOf(declarer);
  const judged = new Map<string, boolean>();
  const judgedBy = (m: ResourceManifest, rule: ResourceRule): boolean => {
    // A kind is spelled in its declaring module's aliases.
    const key = `${(m.metadata as { module?: string } | undefined)?.module ?? ""}\0${m.kind}\0${rule.code}`;
    const known = judged.get(key);
    if (known !== undefined) return known;
    const declared = door.declared({ identityOnly: true, kind: m.kind, metadata: (m.metadata ?? {}) as Record<string, unknown> });
    const holds =
      declared.status === "ok" &&
      declaredResourceRules(declared.definition, ruleDef).some(
        (group) => kindOf(group.declarer) === declaring && group.rules.some((each) => each.code === rule.code),
      );
    judged.set(key, holds);
    return holds;
  };
  return (rule, self, target, slot) => {
    const key = `${declaring}#${rule.code}\0${slot}\0${nodeIdFor(target)}`;
    let group = groups.get(key);
    if (!group) {
      const seen = new Set<ResourceManifest>();
      const found: CoReferrer[] = [];
      for (const referrer of door.requests.referrersOf(target)) {
        if (referrer.path !== slot || seen.has(referrer.manifest) || !judgedBy(referrer.manifest, rule)) continue;
        seen.add(referrer.manifest);
        found.push({ manifest: referrer.manifest, kind: referrer.manifest.kind });
      }
      groups.set(key, (group = found));
    }
    const own = nodeIdFor(self);
    return group.filter((other) => nodeIdFor(other.manifest) !== own);
  };
}

function ruleDiagnostic(report: ResourceRuleDiagnostic): AnalysisDiagnostic {
  const diagnostic: AnalysisDiagnostic = {
    severity: SEVERITY[report.severity],
    code: report.code,
    source: SOURCE,
    message: report.message,
    data: {
      resource: { kind: report.manifest.kind, name: report.manifest.metadata?.name as string },
      filePath: (report.manifest.metadata as { source?: string } | undefined)?.source,
      path: report.path,
      rule: report.rule,
    },
  };
  return report.path === undefined ? diagnostic : withQuotedPath(diagnostic, report.path);
}

/** A rule report as a carrier holds it, reported at `owner`. */
function describedAt(owner: ResourceManifest, report: ResourceRuleDiagnostic): RuleReport["report"] {
  return {
    code: report.code,
    severity: report.severity,
    message: report.message,
    definition: { kind: owner.kind, name: owner.metadata?.name as string, source: (owner.metadata as { source?: string } | undefined)?.source },
    path: report.path,
  };
}

/** The reports a declaration's kind makes of it: each violation and skip, and
 *  the carriers of a rule's failure and of whether each rule the entry
 *  declares met anything to iterate. Each rule is judged as its DECLARER's —
 *  the kind along `extends` that wrote it: its conditions call that kind's
 *  module, and a defect in it is that kind's. */
export function resourceRuleFindings(identity: DeclarationIdentity, door: RuleDoor): RelationFinding[] {
  const declared = door.declared(identity);
  if (declared.status !== "ok") return [];
  const { defs, aliases } = door;
  const ruleDef: DefResolver = (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
  const groups = declaredResourceRules(declared.definition, ruleDef);
  if (groups.length === 0) return [];
  const definition = declared.definition as unknown as ResourceManifest;
  const module = (definition.metadata as { module?: string } | undefined)?.module;
  const subject = door.subject();
  reportRuleEvaluation("resourceRules", false);
  const binder = binderOf(door);
  const out: RelationFinding[] = [];
  const definitionName = definition.metadata?.name as string;
  for (const group of groups) {
    const declarer = group.declarer as unknown as ResourceManifest;
    const declarerModule = (declarer.metadata as { module?: string } | undefined)?.module;
    const declarerName = declarer.metadata?.name as string;
    const declarerIdentity = { identityOnly: true as const, kind: declarer.kind, metadata: (declarer.metadata ?? {}) as Record<string, unknown> };
    const findings = evaluateResourceRules(
      subject,
      group.rules,
      door.moduleNames(declarerIdentity),
      door.functions(group.declarer),
      binder,
      subject.kind,
      coReferrerGroups(door, group.declarer, ruleDef),
    );
    for (const report of reportResourceRules(subject, declarer, findings, !declarerModule || door.rootModules.has(declarerModule))) {
      if (report.evaluationFailure) {
        out.push({
          diagnostic: ruleCarrier(subject, {
            type: "failure",
            key: `resource\u0000${declarerModule ?? ""}.${declarerName}`,
            rule: report.rule,
            module: declarerModule,
            report: describedAt(declarer, report),
          }),
          judgedAt: "",
        });
        continue;
      }
      out.push({ diagnostic: ruleDiagnostic(report), judgedAt: report.path ?? "" });
    }
  }
  // The rules the entry declares itself are tallied: a rule that met nothing
  // to iterate on any resource of its kind is one nothing proved.
  if (!module || door.rootModules.has(module)) {
    for (const rule of readResourceRules((definition as Record<string, unknown>).schema)) {
      out.push({
        diagnostic: ruleCarrier(subject, {
          type: "exercise",
          key: `${module}.${definitionName}#${rule.code}`,
          rule: rule.code,
          module,
          exercised: ruleExercised(subject, rule, binder, subject.kind),
          report: describedAt(definition, reportUnexercisedRule(definition, rule)),
        }),
        judgedAt: "",
      });
    }
  }
  return out;
}

/** A lazy dispatch: the function table is built on the first call a condition makes. */
export class LazyDispatch extends Map<string, (...args: any[]) => unknown> {
  constructor(private readonly table: () => ModuleCallDispatch) {
    super();
  }

  override get(qualified: string) {
    return this.table().get(qualified);
  }

  override has(qualified: string): boolean {
    return this.table().has(qualified);
  }
}

/** Where a carrier's verdict marks a diagnostic it decides. */
export const RULE_CLAIM = "ruleClaim";

/** A carrier of `report`, about `subject`. */
export function ruleCarrier(subject: ResourceManifest, report: RuleReport | ReferrerVerdict, path?: string): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Hint,
    code: RESOURCE_RULE_REPORT,
    source: SOURCE,
    message: "",
    data: {
      resource: { kind: subject.kind, name: subject.metadata?.name as string },
      filePath: (subject.metadata as { source?: string } | undefined)?.source,
      ...(path === undefined ? {} : { path }),
      ruleReport: report,
    },
  };
}

/**
 * What one run makes of the rule carriers its instances' findings hold: a
 * failing rule once per declaring kind, anchored at the `imports:` entry that
 * brought the kind in when it is a dependency's, a referrer rule's verdict on
 * a referrer once, and — once the run is over — the rules no instance of it
 * exercised: a resource rule's tallied by its instances, a referrer rule's
 * wherever a resource of its kind was seen.
 */
export class RuleReports {
  private readonly ledger = new RuleFailureLedger();
  private readonly tally = new Map<string, { exercised: boolean; report: RuleReport }>();
  private readonly referrerTally = new Map<string, { exercised: boolean; seen?: { order: number; report: AnalysisDiagnostic } }>();
  private readonly claims = new Map<string, boolean>();
  private readonly judged = new Set<string>();
  private readonly stopped = new Set<string>();

  constructor(
    private readonly anchorOf: (module: string) => { filePath?: string; path: string } | undefined,
    private readonly order: FindingOrder,
  ) {}

  /** `diagnostics` with each carrier replaced by what it stands for, and each
   *  diagnostic a referrer verdict claims kept only where the verdict holds. */
  settle(diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] {
    return this.settleGroups([diagnostics])[0]!;
  }

  /**
   * {@link settle} over several lists at once. The carriers of every list are
   * decided together, in the order they are written — a verdict that failed
   * stops the later ones on its resource, and the first failure of a rule is
   * the one reported — and only then is each list read: a carrier's own
   * replacement and every claimed diagnostic kept or dropped by what was
   * decided, in the list's order.
   */
  settleGroups(groups: readonly (readonly AnalysisDiagnostic[])[]): AnalysisDiagnostic[][] {
    const carriers: AnalysisDiagnostic[] = [];
    for (const group of groups) for (const d of group) if (carrierOf(d)) carriers.push(d);
    const replaced = new Map<AnalysisDiagnostic, AnalysisDiagnostic[]>();
    const carrierText = (d: AnalysisDiagnostic): string => {
      const found = carrierOf(d)!;
      return found.type === "referrer" ? found.claim : `${found.key}\0${found.rule}`;
    };
    const ordered = carriers
      .map((d, index) => ({ d, index }))
      .sort((a, b) => this.order.compare(a.d, b.d) || compareCodePoints(carrierText(a.d), carrierText(b.d)) || a.index - b.index);
    for (const { d } of ordered) replaced.set(d, this.decide(carrierOf(d)!));
    return groups.map((group) => {
      const out: AnalysisDiagnostic[] = [];
      for (const diagnostic of group) {
        const data = diagnostic.data as { [RULE_CLAIM]?: string } | undefined;
        const claim = data?.[RULE_CLAIM];
        if (claim !== undefined) {
          if (!this.claims.get(claim)) continue;
          const { [RULE_CLAIM]: _claim, ...rest } = data as Record<string, unknown>;
          out.push({ ...diagnostic, data: rest as typeof diagnostic.data });
          continue;
        }
        const replacement = replaced.get(diagnostic);
        if (replacement) out.push(...replacement);
        else if (!carrierOf(diagnostic)) out.push(diagnostic);
      }
      return out;
    });
  }

  /**
   * {@link settleGroups} over findings each holding under a condition: the
   * carriers decided in the order they are written, each where no earlier one
   * decided otherwise, and every claimed diagnostic kept where its verdict
   * held. `exercised` is where an instance of each resource rule was settled.
   */
  settleConditioned<T extends { readonly diagnostic: AnalysisDiagnostic; readonly condition: Condition }>(
    findings: readonly T[],
    space: ConditionSpace,
  ): { diagnostic: AnalysisDiagnostic; condition: Condition; from: T }[] {
    const carrierText = (d: AnalysisDiagnostic): string => {
      const found = carrierOf(d)!;
      return found.type === "referrer" ? found.claim : `${found.key}\0${found.rule}`;
    };
    const ordered = findings
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => carrierOf(f.diagnostic) !== undefined)
      .sort((a, b) => this.order.compare(a.f.diagnostic, b.f.diagnostic) || compareCodePoints(carrierText(a.f.diagnostic), carrierText(b.f.diagnostic)) || a.index - b.index);
    const ledger = new Map<string, Condition>();
    const stopped = new Map<string, Condition>();
    const judged = new Map<string, Condition>();
    const claims = new Map<string, Condition>();
    const out: { diagnostic: AnalysisDiagnostic; condition: Condition; from: T }[] = [];
    const failure = (found: RuleReport, condition: Condition, from: T): void => {
      const key = `${found.key}\u0000${found.rule}`;
      const before = ledger.get(key) ?? FALSE;
      ledger.set(key, space.or(before, condition));
      const held = space.and(condition, space.not(before));
      if (held === FALSE) return;
      for (const diagnostic of this.failureDiagnostics(found)) out.push({ diagnostic, condition: held, from });
    };
    for (const { f } of ordered) {
      const found = carrierOf(f.diagnostic)!;
      if (found.type === "exercise") {
        this.exercised.set(found.key, space.or(this.exercised.get(found.key) ?? FALSE, f.condition));
        continue;
      }
      if (found.type !== "referrer") {
        failure(found, f.condition, f);
        continue;
      }
      claims.set(found.claim, space.and(claims.get(found.claim) ?? FALSE, space.not(f.condition)));
      let held = space.and(f.condition, space.not(stopped.get(found.subject) ?? FALSE));
      if (found.once !== undefined) {
        const before = judged.get(found.once) ?? FALSE;
        judged.set(found.once, space.or(before, held));
        held = space.and(held, space.not(before));
      }
      if (held === FALSE) continue;
      if (found.failure) {
        stopped.set(found.subject, space.or(stopped.get(found.subject) ?? FALSE, held));
        failure(found.failure, held, f);
      } else {
        claims.set(found.claim, space.or(claims.get(found.claim) ?? FALSE, held));
      }
    }
    for (const f of findings) {
      if (carrierOf(f.diagnostic)) continue;
      const data = f.diagnostic.data as { [RULE_CLAIM]?: string } | undefined;
      const claim = data?.[RULE_CLAIM];
      if (claim === undefined) {
        out.push({ diagnostic: f.diagnostic, condition: f.condition, from: f });
        continue;
      }
      const held = space.and(f.condition, claims.get(claim) ?? FALSE);
      if (held === FALSE) continue;
      const { [RULE_CLAIM]: _claim, ...rest } = data as Record<string, unknown>;
      out.push({ diagnostic: { ...f.diagnostic, data: rest as typeof f.diagnostic.data }, condition: held, from: f });
    }
    return out;
  }

  /** Where an instance of each resource rule was settled by {@link settleConditioned}. */
  readonly exercised = new Map<string, Condition>();

  private decide(found: RuleReport | ReferrerVerdict): AnalysisDiagnostic[] {
    if (found.type === "referrer") return this.referrerVerdict(found);
    if (found.type === "exercise") {
      const known = this.tally.get(found.key);
      if (known) known.exercised ||= found.exercised === true;
      else this.tally.set(found.key, { exercised: found.exercised === true, report: found });
      return [];
    }
    return this.failure(found);
  }

  /** A resource of a kind declaring the referrer rule tallied at `key` holds
   *  in the run: the rule is unexercised, reported as `report`, unless a
   *  referrer exercises it. */
  seen(key: string, order: number, report: AnalysisDiagnostic): void {
    const known = this.referrerTally.get(key);
    if (known) known.seen ??= { order, report };
    else this.referrerTally.set(key, { exercised: false, seen: { order, report } });
  }

  /** The unexercised report of every tallied rule no instance exercised. */
  unexercised(): AnalysisDiagnostic[] {
    const referrer = [...this.referrerTally.values()]
      .filter((each) => !each.exercised && each.seen)
      .sort((a, b) => a.seen!.order - b.seen!.order)
      .map((each) => each.seen!.report);
    return inFamily("ruleAbsence", [...[...this.tally.values()].filter((each) => !each.exercised).map((each) => ruleReportDiagnostic(each.report)), ...referrer]);
  }

  private referrerVerdict(found: ReferrerVerdict): AnalysisDiagnostic[] {
    const exercise = (exercised: boolean): void => {
      if (!found.exercise) return;
      const known = this.referrerTally.get(found.exercise.key);
      if (known) known.exercised ||= exercised;
      else this.referrerTally.set(found.exercise.key, { exercised });
    };
    exercise(found.exercise?.exercised === true);
    this.claims.set(found.claim, false);
    if (this.stopped.has(found.subject)) return [];
    if (found.once !== undefined) {
      if (this.judged.has(found.once)) return [];
      this.judged.add(found.once);
    }
    if (found.failure) {
      this.stopped.add(found.subject);
      return this.failure(found.failure);
    }
    this.claims.set(found.claim, true);
    // A rule that violated plainly ran, whatever its peer set held.
    exercise(found.exercise?.violated === true);
    return [];
  }

  private failure(found: RuleReport): AnalysisDiagnostic[] {
    if (!this.ledger.first(found.key, found.rule)) return [];
    return this.failureDiagnostics(found);
  }

  private failureDiagnostics(found: RuleReport): AnalysisDiagnostic[] {
    const anchor = found.module ? this.anchorOf(found.module) : undefined;
    return [
      anchor
        ? {
            severity: SEVERITY[found.report.severity],
            code: found.report.code,
            source: SOURCE,
            message: found.report.message,
            data: { filePath: anchor.filePath, path: anchor.path, rule: found.rule },
          }
        : ruleReportDiagnostic(found),
    ];
  }
}

function carrierOf(d: AnalysisDiagnostic): RuleReport | ReferrerVerdict | undefined {
  const found = (d.data as { ruleReport?: RuleReport | ReferrerVerdict } | undefined)?.ruleReport;
  return d.code === RESOURCE_RULE_REPORT ? found : undefined;
}

/** A rule's report at the declaration of the kind declaring it. */
export function ruleReportDiagnostic(found: RuleReport): AnalysisDiagnostic {
  const { report } = found;
  const diagnostic: AnalysisDiagnostic = {
    severity: SEVERITY[report.severity],
    code: report.code,
    source: SOURCE,
    message: report.message,
    data: {
      resource: { kind: report.definition.kind, name: report.definition.name },
      filePath: report.definition.source,
      path: report.path,
      rule: found.rule,
    },
  };
  return report.path === undefined ? diagnostic : withQuotedPath(diagnostic, report.path);
}

export { RESOURCE_RULES_ANNOTATION };
