/**
 * REFERRER RULES AS A RELATION GROUP: a kind's `x-telo-referrer-rules` judged
 * at each place a referrer references a resource of the kind, from the places
 * its rules read in the referrer and — by name — in the resource the place
 * resolves to, the declarations the rules' `resolve:` / `resolveSelf:`
 * pointers and a `peers:` collection's entries name, and a `coReferrers:`
 * rule's other referrers; never from a declaration whole. The group's reader
 * (`analyzer.ts`) finds the instance; this file is what it reads and its judge.
 *
 * A rule judges a referrer once however many of its places reach the
 * resource (per entry for a `peers:` rule), stops at its first failure on one
 * resource — an evaluation past the budget among them — and is exercised where
 * it met a referrer: each verdict rides as a carrier, settled by the run that
 * places it (`RuleReports`).
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { reportRuleEvaluation } from "./cel-site-judgements.js";
import type { DefResolver } from "./extends-resolution.js";
import type { ReadKeys, Referent, ReferentReads } from "./read-place.js";
import {
  declaredReferrerRules,
  referrerRuleSubjectReads,
  referrerSideReads,
  type ReferrerRule,
  type ReferrerRuleReading,
} from "./referrer-rule.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import type { DeclarationIdentity, RelationDoor, RelationFinding, RelationReaderScope, RelationReads } from "./relation-sites.js";
import { isResolvedReference } from "./resolved-reference.js";
import { binderOf, RULE_CLAIM, ruleCarrier, type ReferrerVerdict, type RuleDoor } from "./resource-rule-relation.js";
import { compileRuleCondition, RULE_BUDGET_MS } from "./rule-condition.js";
import { withQuotedPath } from "./quoted-place.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { evaluateReferrerRuleAt, reportReferrerRules, type Referrer, type ReferrerRuleFinding } from "./validate-referrer-rules.js";
import { pointerToPath } from "./resource-rule.js";
import { pathText } from "./template-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { AliasResolver } from "./alias-resolver.js";
import { kindSatisfies } from "./validate-references.js";

const SOURCE = "telo-analyzer";

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
} as const;

/** One rule a referrer may be judged by, with the kind declaring it. */
interface Candidate {
  readonly declarer: ResourceDefinition;
  readonly rule: ReferrerRule;
}

type Scope = Pick<RelationReaderScope, "defs" | "aliases" | "moduleNames">;

/**
 * Whether a referrer of `kind` satisfies a rule's `referrer:` filter, which is
 * canonical by the time it gets here: the referring manifest's own `kind:` is
 * resolved, and a child of the named kind is one.
 */
export function referrerKindMatches(defs: DefinitionRegistry, aliases: AliasResolver): (filter: string, kind: string) => boolean {
  return (filter, kind) => {
    const resolved = aliases.resolveKind(kind) ?? kind;
    if (resolved === filter) return true;
    return defs.getByExtends(filter).some((d) => `${d.metadata.module}.${d.metadata.name}` === resolved);
  };
}

const ruleResolver = (scope: Pick<RelationReaderScope, "defs" | "aliases">): DefResolver => {
  const { defs, aliases } = scope;
  return (k) => defs.resolve(aliases.resolveKind(k) ?? k) ?? defs.resolve(k);
};

interface RegisteredRules {
  readonly generation: number;
  /** Every rule, once. */
  readonly rules: Candidate[];
  /** The kinds whose resources are judged by any. */
  readonly judged: string[];
  /** Whether a slot accepting the kinds keyed is ever judged. */
  readonly accepts: Map<string, boolean>;
}

const registeredRulesOf = new WeakMap<DefinitionRegistry, RegisteredRules>();

/** Every referrer rule a resource of some registered kind is judged by, each
 *  with its declarer, and the kinds judged — kinds never vary, so read once
 *  per registration. */
