/**
 * Every judgement of a CEL site, for whoever counts them: which site, under
 * which key, and whether a configuration run made it — which none should, a
 * site being judged once per key outside every configuration run.
 *
 * Browser-safe.
 */

export interface CelSiteJudgement {
  /** The site judged, at a run judging sites; undefined elsewhere. */
  readonly site: string | undefined;
  readonly key: string | undefined;
  readonly configurationRun: boolean;
}

let observer: ((judgement: CelSiteJudgement) => void) | undefined;

/** Observe every judgement until the returned function is called. */
export function observeCelSiteJudgements(listener: (judgement: CelSiteJudgement) => void): () => void {
  observer = listener;
  return () => {
    if (observer === listener) observer = undefined;
  };
}

export function reportCelSiteJudgement(judgement: CelSiteJudgement): void {
  observer?.(judgement);
}

/**
 * What one analysis pass over a manifest set is for: the whole analysis of a
 * set holding no choice, the registration every configuration reads, one
 * configuration, a branch no configuration takes — or the environment one key
 * of a CEL site (`door`) or of a declaration's own checks (`own`) is judged in,
 * which is no analysis of a configuration at all.
 */
export type AnalysisRunPurpose = "whole" | "setup" | "configuration" | "unreachable" | "door" | "own";

let runObserver: ((purpose: AnalysisRunPurpose) => void) | undefined;

/** Observe every analysis pass until the returned function is called. */
export function observeAnalysisRuns(listener: (purpose: AnalysisRunPurpose) => void): () => void {
  runObserver = listener;
  return () => {
    if (runObserver === listener) runObserver = undefined;
  };
}

export function reportAnalysisRun(purpose: AnalysisRunPurpose): void {
  runObserver?.(purpose);
}

/**
 * What building the environments of an analysis's keys costs, for whoever
 * measures it: a declaration normalized (whether no configuration varies it,
 * and the outcome of each reference it stamps), a scope resolved for a site,
 * a typed CEL environment built (by the content it is keyed on), and each
 * key's whole judgement timed.
 */
