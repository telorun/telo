/**
 * The one finishing step of every analysis: every finding, placed by the
 * world that computed it, arrives here with the condition it holds under — or,
 * found only inside a branch no configuration takes, with that branch — and is
 * filtered, settled and merged once. Nothing else drops a finding.
 *
 * In order: the dead-branch place rule; the refusal covers — those given, and
 * those a finding's provenance says it is — each subtracting where its refusal
 * holds from what it covers; first-in-order rule settling, each world apart (a
 * run that judged its own verdicts has them decided before any cover); the
 * forwarded-duplicate subtraction; the merge and its labels, provenance
 * stripped.
 * A world is the configurations (findings conditioned over them) or one branch
 * no configuration takes (findings holding there alone).
 *
 * Browser-safe.
 */
import type { Assignment, Dimension } from "./configuration-dimensions.js";
import { mergeConditionedDiagnostics, type ConditionedFinding } from "./configuration-merge.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { provenanceOf, withoutProvenance, type BodyEntryPlace } from "./placement.js";
import type { RuleReports } from "./resource-rule-relation.js";
import type { AnalysisDiagnostic } from "./types.js";

/** Where the findings of one branch no configuration takes may stand: inside
 *  the branch, on the declaration holding its choice. */
export interface DeadBranchPlace {
  readonly holder: { readonly kind: unknown; readonly name: unknown; readonly source: unknown };
  readonly at: string;
}

/** One finding in written coordinates, with where it holds. What placement
 *  knew of it before it moved it — its provenance — rides on the diagnostic
 *  (`provenanceOf`) and is stripped before the merge. */
export interface PlacedFinding {
  readonly diagnostic: AnalysisDiagnostic;
  /** Over the configurations; FALSE for a dead branch's finding. */
  readonly condition: Condition;
  /** Found inside a branch no configuration takes: that branch's world. */
  readonly dead?: { readonly world: object; readonly place: DeadBranchPlace };
  /** A rule verdict's carrier or claim, decided by settling. */
  readonly settles?: true;
  /** About a forward view, moved to its consumer. */
  readonly moved?: true;
}

/**
 * A refusal whose consequences are its own one report: what it covers holds
 * only where the refusal does not. Indexed by the written places it covers —
 * a declaration (`coverKey`), a file (`fileCoverKey`), or the body entry a
 * finding was placed from (`bodyEntryCoverKey`); `world` names the dead branch
 * it holds in alone, or `"every"` for one holding wherever its declaration does.
 * It answers WHERE it covers a finding — FALSE where it does not — and in a
 * dead branch's world covers it wholly wherever it answers anything.
 */
export interface RefusalCover {
  readonly declarations: readonly string[];
  readonly world?: object | "every";
  covers(diagnostic: AnalysisDiagnostic, finding: PlacedFinding): Condition;
}

/** The written declaration a finding is about, as covers index it. */
export function coverKey(kind: unknown, name: unknown, filePath: unknown): string {
  return JSON.stringify([kind ?? null, name ?? null, filePath ?? null]);
}

/** A written file, as covers index it. */
export function fileCoverKey(filePath: unknown): string {
  return JSON.stringify(["file", filePath ?? null]);
}

/** A template body's entry a finding was placed from, as covers index it;
 *  without `entry`, every entry of every body. */
export function bodyEntryCoverKey(writtenBy?: BodyEntryPlace["writtenBy"], entry?: string): string {
  return JSON.stringify(["body-entry", ...(writtenBy ? [writtenBy.name ?? null, writtenBy.source ?? null, entry ?? null] : [])]);
}

/**
 * The cover of what a forward view's body wrote where its consumer's expansion
 * refused a choice or repeat of the body: the refusal is the one report. Read
 * with the view the finding was placed through, so it holds wherever that view
 * does.
 */
export function bodyEntryCovers(): RefusalCover[] {
  return [
    {
      declarations: [bodyEntryCoverKey()],
      world: "every",
      covers: (d) => (provenanceOf(d)?.bodyEntry?.incomplete === true ? TRUE : FALSE),
    },
  ];
}

/**
 * The rule verdicts a template definition's own check makes among its body
 * entries, decided in a world of their own: the body's subjects are no
 * consumer's, and a verdict the body decides is reported once, at the
 * definition, whatever any consumer's world decides. `reports` is that world's.
 */
export function settleBodyVerdicts(found: readonly AnalysisDiagnostic[], reports: RuleReports): AnalysisDiagnostic[] {
  return reports.settle(found);
}

