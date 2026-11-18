/**
 * The one judge of a schema validation's findings: what a failed `anyOf` /
 * `oneOf` reports, and what the stand-ins in the value excuse.
 *
 * A validator's flat error list cannot say which branch of a union — if any —
 * raised a finding inside a referenced shape, so nothing is attributed by
 * reading it. Each branch is VALIDATED ON ITS OWN instead, its findings judged
 * by this same judge (a union inside it is decided the same way), and given a
 * branch state; `unionOutcome` (`union-outcome.ts`) decides from the states
 * alone what the union reports. A finding is the union's only when a branch
 * validated alone reproduces it — counted, so a finding a sibling raises and a
 * branch reproduces stays once. A union whose node lies in no document the
 * validator holds is kept with everything raised around it.
 *
 * Browser-safe and re-imported by the kernel, so `telo check` and every runtime
 * refusal decide a union by one rule. The renderers (`schema-error-report.ts`)
 * phrase what it returns.
 */

import {
  formatSingleError,
  LISTED_ENUM_VALUES,
  type AjvErrorLike,
} from "./schema-error-report.js";
import {
  isAmbiguousOneOf,
  standInRule,
  type LocatedFinding,
  type SchemaNodeFindings,
  type StandIn,
  type StandInRule,
} from "./stand-in-findings.js";
import { unionOutcome, type BranchState, type UnionOutcome } from "./union-outcome.js";
import { jsonTypeOf, readUnion, UnreadableReference, type ReferenceReader, type UnionReading } from "./union-tags.js";

/** What the judge decides over: one validated value, and the means to ask about
 *  a part of its schema. */
export interface SchemaJudgment {
  /** The value that was validated, stand-ins in place. */
  value: unknown;
  /** The schema it was validated against. */
  schema: object;
  /** Every stand-in in `value`, by JSON Pointer; none when absent. */
  standIns?: ReadonlyMap<string, StandIn>;
  /** Every finding a node of `schema` raises against a value — the whole schema
   *  as the host validates it, any other node on its own. */
  validate: SchemaNodeFindings;
  /** What a `$ref` written in a node of `schema` names — the reader the
   *  validator compiles with — which a union's candidates and tags are read
   *  through. */
  reference: ReferenceReader;
  /** How the unions of a value judged in parts are decided ({@link UnionPlan}). */
  plan?: UnionPlan;
  /** A failed-union finding for every `anyOf` / `oneOf` node of `schema` in
   *  force at a place, located as `validate` locates its findings — what a
   *  union the validator passed is decided from. */
  unionsAt?: (place: string) => readonly LocatedFinding[];
}

/**
 * A cut site's verdict against one branch of a union above it — all the union
 * reads of it: whether the branch refuses it, and each `const` / `enum`
 * refusal in it, its place relative to the site's root.
 */
export interface CarveSummary {
  readonly state: "valid" | "failing" | "tag-refused";
  readonly tags: readonly { readonly at: string; readonly keyword: string; readonly params: Record<string, unknown> }[];
  /** Whether the validator raised nothing there at all — what a `oneOf` the
   *  validator found several branches of reads, stand-ins not excused. */
  readonly clean: boolean;
}

/** The unions of one validated value a {@link UnionPlan} decides. */
export interface UnionPlaces {
  /** Where the judged site's region is rooted in the value, when it lies there. */
  readonly region?: string;
  /** Each place holding unions to decide, with the site whose root it is and —
   *  for a site above the judged one — the outcome it selected, by signature. */
  readonly places: ReadonlyMap<string, { readonly site: string; readonly forced?: ReadonlyMap<string, UnionOutcome> }>;
}

/**
 * How the unions of a value judged in parts are decided: a cut site's place
 * holds a CARVE stand-in — excused like a computed one — and a union above it
 * reads that site's {@link CarveSummary} per branch; a site above the judged one
 * decides its unions by the outcome it selected.
 */