export type KeyCost =
  /** A declaration normalized: whether no configuration its key is judged for
   *  varies it, whether that key is one a kept configuration holds (no branch
   *  forced at its witness), and the outcome of each reference it stamps. */
  | {
      readonly kind: "normalization";
      readonly declaration: object;
      readonly invariant: boolean;
      readonly live: boolean;
      readonly outcomes: string;
    }
  | { readonly kind: "scope" }
  | { readonly kind: "typed-environment"; readonly content: string }
  /** One key's environment built: whether its key is one a kept configuration
   *  holds, and how many declarations and forward views present at its
   *  witness the configurations it is judged for vary. */
  | { readonly kind: "varying"; readonly live: boolean; readonly declarations: number }
  /** A region of a declaration normalized on its own, and the nodes it holds. */
  | { readonly kind: "region"; readonly declaration: object; readonly nodes: number }
  /** One key of a relation site judged, and the nodes of its declaration its
   *  environment holds: the anchor, the places it reads and what encloses
   *  them. */
  | { readonly kind: "relation"; readonly site: string; readonly nodes: number }
  /** One key of a CEL site or of a schema own-check site judged, and the nodes
   *  of declarations its environment normalized for it beside the shared
   *  layer. */
  | { readonly kind: "cel" | "schema"; readonly site: string; readonly nodes: number }
  /** A schema own-check site's own extent where one of its keys is read,
   *  counted from the union as written: reported just before that key is
   *  judged. */
  | { readonly kind: "schema-extent"; readonly site: string; readonly nodes: number }
  /** A place a schema own-check key reads beyond its region that another
   *  site's region holds — a sibling site's or a carved sub-site's — or that
   *  holds a carved sub-site: reported before the key is judged. */
  | { readonly kind: "carve-read"; readonly site: string; readonly keys: readonly (string | number)[] }
  /** One key about to be judged: its site, the declaration, the union place
   *  (a template body's site has none) and template variant it is judged in,
   *  its role — held by a kept configuration (`live`), a branch's no
   *  configuration takes (`dead`), or judged for the whole space where such a
   *  branch reads a site outside its reach (`whole-care`) — whether its site
   *  is absent at its witness, the places it reads beyond the site, and what
   *  its classes cover beyond the site's own region. */
  | {
      readonly kind: "key-presence";
      readonly family: "cel" | "schema" | "relation";
      readonly site: string;
      readonly declaration: object;
      readonly unionKeys: readonly (string | number)[] | undefined;
      readonly variant: number;
      readonly role: "live" | "dead" | "whole-care";
      readonly absent: boolean;
      readonly reads: number;
      readonly covered: number;
    }
  /** A CEL key read at a witness forcing a branch no configuration takes — a
   *  step read's producer, a carved step's fact, facts at a written place —
   *  its site, its key text and the role of the key answering. */
  | {
      readonly kind: "forced-read";
      readonly site: string;
      readonly text: string;
      readonly role: "live" | "dead" | "whole-care";
    }
  /** A CEL key's own extent at its witness, counted from the union as
   *  written: reported just before that key is judged. */
  | { readonly kind: "cel-extent"; readonly site: string; readonly nodes: number }
  /** A computed step's result typed in its own site's environment: `body` the
   *  step context it belongs to, `producer` where its value is written. */
  | { readonly kind: "step-result-probe"; readonly body: object; readonly producer: string }
  /** Which objects beneath one declaration the runs analyse as declarations
   *  of their own, settled for its own-check cut: the enumerations it took,
   *  and how long settling took. */
  | { readonly kind: "nested-places"; readonly enumerations: number; readonly milliseconds: number }
  /** One declaration's own-check sites cut, and how long cutting took. */
  | { readonly kind: "own-cut"; readonly milliseconds: number }
  /** One analysis pass over a manifest set, and how long it took. */
  | { readonly kind: "run"; readonly purpose: AnalysisRunPurpose; readonly milliseconds: number }
  /** One key's environment built — a CEL key's, a schema own-check key's or a
   *  relation key's (an own-check key of the forward-view site included) — and
   *  its site judged, and how long it took. */
  | {
      readonly kind: "door";
      readonly family: "cel" | "schema" | "relation";
      readonly site: string;
      readonly milliseconds: number;
    }
  /** The nodes one key's environment normalized, in any family, reported once
   *  it is built: every declaration it holds whole and every region, a
   *  declaration it reaches by name counted by the regions it holds of it — of
   *  those, the nodes of the declarations reached by name, and their extent
   *  counted from the union as written — and the declarations reached by name
   *  it normalized whole that are no named shape (`wholeByName`), each as
   *  `<reader>:<name>`. */
  | {
      readonly kind: "door-nodes";
      readonly family: "cel" | "schema" | "relation";
      readonly site: string;
      readonly nodes: number;
      readonly byNameNodes: number;
      readonly byNameExtent: number;
      readonly wholeByName: number;
      readonly wholeByNameReads: readonly string[];
    };

let costObserver: ((cost: KeyCost) => void) | undefined;

/** Observe every cost until the returned function is called. */
export function observeKeyCosts(listener: (cost: KeyCost) => void): () => void {
  costObserver = listener;
  return () => {
    if (costObserver === listener) costObserver = undefined;
  };
}

export function reportKeyCost(cost: KeyCost): void {
  costObserver?.(cost);
}

/** Whether anything observes costs: a cost's text is built only then. */
export function observingKeyCosts(): boolean {
  return costObserver !== undefined;
}

/**
 * What the relation census and the region parts are held to, for whoever
 * checks them: at every configuration and every forced branch, a group's
 * enumeration of a declaration normalized whole against the census anchors
 * holding there, and each anchor's and read place's region normalized on its
 * own against the whole normalization restricted to it. Each mismatch names
 * what differs; none is reported where they agree. Checked only while
 * observed.
 */