export interface FinishingOptions {
  readonly space: ConditionSpace;
  readonly universe: Condition;
  readonly dimensions: readonly Dimension[];
  /** The settling state of one world: the configurations' (undefined) or a
   *  dead branch's. */
  readonly settling: (world: object | undefined) => RuleReports;
  /** The rule verdicts of one run that judged them itself: decided as that
   *  run reads them, then the rules none of its instances exercised. */
  readonly runSettling?: RuleReports;
  readonly covers?: readonly RefusalCover[];
  /** Read the findings of one configuration, unlabelled, instead of merging. */
  readonly at?: Assignment;
}

/** How many times each step ran, by step: once per finding reaching it. */
export interface FinishingCounts {
  /** How many times the pipeline ran, and how many findings it was handed. */
  calls: number;
  inputs: number;
  place: number;
  cover: number;
  settle: number;
  forwarded: number;
  merge: number;
}

let counts: FinishingCounts | undefined;

/** Count every finishing step until {@link stopCountingFinishingSteps}. */
export function countFinishingSteps(): FinishingCounts {
  return (counts = { calls: 0, inputs: 0, place: 0, cover: 0, settle: 0, forwarded: 0, merge: 0 });
}

export function stopCountingFinishingSteps(): void {
  counts = undefined;
}

type Held = { diagnostic: AnalysisDiagnostic; condition: Condition; finding: PlacedFinding };

/** Every finding, finished. */
export function finishFindings(findings: readonly PlacedFinding[], options: FinishingOptions): AnalysisDiagnostic[] {
  const { space } = options;
  if (counts) {
    counts.calls++;
    counts.inputs += findings.length;
  }
  const worlds = new Map<object | undefined, PlacedFinding[]>();
  for (const finding of findings) {
    if (finding.dead) {
      if (counts) counts.place++;
      if (!insideBranch(finding.diagnostic, finding.dead.place)) continue;
    }
    const world = finding.dead?.world;
    const list = worlds.get(world);
    if (list) list.push(finding);
    else worlds.set(world, [finding]);
  }
  const byDeclaration = new Map<string, RefusalCover[]>();
  const index = (cover: RefusalCover) => {
    for (const key of cover.declarations) {
      const list = byDeclaration.get(key);
      if (list) list.push(cover);
      else byDeclaration.set(key, [cover]);
    }
  };
  for (const cover of options.covers ?? []) index(cover);
  // A refusal a finding is covers where that finding holds.
  for (const list of worlds.values()) {
    for (const finding of list) {
      const carried = provenanceOf(finding.diagnostic)?.refuses;
      if (!carried) continue;
      const data = finding.diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown } | undefined;
      const own = [coverKey(data?.resource?.kind, data?.resource?.name, data?.filePath)];
      for (const each of carried) {
        // In a dead branch's world it covers wholly.
        const where = finding.dead ? TRUE : finding.condition;
        index({
          declarations: each.keys ?? own,
          ...(finding.dead ? { world: finding.dead.world } : {}),
          covers: (d) => (each.covers(d, provenanceOf(d)) ? where : FALSE),
        });
      }
    }
  }
  const merged: ConditionedFinding[] = [];
  for (const [world, list] of worlds) {
    // A dead branch's world holds its findings everywhere it is read.
    const coveredIn = (each: Held): Held | undefined => {
      const condition = uncovered(each.finding, world === undefined ? each.condition : TRUE, world, byDeclaration, space);
      return condition === FALSE ? undefined : { ...each, condition };
    };
    const raw: Held[] = list.map((finding) => ({ diagnostic: finding.diagnostic, condition: finding.condition, finding }));
    // A run judging its own verdicts decides each before anything covers it:
    // a verdict at a refused construct still exercised its rule.
    const settled =
      options.runSettling && world === undefined
        ? settleRun(raw, options.runSettling).flatMap((each) => coveredIn(each) ?? [])
        : settle(raw.flatMap((each) => coveredIn(each) ?? []), () => options.settling(world), space);
    for (const each of withoutForwardedDuplicates(settled, space)) {
      if (each.condition === FALSE) continue;
      merged.push({ diagnostic: withoutProvenance(each.diagnostic), condition: world === undefined ? each.condition : FALSE });
    }
  }
  if (counts) counts.merge += merged.length;
  if (options.at) {
    const at = options.at;
    return merged.filter((each) => space.holds(each.condition, at)).map((each) => each.diagnostic);
  }
  return mergeConditionedDiagnostics(merged, space, options.universe, options.dimensions);
}