export interface UnionPlan {
  /** The carve a stand-in value is, or `undefined` for any other value. */
  carveOf(value: unknown): string | undefined;
  /** The unions to decide in the validated value `root`, if any. */
  placesIn(root: unknown): UnionPlaces | undefined;
  /** What the carve `carve` contributes to the branch `slot` names. */
  summary(carve: string, slot: string): CarveSummary | undefined;
  /** The outcome of a union at the judged site's root, by signature. */
  recordOutcome?(signature: string, outcome: UnionOutcome): void;
  /** What the judged site contributes to the branch `slot` names. */
  recordContribution?(slot: string, summary: CarveSummary): void;
}

/** The branch `branch` of the union `signature` names at the root of `site`. */
export function unionSlot(site: string, signature: string, branch: number): string {
  return JSON.stringify([site, signature, branch]);
}

const signatures = new WeakMap<object, string>();

/** What identifies a union node across validations of one schema: its content,
 *  never its identity — a whole schema is held as a copy per validation. */
export function unionSignature(node: object, keyword: string): string {
  let text = signatures.get(node);
  if (text === undefined) {
    const json = JSON.stringify(node) ?? "";
    // FNV-1a over the content, two lanes.
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < json.length; i++) {
      const c = json.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    text = `${a.toString(36)}.${b.toString(36)}.${json.length}`;
    signatures.set(node, text);
  }
  return `${keyword}:${text}`;
}

/** Why a union was kept with everything raised around it instead of decided. */
export type UnionBackstop = "node-unheld" | "branch-unheld" | "reference-unreadable" | "no-located-twin";

const backstopListeners = new Set<(reason: UnionBackstop) => void>();

/** Calls `listener` whenever a union is kept undecided — the reporting backstop,
 *  which a validator holding every document its instance holds never takes. A
 *  test host asserts it stays unused; returns what stops listening. */
export function watchUnionBackstop(listener: (reason: UnionBackstop) => void): () => void {
  backstopListeners.add(listener);
  return () => void backstopListeners.delete(listener);
}

function tookBackstop(reason: UnionBackstop): void {
  for (const listener of backstopListeners) listener(reason);
}

/** Marks a finding standing for a carved site's verdict: decided on, never
 *  reported. */
const SUMMARY = Symbol("carve summary");

function isSummary(finding: LocatedFinding): boolean {
  return (finding as { [SUMMARY]?: true })[SUMMARY] === true;
}

const UNION_KEYWORDS: ReadonlySet<string> = new Set(["anyOf", "oneOf"]);

/** Keywords refusing the value's SHAPE when raised at the union's own node. */
const SHAPE_KEYWORDS: ReadonlySet<string> = new Set([
  "required",
  "type",
  "additionalProperties",
  "false schema",
]);

/** Keywords that discriminate: a refusal at one of the union's tags is positive
 *  evidence that the value is not the branch. */
const TAG_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum"]);

function isUnion(finding: AjvErrorLike): boolean {
  return UNION_KEYWORDS.has(finding.keyword ?? "");
}

/** One judged finding, and — when a union's outcome reported it — that union's
 *  place and outcome, which is all an enclosing branch reads of it. */
interface Judged {
  finding: LocatedFinding;
  via?: {
    readonly place: string;
    readonly outcome: UnionOutcome["kind"];
    /** For `alternatives`, what each alternative was described as. */
    readonly phrases?: readonly string[];
  };
}

/** One union, decided: every finding its branches raise, counted, and what it
 *  reports in their place. */
interface UnionVerdict {
  reproduced: ReadonlyMap<string, number>;
  report: Judged[];
}

/**
 * The findings `errors` stands by, each union decided and each stand-in
 * excused. `errors` is the host's own validation of `judgment.value` against
 * `judgment.schema`, in whatever scope it reports — every error, or only the
 * first; the judge decides the unions in it and adds nothing else.
 */