export interface RelationParityReport {
  readonly witness: string;
  readonly census: readonly string[];
  readonly regions: readonly string[];
  /** Each relation site whose findings judged on its carved regions differ
   *  from those judged on the same regions whole, and each CEL or own-check
   *  site whose findings judged in its key's environment differ from those
   *  judged on its declarations whole with the module documents whole. */
  readonly carves: readonly string[];
  /** Where the observed-state class's flag differs from that of every
   *  declaration and view present, or from a configuration run's own. */
  readonly observed: readonly string[];
  /** Each CEL, own-check or relation site whose findings — and a CEL site's
   *  facts — judged with the declarations its key reaches by name held whole
   *  differ from those judged with the parts its key holds of them. */
  readonly byName: readonly string[];
  /** How many CEL and own-check sites the carve comparison judged, and how
   *  many of the CEL sites are a forward view's. */
  readonly keySites: { readonly cel: number; readonly own: number; readonly views: number };
  /** How many anchors were compared, by group, and region places. */
  readonly anchors: number;
  readonly anchorsByGroup: Readonly<Record<string, number>>;
  readonly places: number;
}

let parityObserver: ((report: RelationParityReport) => void) | undefined;

/** Observe the parity of every witness until the returned function is called. */
export function observeRelationParity(listener: (report: RelationParityReport) => void): () => void {
  parityObserver = listener;
  return () => {
    if (parityObserver === listener) parityObserver = undefined;
  };
}

export function reportRelationParity(report: RelationParityReport): void {
  parityObserver?.(report);
}

export function observingRelationParity(): boolean {
  return parityObserver !== undefined;
}

let identifierObserver: ((configurationRun: boolean) => void) | undefined;

/** Observe every run of the identifier pass — inside a configuration run or
 *  judging a key — until the returned function is called. */
export function observeIdentifierPasses(listener: (configurationRun: boolean) => void): () => void {
  identifierObserver = listener;
  return () => {
    if (identifierObserver === listener) identifierObserver = undefined;
  };
}

export function reportIdentifierPass(configurationRun: boolean): void {
  identifierObserver?.(configurationRun);
}

/** The whole-application passes that carry presence conditions. */
export type ConditionedPass = "duplicateNames" | "unusedDeclarations" | "sinkAttachment" | "observedStateDeclarations";

let conditionedPassObserver: ((pass: ConditionedPass, configurationRun: boolean) => void) | undefined;

/** Observe every run of a condition-carrying pass — over the union, once, or
 *  inside a configuration run — until the returned function is called. */
export function observeConditionedPasses(listener: (pass: ConditionedPass, configurationRun: boolean) => void): () => void {
  conditionedPassObserver = listener;
  return () => {
    if (conditionedPassObserver === listener) conditionedPassObserver = undefined;
  };
}

export function reportConditionedPass(pass: ConditionedPass, configurationRun: boolean): void {
  conditionedPassObserver?.(pass, configurationRun);
}

/** The families whose rules are evaluated: a kind's resource rules, its
 *  referrer rules, and the duplicate texts of a catalog set. */
export type RuleFamily = "resourceRules" | "referrerRules" | "catalogSets";

let ruleObserver: ((family: RuleFamily, configurationRun: boolean) => void) | undefined;

/** Observe every evaluation of a rule family — inside a keyed configuration
 *  run or judging a key — until the returned function is called. */
export function observeRuleEvaluations(listener: (family: RuleFamily, configurationRun: boolean) => void): () => void {
  ruleObserver = listener;
  return () => {
    if (ruleObserver === listener) ruleObserver = undefined;
  };
}

export function reportRuleEvaluation(family: RuleFamily, configurationRun: boolean): void {
  ruleObserver?.(family, configurationRun);
}
