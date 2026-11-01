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
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import type { ModuleCallDispatch } from "@telorun/templating";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { reportRuleEvaluation } from "./cel-site-judgements.js";
import { governedCelEvalSites, type CelEvalSites } from "./eval-paths.js";
import type { DefResolver } from "./extends-resolution.js";
import { definitionInScope } from "./module-alias-scope.js";
import { analyzerPeerBinder, analyzerWritingModules, type PeerBinder } from "./peer-binding.js";
import { withQuotedPath } from "./quoted-place.js";
import { RuleFailureLedger } from "./rule-condition.js";
import { RuleDeclarationViews, type ForwardedReference } from "./rule-declaration-view.js";
import { resolvedReference } from "./resolved-reference.js";
import { RESOURCE_RULES_ANNOTATION, declaredResourceRules, readResourceRules } from "./resource-rule.js";
import type { RelationDoor, RelationFinding, DeclarationIdentity } from "./relation-sites.js";
import { importPathOf, importPathThrough } from "./scoped-name-resolver.js";
import {
  evaluateResourceRules,
  reportResourceRules,
  reportUnexercisedRule,
  ruleExercised,
  type ResourceRuleDiagnostic,
} from "./validate-resource-rules.js";
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

/** What a carrier says: the rule's failure, or whether it met anything. */
interface RuleReport {
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

/** The scope a rule reads declarations in. */
type RuleDoor = Pick<
  RelationDoor,
  "defs" | "aliases" | "aliasesByModule" | "rootModules" | "libraries" | "requests" | "declared" | "moduleNames" | "subject" | "functions"
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The binder a rule resolves its references through, over the door's requests. */
function binderOf(door: RuleDoor): PeerBinder {
  const { defs, aliases, aliasesByModule, requests, libraries, rootModules } = door;
  const ruleDef: DefResolver = (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
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
      if (!sites.has(definition)) sites.set(definition, governedCelEvalSites(definition, ruleDef, defs.shapeLookup));
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
  );
}

function carrier(subject: ResourceManifest, report: RuleReport): AnalysisDiagnostic {
  return {
    severity: DiagnosticSeverity.Hint,
    code: RESOURCE_RULE_REPORT,
    source: SOURCE,
    message: "",
    data: {
      resource: { kind: subject.kind, name: subject.metadata?.name as string },
      filePath: (subject.metadata as { source?: string } | undefined)?.source,
      ruleReport: report,
    },
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
    );
    for (const report of reportResourceRules(subject, declarer, findings, !declarerModule || door.rootModules.has(declarerModule))) {
      if (report.evaluationFailure) {
        out.push({
          diagnostic: carrier(subject, {
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
        diagnostic: carrier(subject, {
          type: "exercise",
          key: `${module}.${definitionName}#${rule.code}`,
          rule: rule.code,
          module,
          exercised: ruleExercised(subject, rule),
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

/**
 * What one run makes of the rule carriers its instances' findings hold: a
 * failing rule once per declaring kind, anchored at the `imports:` entry that
 * brought the kind in when it is a dependency's, and — once the run is over —
 * the rules no instance of it exercised.
 */
export class ResourceRuleReports {
  private readonly ledger = new RuleFailureLedger();
  private readonly tally = new Map<string, { exercised: boolean; report: RuleReport }>();

  constructor(private readonly anchorOf: (module: string) => { filePath?: string; path: string } | undefined) {}

  /** `diagnostics` with each carrier replaced by what it stands for. */
  settle(diagnostics: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] {
    const out: AnalysisDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const found = (diagnostic.data as { ruleReport?: RuleReport } | undefined)?.ruleReport;
      if (diagnostic.code !== RESOURCE_RULE_REPORT || !found) {
        out.push(diagnostic);
        continue;
      }
      if (found.type === "exercise") {
        const known = this.tally.get(found.key);
        if (known) known.exercised ||= found.exercised === true;
        else this.tally.set(found.key, { exercised: found.exercised === true, report: found });
        continue;
      }
      if (!this.ledger.first(found.key, found.rule)) continue;
      const anchor = found.module ? this.anchorOf(found.module) : undefined;
      out.push(
        anchor
          ? {
              severity: SEVERITY[found.report.severity],
              code: found.report.code,
              source: SOURCE,
              message: found.report.message,
              data: { filePath: anchor.filePath, path: anchor.path, rule: found.rule },
            }
          : this.at(found),
      );
    }
    return out;
  }

  /** The unexercised report of every tallied rule no instance exercised. */
  unexercised(): AnalysisDiagnostic[] {
    return [...this.tally.values()].filter((each) => !each.exercised).map((each) => this.at(each.report));
  }

  private at(found: RuleReport): AnalysisDiagnostic {
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
}

export { RESOURCE_RULES_ANNOTATION };