function registeredRules(scope: Scope): RegisteredRules {
  const known = registeredRulesOf.get(scope.defs);
  if (known && known.generation === scope.defs.generation) return known;
  const resolve = ruleResolver(scope);
  const seen = new Set<string>();
  const rules: Candidate[] = [];
  const judged: string[] = [];
  for (const kind of scope.defs.kinds()) {
    const definition = scope.defs.resolve(kind);
    if (!definition) continue;
    const groups = declaredReferrerRules(definition, resolve);
    if (groups.length > 0) judged.push(kind);
    for (const { declarer, rules: declared } of groups) {
      for (const rule of declared) {
        const key = `${declarer.metadata.module ?? ""}.${declarer.metadata.name}#${rule.code}\0${rule.referrer ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push({ declarer, rule });
      }
    }
  }
  const found: RegisteredRules = { generation: scope.defs.generation, rules, judged, accepts: new Map() };
  registeredRulesOf.set(scope.defs, found);
  return found;
}

function referrerRulesOf(scope: Scope): readonly Candidate[] {
  return registeredRules(scope).rules;
}

/** Whether a slot accepting `kinds` may hold a resource some referrer rule
 *  judges — a place no slot declares may hold any. */
export function slotMayHoldJudged(kinds: readonly string[], scope: Scope): boolean {
  if (kinds.length === 0) return true;
  const registered = registeredRules(scope);
  const key = [...kinds].sort().join("\0");
  let accepts = registered.accepts.get(key);
  if (accepts === undefined) {
    accepts = registered.judged.some((judged) => kinds.some((kind) => kindSatisfies(judged, kind, scope.defs)));
    registered.accepts.set(key, accepts);
  }
  return accepts;
}

/** What is memoized per registration of a registry and per alias scope the
 *  referring kinds are read in. */
function memoOf<T>(memo: WeakMap<object, WeakMap<AliasResolver, Map<string, T>>>, key: object, aliases: AliasResolver): Map<string, T> {
  let byAliases = memo.get(key);
  if (!byAliases) memo.set(key, (byAliases = new WeakMap()));
  let found = byAliases.get(aliases);
  if (!found) byAliases.set(aliases, (found = new Map()));
  return found;
}

const candidatesOf = new WeakMap<object, WeakMap<AliasResolver, Map<string, readonly Candidate[]>>>();

/** The rules a referrer of `kind` may be judged by: those naming it, or any
 *  referrer. */
export function referrerRuleCandidates(kind: string, scope: Scope): readonly Candidate[] {
  const all = referrerRulesOf(scope);
  const byKind = memoOf(candidatesOf, all, scope.aliases);
  let found = byKind.get(kind);
  if (!found) {
    const matches = referrerKindMatches(scope.defs, scope.aliases);
    found = all.filter(({ rule }) => rule.referrer === undefined || matches(rule.referrer, kind));
    byKind.set(kind, found);
  }
  return found;
}

const identityOfDeclarer = (declarer: ResourceDefinition): DeclarationIdentity => ({
  identityOnly: true,
  kind: (declarer as unknown as { kind: string }).kind,
  metadata: (declarer.metadata ?? {}) as Record<string, unknown>,
});

const subjectReadsOf = new WeakMap<object, WeakMap<AliasResolver, Map<string, ReferentReads>>>();

/** What the rules judging a referrer of `kind` read in the resource a slot of
 *  it resolves to: read off the rules that resource's own kind declares. */
function subjectReads(kind: string, scope: Scope): ReferentReads {
  const byKind = memoOf(subjectReadsOf, referrerRulesOf(scope), scope.aliases);
  const known = byKind.get(kind);
  if (known) return known;
  const matches = referrerKindMatches(scope.defs, scope.aliases);
  const resolve = ruleResolver(scope);
  const byDefinition = new WeakMap<object, ReturnType<ReferentReads>>();
  const reads: ReferentReads = (referent: Referent) => {
    const definition = referent.definition as ResourceDefinition | undefined;
    if (!definition) return [];
    let places = byDefinition.get(definition);
    if (!places) {
      const readings: ReferrerRuleReading[] = [];
      for (const { declarer, rules } of declaredReferrerRules(definition, resolve)) {
        const moduleNames = scope.moduleNames(identityOfDeclarer(declarer));
        for (const rule of rules) {
          if (rule.referrer === undefined || matches(rule.referrer, kind)) readings.push({ rule, moduleNames });
        }
      }
      places = referrerRuleSubjectReads(readings);
      byDefinition.set(definition, places);
    }
    return places;
  };
  byKind.set(kind, reads);
  return reads;
}

/**
 * What an instance at `anchor` of a referrer of `kind` reads: what its
 * candidate rules read in the referrer and through it, and — resolved where
 * the reference at the anchor is written — what the rules of the resource it
 * names read there.
 */
export function referrerRuleReads(anchor: ReadKeys, kind: string, scope: Scope): RelationReads {
  const side = referrerSideReads(
    referrerRuleCandidates(kind, scope).map(({ declarer, rule }) => ({ rule, moduleNames: scope.moduleNames(identityOfDeclarer(declarer)) })),
  );
  return {
    places: side.places,
    calls: side.calls,
    scopes: true,
    targets: [
      { at: anchor, hop: "resolved", reads: subjectReads(kind, scope), transitive: false },
      ...side.targets.map((target) => ({ ...target, hop: "named" as const })),
    ],
  };
}

/** What tells a declaration apart in a verdict's keys. */
const identityKey = (m: ResourceManifest): string => {
  const meta = (m.metadata ?? {}) as { name?: unknown; source?: unknown; module?: unknown };
  return JSON.stringify([m.kind, meta.name, meta.source, meta.module]);
};

/** A referrer-rule finding as a diagnostic. */
function referrerDiagnostic(report: ReturnType<typeof reportReferrerRules>[number]): AnalysisDiagnostic {
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

/**
 * The verdicts of the rules of the resource the reference at `anchor` names on
 * the declaration holding it: each rule the referrer's kind is judged by, as
 * the kind declaring it wrote it, each a carrier and the diagnostic it decides.
 * A rule whose condition does not compile is reported where the resource is
 * declared.
 */
export function referrerRuleFindings(anchor: ReadKeys, value: unknown, door: RuleDoor & Pick<RelationDoor, "resolveTarget" | "rootModules">): RelationFinding[] {
  const written = isResolvedReference(value) ? (value as unknown as Record<string, unknown>) : refSentinelTarget(value);
  if (!written || typeof written.name !== "string") return [];
  const subject = door.resolveTarget(written as Record<string, any>, anchor) as ResourceManifest | undefined;
  if (!subject || typeof subject.kind !== "string") return [];
  const declared = door.declared({ identityOnly: true, kind: subject.kind, metadata: (subject.metadata ?? {}) as Record<string, unknown> });
  if (declared.status !== "ok") return [];
  const groups = declaredReferrerRules(declared.definition, ruleResolver(door));
  if (groups.length === 0) return [];
  const holder = door.subject();
  const path = pathText(anchor);
  const referrer: Referrer = { manifest: holder, kind: holder.kind, name: holder.metadata?.name as string, path };
  const matches = referrerKindMatches(door.defs, door.aliases);
  if (!groups.some(({ rules }) => rules.some((rule) => rule.referrer === undefined || matches(rule.referrer, holder.kind)))) return [];
  reportRuleEvaluation("referrerRules", false);
  const binder = binderOf(door);
  const subjectKey = identityKey(subject);
  const referrerKey = identityKey(holder);
  let coReferrers: Map<string, Referrer[]> | undefined;
  /** The referrers reaching the resource through `slot`, of the kinds the rule names. */
  const through = (rule: ReferrerRule, slot: string): Referrer[] => {
    coReferrers ??= new Map();
    let found = coReferrers.get(slot);
    if (!found) {
      found = [];
      const seen = new Set<string>();
      for (const each of door.requests.referrersOf(subject)) {
        const key = identityKey(each.manifest);
        if (each.path !== slot || key === referrerKey || seen.has(key)) continue;
        seen.add(key);
        found.push({ manifest: each.manifest, kind: each.manifest.kind, name: each.manifest.metadata?.name as string, path: each.path });
      }
      coReferrers.set(slot, found);
    }
    return found.filter((each) => rule.referrer === undefined || matches(rule.referrer, each.kind));
  };
  const out: RelationFinding[] = [];
  for (const { declarer, rules } of groups) {
    const declarerManifest = declarer as unknown as ResourceManifest;
    const module = (declarer.metadata as { module?: string } | undefined)?.module;
    const ours = !module || door.rootModules.has(module);
    const moduleNames = door.moduleNames(identityOfDeclarer(declarer));
    const context = { peerBinder: binder, moduleNames, functions: door.functions(declarerManifest) };
    const definition = {
      kind: declarerManifest.kind,
      name: declarer.metadata?.name as string,
      source: (declarer.metadata as { source?: string } | undefined)?.source,
    };
    for (const rule of rules) {
      if (rule.referrer !== undefined && !matches(rule.referrer, holder.kind)) continue;
      const coSlot = rule.coReferrers === undefined ? undefined : pointerToPath(rule.coReferrers);
      // A condition that does not compile is reported where the resource is
      // declared; the rule still met this referrer.
      const compiles = !("reason" in compileRuleCondition(rule.condition, moduleNames));
      const started = Date.now();
      const evaluated = compiles
        ? evaluateReferrerRuleAt(subject, rule, referrer, coSlot === undefined ? [] : through(rule, coSlot), matches, context)
        : undefined;
      const elapsedMs = Date.now() - started;
      // One evaluation past the budget is a defect in the rule, whatever it found.
      const finding: ReferrerRuleFinding | undefined =
        elapsedMs > RULE_BUDGET_MS ? { kind: "over-budget", rule, referrer, elapsedMs } : evaluated;
      const reports = finding ? reportReferrerRules(subject, declarerManifest, [finding], ours) : [];
      const failed = reports.find((report) => report.evaluationFailure);
      const shown = reports.filter((report) => {
        if (report.evaluationFailure) return false;
        // A violation is the referrer's data: reported where the referrer is
        // the entry's own.
        const owner = (report.manifest.metadata as { module?: string } | undefined)?.module;
        return report.code !== "REFERRER_RULE_VIOLATED" || !owner || door.rootModules.has(owner);
      });
      const exercised =
        coSlot !== undefined ? path === coSlot : rule.peers === undefined || binder.hasPeers(holder, holder.kind, rule.peers, path);
      const key = `referrer\u0000${module ?? ""}.${definition.name}`;
      const judged = `${subjectKey}\u0000${module ?? ""}.${definition.name}#${rule.code}`;
      const claim = `${judged}\u0000${referrerKey}\u0000${path}`;
      const verdict: ReferrerVerdict = {
        type: "referrer",
        claim,
        at: {
          ...(typeof holder.kind === "string" ? { kind: holder.kind } : {}),
          ...(typeof holder.metadata?.name === "string" ? { name: holder.metadata.name } : {}),
          ...(typeof (holder.metadata as { source?: unknown } | undefined)?.source === "string"
            ? { filePath: (holder.metadata as unknown as { source: string }).source }
            : {}),
          path,
        },
        subject: judged,
        ...(rule.peers === undefined ? { once: `${judged}\u0000${referrerKey}` } : {}),
        ...(ours
          ? {
              exercise: {
                key: `${module}.${definition.name}#${rule.code}`,
                exercised,
                violated: shown.some((report) => report.code === "REFERRER_RULE_VIOLATED"),
              },
            }
          : {}),
        ...(failed
          ? {
              failure: {
                type: "failure" as const,
                key,
                rule: rule.code,
                module,
                report: { code: failed.code, severity: failed.severity, message: failed.message, definition, path: failed.path },
              },
            }
          : {}),
      };
      out.push({ diagnostic: ruleCarrier(holder, verdict, path), judgedAt: path });
      for (const report of shown) {
        const diagnostic = referrerDiagnostic(report);
        out.push({ diagnostic: { ...diagnostic, data: { ...(diagnostic.data as Record<string, unknown>), [RULE_CLAIM]: claim } }, judgedAt: path });
      }
    }
  }
  return out;
}
