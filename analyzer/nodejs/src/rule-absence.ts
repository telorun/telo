/**
 * Rules no instance exercised, over every configuration at once: a resource
 * rule is unexercised where an instance of its kind holds and none exercised
 * it, a referrer rule where a resource of its kind holds and no referrer met
 * it — each a presence condition built once from the keys every rule site was
 * judged under, never decided inside a configuration run.
 *
 * A referrer rule's verdicts on one resource are settled in the order they are
 * written only where that order can matter: a verdict that failed stops
 * the rest, and a referrer judged once is exercised by its first verdict.
 *
 * Browser-safe.
 */
import { World } from "./conditioned-expansion.js";
import { compareCodePoints, type FindingOrder } from "./finding-order.js";
import { FALSE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { ruleReportDiagnostic, type ReferrerVerdict, type RuleReport } from "./resource-rule-relation.js";
import type { AnalysisDiagnostic } from "./types.js";

/** One key of a rule site: where a run places its marker, and what it carries. */
export interface RuleSiteKey<T> {
  readonly condition: Condition;
  readonly carriers: readonly T[];
}

/** A referrer rule's site: where its anchor exists, and its keys. */
export interface ReferrerRuleSite {
  readonly id: string;
  readonly condition: Condition;
  readonly keys: readonly RuleSiteKey<ReferrerVerdict>[];
}

export interface RuleAbsenceInputs {
  readonly space: ConditionSpace;
  /** The configurations kept. */
  readonly universe: Condition;
  /** Each key of each resource-rule site, with the exercise reports it carries. */
  readonly resourceKeys: readonly RuleSiteKey<RuleReport>[];
  /** The referrer rules of the entry's own modules, in declaration order. */
  readonly referrerTally: ReadonlyMap<string, { readonly order: number; readonly report: AnalysisDiagnostic }>;
  /** Where a resource of a kind declaring each tallied referrer rule holds. */
  readonly referrerSeen: ReadonlyMap<string, Condition>;
  readonly referrerSites: readonly ReferrerRuleSite[];
  /** The order verdicts are decided in: where each is written. */
  readonly order: FindingOrder;
}

/** The unexercised rules, each with where it holds. */
export class RuleAbsence {
  constructor(
    private readonly space: ConditionSpace,
    private readonly resource: ReadonlyMap<string, { readonly report: RuleReport; readonly condition: Condition }>,
    private readonly referrer: readonly { readonly order: number; readonly report: AnalysisDiagnostic; readonly condition: Condition }[],
  ) {}

  /** Every unexercised rule, with where it holds unexercised. */
  findings(): { readonly diagnostic: AnalysisDiagnostic; readonly condition: Condition }[] {
    return [
      ...[...this.resource.values()].map((found) => ({ diagnostic: ruleReportDiagnostic(found.report), condition: found.condition })),
      ...this.referrer.map((found) => ({ diagnostic: found.report, condition: found.condition })),
    ];
  }

  /** Each resource rule is unexercised only where an instance of it was
   *  settled: `exercised` is where each was, within `universe`. */
  checkSettled(exercised: ReadonlyMap<string, Condition>, universe: Condition): void {
    for (const [key, found] of this.resource) {
      if (!this.space.implies(this.space.and(found.condition, universe), exercised.get(key) ?? FALSE)) {
        throw new Error(`internal: the resource rule ${key} is unexercised where no instance of it was settled.`);
      }
    }
  }
}

export function ruleAbsence(inputs: RuleAbsenceInputs): RuleAbsence {
  const { space, universe } = inputs;
  const or = (into: Map<string, Condition>, key: string, condition: Condition) =>
    into.set(key, space.or(into.get(key) ?? FALSE, condition));

  // A resource rule: tallied where an instance's site holds, exercised where
  // one exercised it.
  const reports = new Map<string, RuleReport>();
  const present = new Map<string, Condition>();
  const exercised = new Map<string, Condition>();
  for (const key of inputs.resourceKeys) {
    for (const carrier of key.carriers) {
      if (!reports.has(carrier.key)) reports.set(carrier.key, carrier);
      or(present, carrier.key, key.condition);
      if (carrier.exercised === true) or(exercised, carrier.key, key.condition);
    }
  }
  const resource = new Map<string, { report: RuleReport; condition: Condition }>();
  for (const [key, condition] of present) {
    const unexercised = space.and(condition, space.not(exercised.get(key) ?? FALSE));
    if (unexercised !== FALSE) resource.set(key, { report: reports.get(key)!, condition: unexercised });
  }

  // A referrer rule: exercised by its verdicts, one resource's at a time.
  const met = new Map<string, Condition>();
  const groups = new Map<string, Set<ReferrerRuleSite>>();
  for (const site of inputs.referrerSites) {
    for (const key of site.keys) {
      for (const verdict of key.carriers) {
        const group = groups.get(verdict.subject) ?? new Set();
        group.add(site);
        groups.set(verdict.subject, group);
      }
    }
  }
  for (const [subject, sites] of groups) {
    const verdicts = [...sites].flatMap((site) => site.keys.flatMap((key) => key.carriers.filter((v) => v.subject === subject)));
    const onces = new Map<string, number>();
    for (const v of verdicts) if (v.once !== undefined) onces.set(v.once, (onces.get(v.once) ?? 0) + 1);
    const ordered =
      verdicts.some((v) => v.failure) ||
      verdicts.some((v) => v.once !== undefined && onces.get(v.once)! > 1 && v.exercise?.violated === true && !v.exercise.exercised);
    if (!ordered) {
      // No verdict stops another and none is judged in another's place: each
      // exercises its rule where it holds.
      for (const site of sites) {
        for (const key of site.keys) {
          const condition = space.and(key.condition, site.condition);
          for (const v of key.carriers) {
            if (v.subject !== subject || !v.exercise) continue;
            if (v.exercise.exercised || (v.exercise.violated && !v.failure)) or(met, v.exercise.key, condition);
          }
        }
      }
      continue;
    }
    // Each configuration's verdicts on the resource, in the order they are
    // written: a reading per distinct set of keys holding.
    let remaining = FALSE as Condition;
    for (const site of sites) remaining = space.or(remaining, space.and(site.condition, universe));
    while (remaining !== FALSE) {
      const witness: World = World.key(space.firstAssignment(remaining)!);
      let condition = remaining;
      const holding: { site: ReferrerRuleSite; key: RuleSiteKey<ReferrerVerdict> }[] = [];
      for (const site of sites) {
        const key = space.holds(site.condition, witness.assignment)
          ? site.keys.find((each) => space.holds(each.condition, witness.assignment))
          : undefined;
        condition = space.and(condition, key ? space.and(site.condition, key.condition) : space.not(site.condition));
        if (key) holding.push({ site, key });
      }
      const keyOf = new Map(holding.map(({ site, key }) => [site, key]));
      const judged = new Set<string>();
      let stopped = false;
      const exercisedHere = new Set<string>();
      const writtenAt = (site: ReferrerRuleSite) => keyOf.get(site)!.carriers.find((v) => v.subject === subject)?.at ?? {};
      const claimOf = (site: ReferrerRuleSite) => keyOf.get(site)!.carriers.find((v) => v.subject === subject)?.claim ?? "";
      const inOrder = holding
        .map((h) => h.site)
        .sort((a, b) => inputs.order.comparePlaces(writtenAt(a), writtenAt(b)) || compareCodePoints(claimOf(a), claimOf(b)));
      for (const site of inOrder) {
        for (const v of keyOf.get(site)!.carriers) {
          if (v.subject !== subject) continue;
          if (v.exercise?.exercised) exercisedHere.add(v.exercise.key);
          if (stopped) continue;
          if (v.once !== undefined) {
            if (judged.has(v.once)) continue;
            judged.add(v.once);
          }
          if (v.failure) {
            stopped = true;
            continue;
          }
          if (v.exercise?.violated) exercisedHere.add(v.exercise.key);
        }
      }
      for (const key of exercisedHere) or(met, key, condition);
      remaining = space.and(remaining, space.not(condition));
    }
  }
  const referrer: { order: number; report: AnalysisDiagnostic; condition: Condition }[] = [];
  for (const [key, tracked] of inputs.referrerTally) {
    const condition = space.and(inputs.referrerSeen.get(key) ?? FALSE, space.not(met.get(key) ?? FALSE));
    if (condition !== FALSE) referrer.push({ order: tracked.order, report: tracked.report, condition });
  }
  referrer.sort((a, b) => a.order - b.order);
  return new RuleAbsence(space, resource, referrer);
}