export function judgeSchemaFindings(
  errors: readonly LocatedFinding[] | null | undefined,
  judgment: SchemaJudgment,
): AjvErrorLike[] {
  const plan = judgment.plan;
  const places = plan?.placesIn(judgment.value);
  const injected = places && judgment.unionsAt ? [...places.places.keys()].flatMap((place) => judgment.unionsAt!(place)) : [];
  if ((!errors || errors.length === 0) && injected.length === 0) return [];
  const carves = plan ? carveStandIns(judgment.value, plan) : new Map<string, string>();
  let standIns = judgment.standIns ?? new Map<string, StandIn>();
  if (carves.size > 0) {
    standIns = new Map(standIns);
    for (const pointer of carves.keys()) (standIns as Map<string, StandIn>).set(pointer, { class: "computed" });
  }
  const rule = standInRule(judgment.value, standIns);
  const raised = errors ?? [];
  const located = raised.some(isUnion) ? locatedFindings(raised, judgment) : raised;
  // No located twin of the list — the schema lies in no held document, or its
  // whole validation raises nothing: nothing is attributed to a union, so every
  // union stays, with what was raised around it.
  if (!located && raised.some(isUnion)) tookBackstop("no-located-twin");
  const judged =
    located || injected.length > 0
      ? new FindingsJudge(judgment, rule, plan && places ? { plan, places, carves } : undefined).judge(
          withInjectedUnions(located ?? raised, injected),
        )
      : standingFindings(withoutTypeConsequences(raised), rule);
  return judged.filter((entry) => !isSummary(entry.finding)).map((entry) => plainFinding(entry.finding));
}