/** Where `finding` holds that no refusal covering it does. */
function uncovered(
  finding: PlacedFinding,
  condition: Condition,
  world: object | undefined,
  byDeclaration: ReadonlyMap<string, readonly RefusalCover[]>,
  space: ConditionSpace,
): Condition {
  if (counts) counts.cover++;
  const data = finding.diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown } | undefined;
  const body = provenanceOf(finding.diagnostic)?.bodyEntry;
  const covers = [
    ...(byDeclaration.get(coverKey(data?.resource?.kind, data?.resource?.name, data?.filePath)) ?? []),
    ...(byDeclaration.get(fileCoverKey(data?.filePath)) ?? []),
    ...(body
      ? [...(byDeclaration.get(bodyEntryCoverKey()) ?? []), ...(byDeclaration.get(bodyEntryCoverKey(body.writtenBy, body.entry)) ?? [])]
      : []),
  ];
  if (covers.length === 0) return condition;
  let held = condition;
  for (const cover of covers) {
    if (held === FALSE) break;
    if (cover.world !== "every" && cover.world !== world) continue;
    const where = cover.covers(finding.diagnostic, finding);
    if (where === FALSE) continue;
    held = world === undefined ? space.and(held, space.not(where)) : FALSE;
  }
  return held;
}

/** Whether a dead branch's finding stands inside it. */
function insideBranch(diagnostic: AnalysisDiagnostic, place: DeadBranchPlace): boolean {
  const data = diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
  if (!data?.resource) return false;
  return (
    data.resource.kind === place.holder.kind &&
    data.resource.name === place.holder.name &&
    data.filePath === place.holder.source &&
    typeof data.path === "string" &&
    (data.path === place.at || data.path.startsWith(`${place.at}.`) || data.path.startsWith(`${place.at}[`))
  );
}

/** The rule verdicts decided first in written order, each under the condition
 *  no earlier one decided otherwise. */
function settle(held: readonly Held[], reports: () => RuleReports, space: ConditionSpace): Held[] {
  const settling = held.filter((each) => each.finding.settles);
  if (counts) counts.settle += settling.length;
  if (settling.length === 0) return [...held];
  const settled = reports().settleConditioned(settling, space);
  const out = held.filter((each) => !each.finding.settles);
  for (const each of settled) out.push({ diagnostic: each.diagnostic, condition: each.condition, finding: each.from.finding });
  return out;
}

/** Whether a finding is about a forward view, moved to its consumer. */
function isMoved(finding: PlacedFinding): boolean {
  return finding.moved === true || provenanceOf(finding.diagnostic)?.moved === true;
}

/** One run's rule verdicts decided as the run reads them, every finding of it
 *  holding everywhere, then the rules none of its instances exercised. */
function settleRun(held: readonly Held[], reports: RuleReports): Held[] {
  if (counts) counts.settle += held.length;
  const settled = reports.settleGroups(held.map((each) => [each.diagnostic]));
  const out: Held[] = [];
  held.forEach((each, i) => {
    for (const diagnostic of settled[i]!) {
      out.push(diagnostic === each.diagnostic ? each : { diagnostic, condition: each.condition, finding: { ...each.finding, diagnostic } });
    }
  });
  for (const diagnostic of reports.unexercised()) out.push({ diagnostic, condition: TRUE, finding: { diagnostic, condition: TRUE } });
  return out;
}

/** A moved finding less where the consumer's own analysis makes it — same
 *  code, same place — and where an earlier moved one says the same. */
function withoutForwardedDuplicates(held: readonly Held[], space: ConditionSpace): Held[] {
  const own = new Map<string, Condition>();
  for (const each of held) {
    if (isMoved(each.finding)) continue;
    const { place } = forwardedDuplicateKeys(each.diagnostic);
    own.set(place, space.or(own.get(place) ?? FALSE, each.condition));
  }
  const said = new Map<string, Condition>();
  const out: Held[] = [];
  for (const each of held) {
    if (!isMoved(each.finding)) {
      out.push(each);
      continue;
    }
    if (counts) counts.forwarded++;
    const { place, saying } = forwardedDuplicateKeys(each.diagnostic);
    const taken = space.or(own.get(place) ?? FALSE, said.get(saying) ?? FALSE);
    const condition = space.and(each.condition, space.not(taken));
    if (condition === FALSE) continue;
    said.set(saying, space.or(said.get(saying) ?? FALSE, condition));
    out.push({ ...each, condition });
  }
  return out;
}

/** What tells a forwarded duplicate: its place, and its place with what it says. */
function forwardedDuplicateKeys(d: AnalysisDiagnostic): { readonly place: string; readonly saying: string } {
  const data = d.data as { resource?: { kind?: string; name?: string }; path?: unknown; filePath?: string; occurrence?: number } | undefined;
  const place = [
    d.code,
    data?.resource?.kind ?? "",
    data?.resource?.name ?? "",
    data?.filePath ?? "",
    typeof data?.path === "string" ? data.path : "",
    data?.occurrence ?? "",
  ].join("\0");
  return { place, saying: `${place}\0${d.message}` };
}