/** Every carve stand-in in `value`, by JSON Pointer, and the carve it is. */
function carveStandIns(value: unknown, plan: UnionPlan): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown, pointer: string): void => {
    const carve = plan.carveOf(node);
    if (carve !== undefined) {
      out.set(pointer, carve);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${pointer}/${i}`));
    else for (const [key, child] of Object.entries(node)) walk(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  };
  walk(value, "");
  return out;
}

/** What makes two union findings one union: where, which keyword, which node. */
function sameUnion(a: LocatedFinding, b: LocatedFinding): boolean {
  return a.keyword === b.keyword && (a.instancePath ?? "") === (b.instancePath ?? "") && a.parentSchema === b.parentSchema;
}

/**
 * `findings` with each of `injected` the validator did not raise, placed before
 * the first union it lies beneath — a validator raises a union after everything
 * its branches raised, which the judge reads outermost first.
 */
function withInjectedUnions(findings: readonly LocatedFinding[], injected: readonly LocatedFinding[]): LocatedFinding[] {
  const out = [...findings];
  for (const union of injected) {
    if (out.some((finding) => isUnion(finding) && sameUnion(finding, union))) continue;
    const place = union.instancePath ?? "";
    const before = out.findIndex((finding) => isUnion(finding) && isBelow(place, finding.instancePath ?? ""));
    out.splice(before < 0 ? out.length : before, 0, union);
  }
  return out;
}

/** Whether JSON Pointer `child` lies strictly beneath `parent`. */
function isBelow(child: string, parent: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + "/");
}

/** The findings a carve's summary stands as, at `pointer` where its stand-in
 *  is: each tag refusal, or one finding a union reports past. */
function summaryEntries(summary: CarveSummary, pointer: string): Judged[] {
  if (summary.state === "valid") return [];
  if (summary.tags.length > 0) {
    return summary.tags.map((tag) => ({
      finding: {
        keyword: tag.keyword,
        instancePath: `${pointer}${tag.at}`,
        params: tag.params,
        message: tag.keyword === "const" ? "must be equal to constant" : "must be equal to one of the allowed values",
        [SUMMARY]: true,
      } as LocatedFinding,
    }));
  }
  return [
    {
      finding: { keyword: "carve", instancePath: pointer, params: {}, message: "is judged at a site of its own", [SUMMARY]: true } as LocatedFinding,
      via: { place: pointer, outcome: "branches" },
    },
  ];
}

/** What a branch's judged findings at or beneath `region` contribute to it: a
 *  refusal at one of the union's tags (`tags`, absolute) not reported through a
 *  union, or any other finding. */
function summarize(
  judged: readonly Judged[],
  region: string,
  clean: boolean,
  tags: ReadonlySet<string>,
): CarveSummary {
  // `tags` here are the union's discriminating places: its tags and selectors.
  const refused: { at: string; keyword: string; params: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  let any = false;
  for (const { finding, via } of judged) {
    const path = finding.instancePath ?? "";
    if (path !== region && !isBelow(path, region)) continue;
    any = true;
    if (via || !TAG_KEYWORDS.has(finding.keyword ?? "") || !tags.has(path)) continue;
    const tag = { at: path.slice(region.length), keyword: finding.keyword!, params: (finding.params ?? {}) as Record<string, unknown> };
    const text = JSON.stringify(tag);
    if (seen.has(text)) continue;
    seen.add(text);
    refused.push(tag);
  }
  return { state: refused.length > 0 ? "tag-refused" : any ? "failing" : "valid", tags: refused, clean };
}

function standingFindings(findings: readonly LocatedFinding[], rule: StandInRule): Judged[] {
  return findings.flatMap((finding) => {
    const kept = rule.standing(finding);
    return kept ? [{ finding: kept }] : [];
  });
}

/** What makes a host's finding and its located twin one finding. */
function twinKey(finding: AjvErrorLike): string {
  return [
    finding.keyword ?? "",
    finding.instancePath ?? "",
    finding.schemaPath ?? "",
    JSON.stringify(finding.params ?? {}),
  ].join("\0");
}

/**
 * `errors` with the schema node behind each union: as given when every union
 * names its node, otherwise the located twins of `errors` from the whole
 * schema's validation. Where that validation does not raise every one of
 * `errors` — the host stopped short of a default the whole schema fills — its
 * own findings are the ones judged. `undefined` when the schema lies in no
 * document the validator holds, or that validation raises nothing.
 */
function locatedFindings(
  errors: readonly LocatedFinding[],
  judgment: SchemaJudgment,
): readonly LocatedFinding[] | undefined {
  if (errors.every((error) => !isUnion(error) || typeof error.parentSchema === "object")) return errors;
  const whole = judgment.validate(judgment.schema, judgment.value);
  if (!whole || whole.length === 0) return undefined;
  const owed = new Map<string, number>();
  for (const error of errors) owed.set(twinKey(error), (owed.get(twinKey(error)) ?? 0) + 1);
  const twins = whole.filter((finding) => {
    const key = twinKey(finding);
    const count = owed.get(key) ?? 0;
    if (count === 0) return false;
    owed.set(key, count - 1);
    return true;
  });
  return twins.length === errors.length ? twins : whole;
}

/** The fields a finding is rendered and anchored from, without the validator's
 *  references into its schema and data. */
function plainFinding(finding: LocatedFinding): AjvErrorLike {
  return {
    ...(finding.keyword !== undefined ? { keyword: finding.keyword } : {}),
    ...(finding.instancePath !== undefined ? { instancePath: finding.instancePath } : {}),
    ...(finding.schemaPath !== undefined ? { schemaPath: finding.schemaPath } : {}),
    ...(finding.message !== undefined ? { message: finding.message } : {}),
    ...(finding.params !== undefined ? { params: finding.params } : {}),
  };
}

/** The schema node a keyword error was raised by: its schemaPath minus the
 *  keyword segment. */
function schemaNodeOf(error: AjvErrorLike): string | undefined {
  const path = error.schemaPath;
  if (typeof path !== "string") return undefined;
  const cut = path.lastIndexOf("/");
  return cut < 0 ? undefined : path.slice(0, cut);
}

/**
 * Where one schema node refused a value's JSON TYPE, every other keyword that
 * node raised against the same value is a consequence of it — an `enum` or a
 * `minLength` judged on a value of the wrong kind — and reported beside it says
 * one mistake twice.
 */
function withoutTypeConsequences<F extends AjvErrorLike>(errors: readonly F[]): F[] {
  const typed = new Set<string>();
  for (const e of errors) {
    const node = schemaNodeOf(e);
    if (e.keyword === "type" && node !== undefined) typed.add(`${e.instancePath ?? ""}\0${node}`);
  }
  if (typed.size === 0) return [...errors];
  return errors.filter((e) => {
    const node = schemaNodeOf(e);
    return e.keyword === "type" || node === undefined || !typed.has(`${e.instancePath ?? ""}\0${node}`);
  });
}

function valueAt(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

/**
 * The state a branch's judged findings put it in, for a union at `place` whose
 * tags are `tags` (absolute). A branch that is no candidate is `type-refused`.
 * A candidate is `tag-refused` only by a `const` / `enum` refusal at one of the
 * tags and `shape-refused` by `required` / `additionalProperties` at the node
 * or a `const` / `enum` refusal of its own at one of the `selectors` (one a union inside it reported is a tag finding of that union, not of the branch), any other refusal
 * leaving it `failing`.
 *
 * A union the branch holds AT `place` (a branch naming a shape that is itself a
 * union) is one union with the outer one, so its outcome is the branch's: no
 * alternative there refuses the shape, and anything else it reported is
 * judged as any other finding. What a union further in reported reads as
 * `failing`: the branch reached it, so it accepted the value's shape that far.
 */
function branchState(
  judged: readonly Judged[],
  place: string,
  candidate: boolean,
  tags: ReadonlySet<string>,
  selectors: ReadonlySet<string>,
): BranchState {
  if (!candidate) return { state: "type-refused" };
  if (judged.length === 0) return { state: "valid" };
  const at: string[] = [];
  let shapeRefused = false;
  for (const { finding, via } of judged) {
    const path = finding.instancePath ?? "";
    const keyword = finding.keyword ?? "";
    if (via && via.place !== place) continue;
    if (via?.outcome === "alternatives") shapeRefused = true;
    else if (via && via.outcome !== "tag") continue;
    else if (TAG_KEYWORDS.has(keyword) && tags.has(path)) {
      if (!at.includes(path)) at.push(path);
    } else if (path === place && SHAPE_KEYWORDS.has(keyword)) shapeRefused = true;
    else if (!via && TAG_KEYWORDS.has(keyword) && selectors.has(path)) shapeRefused = true;
  }
  if (at.length > 0) return { state: "tag-refused", at };
  return shapeRefused ? { state: "shape-refused" } : { state: "failing" };
}

/**
 * How the alternatives at a union node are described, one phrase each, read off
 * what its branches said at the node — one phrase per missing key, since a
 * branch requiring two keys at once listed as one phrase would claim a
 * conjunction the schema may not hold.
 */
function describeAlternatives(judged: readonly Judged[], place: string, selectors: ReadonlySet<string>): string[] {
  const phrases: string[] = [];
  const add = (phrase: string) => {
    if (!phrases.includes(phrase)) phrases.push(phrase);
  };
  for (const { finding: e, via } of judged) {
    if (!via && TAG_KEYWORDS.has(e.keyword ?? "") && selectors.has(e.instancePath ?? "")) {
      const member = (e.instancePath ?? "").slice(place.length + 1);
      if (e.keyword === "const") add(`one with '${member}' equal to ${JSON.stringify(e.params?.allowedValue)}`);
      else {
        const allowed = (e.params?.allowedValues as unknown[] | undefined) ?? [];
        add(
          allowed.length <= LISTED_ENUM_VALUES
            ? `one with '${member}' one of ${allowed.join(" | ")}`
            : `one with '${member}' one of ${allowed.length} allowed values`,
        );
      }
      continue;
    }
    if ((e.instancePath ?? "") !== place) continue;
    // A union at this node read none of its alternatives either: its own are
    // these.
    if (via?.place === place && via.phrases) {
      via.phrases.forEach(add);
      continue;
    }
    if (e.keyword === "required") add(`one with '${e.params?.missingProperty}'`);
    else if (e.keyword === "type") add(`a ${e.params?.type}`);
    else if (e.keyword === "enum") {
      const allowed = (e.params?.allowedValues as unknown[] | undefined) ?? [];
      add(
        allowed.length <= LISTED_ENUM_VALUES
          ? `one of ${allowed.join(" | ")}`
          : `one of ${allowed.length} allowed values`,
      );
    }
  }
  return phrases.length > 0 ? phrases : ["another shape"];
}

class FindingsJudge {
  private readonly verdicts = new Map<string, UnionVerdict | undefined>();
  private readonly readings = new Map<string, UnionReading>();
  private readonly nodeIds = new WeakMap<object, number>();
  private nextNodeId = 0;

  constructor(
    private readonly judgment: SchemaJudgment,
    private readonly rule: StandInRule,
    private readonly parts?: {
      readonly plan: UnionPlan;
      readonly places: UnionPlaces;
      readonly carves: ReadonlyMap<string, string>;
    },
  ) {}

  private nodeId(node: unknown): string {
    if (node === null || typeof node !== "object") return "-";
    let id = this.nodeIds.get(node);
    if (id === undefined) this.nodeIds.set(node, (id = this.nextNodeId++));
    return String(id);
  }

  /** What makes two findings one: where, what, raised by which node, how. */
  private findingKey(finding: LocatedFinding): string {
    return [
      finding.instancePath ?? "",
      finding.keyword ?? "",
      this.nodeId(finding.parentSchema),
      JSON.stringify(finding.params ?? {}),
    ].join("\0");
  }

  /** `findings` with every union replaced by what it reports and everything
   *  else held to the stand-in rule, in place. */
  judge(findings: readonly LocatedFinding[]): Judged[] {
    const list = withoutTypeConsequences(findings);
    const live: (LocatedFinding | undefined)[] = [...list];
    const reports = new Map<number, Judged[]>();
    let positions: Map<string, number[]> | undefined;
    // Outermost first: a validator reports a union after everything its
    // branches raised, nested unions included.
    for (let k = live.length - 1; k >= 0; k--) {
      const union = live[k];
      if (!union || !isUnion(union)) continue;
      const verdict = this.verdictOf(union);
      if (!verdict) continue;
      live[k] = undefined;
      reports.set(k, verdict.report);
      positions ??= this.positionsByKey(list);
      // What the branches reproduce is dropped nearest the union first. Unions
      // are met in descending order, so a position at or past this one is never
      // asked for again, and one a list still holds below it is live.
      for (const [key, count] of verdict.reproduced) {
        const at = positions.get(key);
        if (!at) continue;
        while (at.length > 0 && at[at.length - 1]! >= k) at.pop();
        for (let owed = count; owed > 0 && at.length > 0; owed--) live[at.pop()!] = undefined;
      }
    }
    const out: Judged[] = [];
    live.forEach((finding, index) => {
      const report = reports.get(index);
      if (report) out.push(...report);
      else if (finding) {
        const kept = this.rule.standing(finding);
        if (kept) out.push({ finding: kept });
      }
    });
    return out;
  }

  /** Where each finding sits, by what makes two findings one, ascending. */
  private positionsByKey(findings: readonly LocatedFinding[]): Map<string, number[]> {
    const positions = new Map<string, number[]>();
    findings.forEach((finding, index) => {
      const key = this.findingKey(finding);
      const at = positions.get(key);
      if (at) at.push(index);
      else positions.set(key, [index]);
    });
    return positions;
  }

  /** A union decided once per (union node, value location); `undefined` when a
   *  branch lies in no held document, or while the union is being decided. */
  private verdictOf(union: LocatedFinding): UnionVerdict | undefined {
    const node = union.parentSchema;
    const branches = union.schema;
    if (node === null || typeof node !== "object" || !Array.isArray(branches)) {
      tookBackstop("node-unheld");
      return undefined;
    }
    const place = union.instancePath ?? "";
    const key = [this.nodeId(node), union.keyword, place].join("\0");
    if (this.verdicts.has(key)) return this.verdicts.get(key);
    this.verdicts.set(key, undefined);
    let verdict: UnionVerdict | undefined;
    try {
      verdict = this.decide(union, branches, place);
    } catch (error) {
      // A reference the reader cannot follow leaves the union undecided, as one
      // lying in no held document is.
      if (!(error instanceof UnreadableReference)) throw error;
      tookBackstop("reference-unreadable");
    }
    this.verdicts.set(key, verdict);
    return verdict;
  }

  /** The candidates, tags and selectors of the union at `node` for a value of one JSON
   *  type, read once per (node, type). */
  private readingOf(node: object, keyword: string, branches: readonly unknown[], value: unknown): UnionReading {
    const type = jsonTypeOf(value);
    const key = [this.nodeId(node), keyword, type].join("\0");
    let reading = this.readings.get(key);
    if (!reading) this.readings.set(key, (reading = readUnion(branches, type, this.judgment.reference, node)));
    return reading;
  }

  private decide(union: LocatedFinding, branches: readonly unknown[], place: string): UnionVerdict | undefined {
    const value = valueAt(this.judgment.value, place);
    const reading = this.readingOf(union.parentSchema as object, union.keyword!, branches, value);
    const tags = new Set(reading.tags.map((tag) => `${place}${tag}`));
    const selectors = new Set(reading.selectors.map((selector) => `${place}${selector}`));
    const discriminating = new Set([...tags, ...selectors]);
    const reproduced = new Map<string, number>();
    const judged: Judged[][] = [];
    // A union at a cut site's root: each carve beneath it stands as its
    // summary for the branch, and — the judged site lying beneath — the
    // judged site's own verdict per branch is what it contributes.
    const parts = this.parts;
    const at = parts?.places.places.get(place);
    const signature = at ? unionSignature(union.parentSchema as object, union.keyword!) : undefined;
    const region = parts?.places.region;
    /** Per branch, whether the validator raised nothing there — carves read by
     *  their summaries. */
    const clean: boolean[] = [];
    for (const [i, branch] of branches.entries()) {
      const raised = this.branchFindings(branch, value, place);
      if (!raised) {
        tookBackstop("branch-unheld");
        return undefined;
      }
      for (const finding of raised) {
        const id = this.findingKey(finding);
        reproduced.set(id, (reproduced.get(id) ?? 0) + 1);
      }
      const entries = this.judge(raised);
      if (at && parts) {
        const slot = unionSlot(at.site, signature!, i);
        const carved: string[] = [];
        let summariesClean = true;
        for (const [pointer, carve] of parts.carves) {
          if (!isBelow(pointer, place)) continue;
          carved.push(pointer);
          const summary = parts.plan.summary(carve, slot);
          if (!summary) continue;
          summariesClean &&= summary.clean;
          entries.push(...summaryEntries(summary, pointer));
        }
        const rawIn = (root: string) =>
          raised.some((finding) => {
            const path = finding.instancePath ?? "";
            return (path === root || isBelow(path, root)) && !carved.some((c) => path === c || isBelow(path, c));
          });
        clean.push(summariesClean && !rawIn(place));
        if (region !== undefined && isBelow(region, place)) {
          const regionClean =
            !rawIn(region) &&
            [...parts.carves].every(([pointer, carve]) => !isBelow(pointer, region) || parts.plan.summary(carve, slot)?.clean !== false);
          parts.plan.recordContribution?.(slot, summarize(entries, region, regionClean, discriminating));
        }
      }
      judged.push(entries);
    }
    let outcome: UnionOutcome;
    if (at?.forced) {
      const selected = at.forced.get(signature!);
      if (!selected) {
        throw new Error(`internal: the union at '${place}' of site ${at.site} was decided by no judgement of that site.`);
      }
      outcome = selected;
    } else {
      outcome = unionOutcome(
        union.keyword as "anyOf" | "oneOf",
        judged.map((entries, i) => branchState(entries, place, reading.candidate[i]!, tags, selectors)),
      );
    }
    if (at && parts && place === region) parts.plan.recordOutcome?.(signature!, outcome);
    return { reproduced, report: this.report(outcome, union, judged, place, selectors, at ? clean : undefined) };
  }

  /** What `branch` raises against `value` on its own, located at `place`. A
   *  boolean branch is decided where it stands: `true` holds every value,
   *  `false` refuses it at the node. */
  private branchFindings(branch: unknown, value: unknown, place: string): LocatedFinding[] | undefined {
    if (branch === true) return [];
    if (branch === false) {
      return [{ keyword: "false schema", instancePath: place, params: {}, message: "boolean schema is false" }];
    }
    if (branch === null || typeof branch !== "object") return undefined;
    const raised = this.judgment.validate(branch, value);
    if (!raised) return undefined;
    return raised.map((finding) => ({ ...finding, instancePath: `${place}${finding.instancePath ?? ""}` }));
  }

  /** The findings an outcome reports, each marked as a union's. */
  private report(
    outcome: UnionOutcome,
    union: LocatedFinding,
    judged: readonly Judged[][],
    place: string,
    selectors: ReadonlySet<string>,
    clean?: readonly boolean[],
  ): Judged[] {
    const via = { place, outcome: outcome.kind };
    const reported = (finding: LocatedFinding): Judged => ({ finding, via });
    switch (outcome.kind) {
      case "pass":
        return [];
      case "ambiguous":
        // Which of several matching branches a value takes is decided by its
        // content, so the finding is excused where the value is a stand-in's —
        // and a stand-in made the matching branches more than the host found.
        if (clean) {
          // A union read in parts: the branches the validator would pass on the
          // whole value are those raising nothing, carves read by summary.
          const passing = clean.flatMap((ok, i) => (ok ? [i] : []));
          if (passing.length < 2 || this.rule.excused(union)) return [];
          return [reported({ ...union, params: { ...union.params, passingSchemas: passing.slice(0, 2) } })];
        }
        return isAmbiguousOneOf(union) && !this.rule.excused(union) ? [reported(union)] : [];
      case "branches": {
        const seen = new Set<string>();
        const out: Judged[] = [];
        for (const index of outcome.branches) {
          for (const entry of judged[index]!) {
            const text = `${entry.finding.instancePath ?? ""}\0${formatSingleError(entry.finding)}`;
            if (seen.has(text)) continue;
            seen.add(text);
            out.push(reported(entry.finding));
          }
        }
        return out;
      }
      case "tag": {
        const allowed: unknown[] = [];
        for (const index of outcome.branches) {
          for (const { finding, via } of judged[index]!) {
            if ((via && (via.place !== place || via.outcome !== "tag")) || (finding.instancePath ?? "") !== outcome.at) {
              continue;
            }
            const values =
              finding.keyword === "const"
                ? [finding.params?.allowedValue]
                : finding.keyword === "enum"
                  ? ((finding.params?.allowedValues as unknown[] | undefined) ?? [])
                  : [];
            for (const value of values) if (!allowed.includes(value)) allowed.push(value);
          }
        }
        // Without the union node's `data`: the refusal is of the tag, not the node.
        const { data, ...rest } = union;
        return [
          reported({
            ...rest,
            keyword: "enum",
            instancePath: outcome.at,
            params: { allowedValues: allowed },
            message: "must be equal to one of the allowed values",
          }),
        ];
      }
      case "alternatives": {
        const phrases = describeAlternatives(judged.flat(), place, selectors);
        return [
          {
            finding: {
              ...union,
              instancePath: place,
              message: `matches no alternative — expected ${phrases.join(", or ")}`,
            },
            via: { ...via, phrases },
          },
        ];
      }
    }
  }
}
