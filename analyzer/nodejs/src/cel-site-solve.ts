/**
 * CEL typing and a declaration's own schema checks judged once per site and
 * key, over every configuration at once.
 *
 * A SITE is one expression as written. Its FOOTPRINT is its branch path (the
 * option of every choice on the way to it, fixed per site) plus every READ it
 * makes: the member chains of its parsed tree, its module calls, and what the
 * annotations covering it read (`annotation-reads.ts`). A KEY is one class per
 * read — what the read yields:
 *  - an input: its decided value (and presence), the condition of the class the
 *    cube of the dimensions deciding it;
 *  - a step result: the type the producing expression's key yields, the
 *    condition the OR of the producer keys yielding it; any other step, its
 *    content;
 *  - a declaration, region or reference: its projected content and presence,
 *    the condition the options taken inside it — a declaration read by name (a
 *    `resources.<name>` read, a module call) only as its identity and the
 *    places its reading is typed from, never whole;
 *  - whether any declaration reports observed state (a site typed through the
 *    observed-state context, or reading observed state): the condition every
 *    declaration that may report holding as it does at the witness.
 * A key's condition is the site's own condition AND each class's.
 *
 * The WITNESS LOOP judges each site once per distinct key: the remaining
 * condition R starts as the site's; its first assignment w is a witness; the
 * key and its condition are read at w; the unchanged check runs in the key's
 * own environment (the DOOR, `judgeKey`), built from what the key's classes
 * cover at w; and R loses the key's condition, until nothing remains. Sites are
 * solved in the order of their step reads, so a producer's keys are known
 * before a reader's classes are read; a group reading each other's steps reads
 * them by content. Every key some configuration holds is judged for the
 * configurations kept (`universe`, the care set): its condition holds only
 * there, and its door holds fixed what none of them varies. A site inside a
 * branch no configuration takes has one key, witnessed at the configuration
 * reaching its choice with the branch forced, under the condition FALSE; a
 * site outside the branch's reach its keys read gets a WHOLE-CARE key there,
 * judged for the whole space, read for its facts alone and shared by key text
 * among whole-care keys alone — never a key judged for the kept configurations,
 * whose door holds fixed what the witness may vary.
 *
 * Every class says what it COVERS (`KeyCoverage`): the door answers a request
 * only from what the key covers, and refuses the rest.
 *
 * A key judges its site on its REGION (`CelRegion`), never its declaration
 * whole: the site, the places its annotations and contracts read beyond it,
 * the step objects it reads, `inputType` and the names declared in the scopes
 * on the way — each member its identity, its content only as the places a
 * class reads in it. A read
 * step whose tagged value another group's key types — a forward included — is
 * carved, its stand-in carrying that key's fact (the recorded type and the
 * forwarded schema, which a reader's key takes as one class); a held value
 * reaches no further steps. The `steps` record is closed over the names the
 * key covers. A kind document's sites, a template body's and those of a
 * declaration holding an inline declaration or scope member that forwards are
 * judged on the declaration whole.
 *
 * A forward view's expression is a site of the view, keyed and judged on the
 * view's regions as any declaration's, its id the place the consumer wrote it
 * at; the consumer's own site there holds only where no view built from it
 * holds the expression. One written place may so be several sites, their
 * keys merged per place where several hold together.
 *
 * A declaration's own schema checks are solved the same way, per SITE of
 * `own-check-sites.ts` — a declaration, or a region a choice in it is cut out
 * by: a key is the region's content as the witness projects it (its cut
 * regions aside), the named shapes its kinds' schemas reach, the inputs its
 * expressions read, and what every annotation in it reads; a template
 * definition's is judged per variant. A configuration run marks where each
 * declaration's findings go (`OWN_SITE_MARKER`), by the written place of the
 * declaration they were judged on.
 *
 * Nothing here type-checks: the door judges a site with the checks as they are.
 *
 * Browser-safe.
 */
import { childNodes, type CelNode } from "@telorun/cel";
import type { ResourceManifest } from "@telorun/sdk";
import {
  celExpressionsOf,
  expansionTagLabel,
  extractAccessChains,
  INDEX_SEGMENT,
  isRefSentinel,
  isTaggedSentinel,
  moduleCallOf,
} from "@telorun/templating";
import { readReporterOf } from "./annotation-reads.js";
import { observingKeyCosts, reportKeyCost } from "./cel-site-judgements.js";
import { countNodes, regionExtent } from "./key-parts.js";
import { parseCelSource } from "./cel-environment.js";
import { stepNamesReadBy, stepRecordBodies, stepRecordNames } from "./cel-scope.js";
import { contractReads } from "./invocation-contract.js";
import { narrowingAt } from "./key-door.js";
import type { ChoiceReading } from "./choice-reading.js";
import {
  isAlternatives,
  takenAt,
  type AlternativeOption,
  type Alternatives,
  type ChoiceStep,
  type ConditionedDeclaration,
  type ConditionedExpansion,
  type ConditionedView,
  type Forcing,
  type Witness,
  viewChainOf,
} from "./conditioned-expansion.js";
import { assignmentKey, type Assignment } from "./configuration-dimensions.js";
import type { ConditionedNameIndex } from "./conditioned-name-index.js";
import { isKindDocument } from "./kind-declaration.js";
import { isModuleKind } from "./module-kinds.js";
import { isOptionalResourceInput } from "./resource-input.js";
import { observedStateRead } from "./validate-observed-state.js";
import { ownSitesOf, type OwnSite, type OwnSiteSchemas } from "./own-check-sites.js";
import { valueDerivedSlot } from "./value-derived-contract.js";
import { callableInstanceFields } from "./callable-signature.js";
import { CARVED_PLACE, placeByProjectedKeys, placeByUnionKeys, regionSkeleton, scopePlacesOf } from "./region-part.js";
import { isAtOrAbove, relationSiteId, type RelationReads, type RelationTarget } from "./relation-sites.js";
import { FALSE, TRUE, type Condition } from "./presence-condition.js";
import { READS_IDENTITY, type ReadKeys, type ReadPlace, type Referent, type ReferentPlace, type ReferentReads, type ReferrerReads } from "./read-place.js";
import type { ScopeSite } from "./scope-address.js";
import { FactIdentities, producerFact, type StepFact } from "./step-result-inference.js";
import { parseKeys, pathText, TEMPLATE_BODY_FIELDS } from "./template-expansion.js";
import { templateBodyReference, type TemplateBodyTarget } from "./template-body-lookup.js";
import type { AnalysisDiagnostic } from "./types.js";

type Keys = readonly (string | number)[];

/** What one judgement of a site found: its findings at their written place,
 *  and the CEL facts of each occurrence, in walk order. */
export interface CelSiteVerdict {
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly facts: readonly CelOccurrenceFacts[];
}

/** What one occurrence of a site was typed as. */
export interface CelOccurrenceFacts {
  /** Where a run meets the occurrence: its position in the layout of forward
   *  views the door judging it built (`[0, view]` for a view's own, `[1, view,
   *  drawn]` for one its slots drew out), empty outside every view. */
  readonly layout: readonly number[];
  readonly source: string;
  readonly type?: string;
  readonly literal?: string;
  readonly produced?: Record<string, any>;
  readonly composed?: unknown;
  /** Per referrer typing, when the site was judged under several. */
  readonly variants?: ReadonlyArray<{
    readonly type?: string;
    readonly literal?: string;
    readonly produced?: Record<string, any>;
    readonly composed?: unknown;
    readonly label?: string;
  }>;
}

/** One template-body site of a variant: its expressions, as the body's
 *  expansion in that variant holds them. */
export interface CensusEntry {
  readonly occurrences: number;
  /** Each occurrence's expression. */
  readonly expressions: readonly { readonly engine: string; readonly source: string }[];
  /** The module the site's declaration is written in, its instance, and the
   *  names a call's receiver may be there. */
  readonly module?: string;
  readonly importPath?: readonly string[];
  readonly moduleNames: ReadonlySet<string>;
  /** The definition holding it, as written. */
  readonly holder: ResourceManifest;
}

/** Why a class holds the declarations of a name whole: a named shape, whose
 *  whole is the schema read (`shape`) — the one whole hold by name that holds
 *  no more than its reader reads, given only when every declaration of the
 *  name is one, whatever reached it — or a reader not yet held to the places
 *  it reads: a name a schema, a contract or an annotation value holds
 *  (`schema`). */
export type WholeNameReader = "shape" | "schema";

/** What a key's classes cover: everything its door may answer beyond the
 *  site's own declaration and the declarations no configuration varies. */
export interface KeyCoverage {
  /** Every declaration of each name, present or absent, with its content. */
  readonly names: ReadonlySet<string>;
  /** Of {@link names}, the readers holding each name whole. */
  readonly wholeReads: ReadonlyMap<string, ReadonlySet<WholeNameReader>>;
  /** Every declaration of each name, present or absent, held as the places
   *  its reader reads in it ({@link parts}) — a CEL `resources.<name>` read's,
   *  a module call's, an annotation's reference or referrers read's — never
   *  whole. */
  readonly named: ReadonlySet<string>;
  /** What a reference to each name resolves to. */
  readonly outcomes: ReadonlySet<string>;
  /** Each declaration a reference resolves to whose regions the key reads,
   *  by the union paths of those regions at the key's witness: all the key
   *  holds of it — never the declaration whole. */
  readonly parts: ReadonlyMap<ConditionedDeclaration, readonly Keys[]>;
  /** The declarations referencing each name. */
  readonly referrers: ReadonlySet<string>;
  /** Which declarations there are. */
  readonly presence: boolean;
  /** Whether any declaration reports observed state, when the key holds it. */
  readonly observed?: boolean;
}

/** One key to judge: the site, where the key is read, and what it covers. */
export interface KeyRequest {
  readonly site: string;
  readonly key: string;
  readonly declaration: ConditionedDeclaration;
  readonly witness: Witness;
  readonly variant: number;
  readonly coverage: KeyCoverage;
  /** The region of its declaration the key judges the site on, read at the
   *  witness judging it; absent, the declaration whole (a kind document's
   *  site, or one of a declaration holding nested forwards). */
  readonly region?: (witness: Witness) => CelRegion;
  /** Judged on its declarations normalized whole, the module documents whole
   *  and the witness's narrowing whole: carve parity's reference side. */
  readonly whole?: boolean;
  /** Judged with the declarations it reaches by name held whole, all else as
   *  its key holds it: by-name parity's reference side. */
  readonly byNameWhole?: boolean;
}

/** One key of a declaration's own-check site to judge. */
export interface OwnKeyRequest {
  readonly site: OwnSite;
  readonly key: string;
  readonly witness: Witness;
  readonly variant: number;
  readonly coverage: KeyCoverage;
  /** Every site of the declaration: what a finding is attributed among. */
  readonly sites: readonly OwnSite[];
  /** As {@link KeyRequest.whole}. */
  readonly whole?: boolean;
  /** As {@link KeyRequest.byNameWhole}. */
  readonly byNameWhole?: boolean;
  /** The places of the declaration a schema key reads beyond its site's
   *  region, by their projected keys: what its region is judged with. */
  readonly reads: readonly Keys[];
}

/** What one judgement of an own-check site found: its findings at their
 *  written place, each carrying `data.ownOrigin`, the written place of the
 *  declaration it was judged on — the run's marker it is placed at. */
export interface OwnVerdict {
  readonly diagnostics: readonly AnalysisDiagnostic[];
  /** The written place of every declaration judged, found or not. */
  readonly origins: readonly string[];
}

export interface CelSiteSolveInput {
  readonly union: ConditionedExpansion;
  /** Name resolution over the union, built once per analysis. */
  readonly names: ConditionedNameIndex;
  /** The configurations analysed, as one condition. */
  readonly universe: Condition;
  readonly choices: ChoiceReading;
  /** How many variants each template definition's body is judged in. */
  readonly variants: number;
  /** The names a CEL call's receiver may be in `manifest`'s module. */
  readonly moduleNamesOf: (manifest: ResourceManifest) => ReadonlySet<string>;
  /** The fields a declaration of `holder`'s kind declares a scope at. */
  readonly scopeFieldsOf: (holder: { readonly kind: unknown; readonly metadata: unknown }) => readonly string[];
  /** The effective author schema of `declaration`'s kind, read in the module
   *  `within` was written in. */
  readonly schemaOf: (declaration: Record<string, any>, within: ResourceManifest) => Record<string, any> | undefined;
  /** The definition `declaration`'s kind resolves to, read in the module
   *  `within` was written in. */
  readonly definitionOf: (declaration: Record<string, any>, within: ResourceManifest) => Record<string, any> | undefined;
  /** A named shape, by its `$ref`, as `witness` holds it. */
  readonly shapeOf: (ref: string, witness: Witness) => Record<string, any> | undefined;
  /** The name of the declaration a named shape's `$ref` names, when one does. */
  readonly shapeNameOf: (ref: string) => string | undefined;
  /** Whether `declaration` is a named shape: its whole is the schema a read of
   *  it reads. */
  readonly isNamedShape: (declaration: ResourceManifest) => boolean;
  /** The module an import alias names, read in `within`'s module. */
  readonly moduleForAlias: (alias: string, within: ResourceManifest) => string | undefined;
  /** The `direction` contract the kind of `declaration` declares, resolved
   *  along `extends`, read in the module `within` was written in. */
  readonly kindContractOf: (
    declaration: Record<string, any>,
    within: ResourceManifest,
    direction: "inputType" | "outputType",
  ) => unknown;
  /** The scope a name written at expanded `keys` of `declaration`, projected
   *  as `projected`, reads in — a `with:` region's, or the module's
   *  (undefined). */
  readonly scopeAt: (
    declaration: ConditionedDeclaration,
    projected: Record<string, unknown>,
    keys: readonly (string | number)[],
  ) => ScopeSite | undefined;
  /** Whether a declaration of `kind`, read in the module `within` was written
   *  in, may report observed state — a kind with a `status:` or a need type,
   *  or one whose template body may stand one up. */
  readonly mayReportObservedState: (kind: string, within: ResourceManifest) => boolean;
  /** Whether a forward view's place, at union keys, holds a value its upstream
   *  evaluated before forwarding it — so the view holds no expression there. */
  readonly evaluatedBeforeForward: (view: ConditionedView, unionKeys: Keys) => boolean;
  /** Whether any of `declarations`, projected at `witness` and normalized as
   *  an analysis normalizes them, reports observed state. */
  readonly reportsObservedState: (declarations: readonly ConditionedDeclaration[], witness: Witness) => boolean;
  /** Every template-body site of `variant`. */
  readonly bodyCensus: (variant: number) => ReadonlyMap<string, CensusEntry>;
  /** Judge one key in its own environment. */
  readonly judgeKey: (request: KeyRequest) => CelSiteVerdict;
  /** The schemas a declaration's own checks are cut into sites by. */
  readonly ownSchemas: OwnSiteSchemas;
  /** Judge one key of a declaration's own-check site in its own environment. */
  readonly judgeOwnKey: (request: OwnKeyRequest) => OwnVerdict;
  /** The relational groups judged per instance, at relation sites. */
  readonly relationGroups: readonly string[];
  /** The anchors of `group`'s instances at or beneath the region of
   *  `declaration` rooted at `unionKeys`, normalized at the witness: each by
   *  its projected keys in the declaration. */
  readonly relationAnchors: (
    group: string,
    declaration: ConditionedDeclaration,
    unionKeys: Keys,
    witness: Witness,
    variant: number,
  ) => readonly Keys[];
  /** What the instance of `group` anchored at `unionKeys` reads, read off its
   *  anchor region normalized at the witness with the places at `carved` (union
   *  keys) carved out — an internal error where the reader no longer reports
   *  the instance there. */
  readonly relationReads: (
    group: string,
    declaration: ConditionedDeclaration,
    unionKeys: Keys,
    witness: Witness,
    variant: number,
    carved: readonly Keys[],
  ) => RelationReads;
  /** Judge one key of a relation site in its own environment. */
  readonly judgeRelationKey: (request: RelationKeyRequest) => CelSiteVerdict["diagnostics"];
}

/** A relation instance as a configuration run names it once its findings are
 *  placed: the group, the declaration it is reported at and its anchor there
 *  — and, for an instance of a forward view, which view of that consumer. */
export interface RelationMarker {
  readonly group: string;
  readonly kind: unknown;
  readonly name: unknown;
  readonly source: unknown;
  readonly path: string;
  readonly forwardedFrom?: string;
}

/** What a relation instance finds. A view's instances are found together, at
 *  the first one a run marks: `claim` names that set, and the findings are the
 *  set's. */
export interface RelationFound {
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly claim?: string;
}

/** The choices a relation site's anchor lies behind: its declaration's, and
 *  every option on the way — a view's nodes hold the choices of their own
 *  holding alone. */
export function relationSitePath(site: Pick<RelationSite, "declaration" | "options">): readonly ChoiceStep[] {
  return [...site.declaration.path, ...site.options.flatMap((option) => option.path)];
}

/** A relation site: one instance of a relational group, by its anchor. */
export interface RelationSite {
  readonly id: string;
  readonly group: string;
  readonly declaration: ConditionedDeclaration;
  /** The union path of its anchor, a choice node transparent. */
  readonly unionKeys: Keys;
  /** Where its anchor is written in the holder document. */
  readonly written: Keys;
  /** The options taken on the way to its anchor. */
  readonly options: readonly AlternativeOption[];
  /** Where its anchor exists: the declaration's condition and those options'. */
  readonly condition: Condition;
}

/** One key of a relation site to judge. */
export interface RelationKeyRequest {
  readonly site: RelationSite;
  readonly key: string;
  readonly witness: Witness;
  readonly variant: number;
  readonly coverage: KeyCoverage;
  /** What the instance reads, as read at the witness. */
  readonly reads: RelationReads;
  /** The union paths of what its door holds beside its anchor and declared
   *  read places: the step objects and input contract its step reads type their
   *  results from, and the scopes its names resolve in. */
  readonly roots: readonly Keys[];
  /** The union paths carved out of its anchor, read places and step objects:
   *  the census anchors of its own group nested beneath them, each holding the
   *  carved stand-in. */
  readonly carved: readonly Keys[];
  /** What the CEL site `site` was typed as, occurrence by occurrence, by its
   *  key holding at the witness. */
  readonly celFactsAt: (site: string) => readonly CelOccurrenceFacts[] | undefined;
  /** As {@link KeyRequest.byNameWhole}. */
  readonly byNameWhole?: boolean;
}

/** The region of its declaration a CEL key reads at a witness, by union keys:
 *  the site first, then the places beyond it the key reads; and the
 *  expressions of read steps another site's key types, carved. */
export interface CelRegion {
  readonly roots: readonly Keys[];
  /** Each carved step value, and its producer's fact: what its stand-in
   *  carries (`carvedResult`). */
  readonly carved: readonly { readonly keys: Keys; readonly fact: StepFact }[];
  /** Where the key takes the step-names class: every name the `steps` record
   *  lists at the witness, in order — the names it covers beyond the steps the
   *  region holds, each read as `{ result: dyn }`. */
  readonly stepNames?: readonly string[];
}

/** One key of a site, judged once. */
export interface SolvedKey {
  readonly text: string;
  condition: Condition;
  readonly variant: number;
  readonly verdict: CelSiteVerdict;
  /** For a key inside a branch no configuration takes: that branch. */
  readonly dead?: DeadBranch;
  /** For a key read only where a branch no configuration takes reads a site
   *  outside its reach: judged there for the whole space, its facts alone
   *  read, shared by text with the site's other whole-care keys alone. */
  readonly wholeCare?: true;
}

/** A branch no configuration takes, and the configuration reaching its choice. */
export interface DeadBranch {
  readonly sentinel: object;
  readonly branch: string;
  readonly baseline: Assignment;
}

/** Every site's keys. */
export interface CelSiteSolution {
  /** The verdict of `site` in `assignment` and `variant`. */
  verdictAt(site: string, assignment: Assignment, variant: number): CelSiteVerdict | undefined;
  /** The verdict of `site` inside the branch `branch` of the choice `sentinel`,
   *  which no configuration takes, at the witness its run reads — undefined
   *  for a site outside the branch's reach. */
  verdictInDeadBranch(site: string, sentinel: object, branch: string): CelSiteVerdict | undefined;
  /** The flag the observed-state class holds at `witness`: whether any
   *  declaration or view reports observed state there. */
  observedAt(witness: Witness): boolean;
  /** Every key of every site. */
  readonly keys: ReadonlyMap<string, readonly SolvedKey[]>;
  /** Whether `site` is a template body's, judged per variant. */
  isBodySite(site: string): boolean;
  /** What the own checks of the declaration written at `origin` find in
   *  `assignment` and `variant`, site by site. */
  ownFindingsAt(origin: string, assignment: Assignment, variant: number): readonly AnalysisDiagnostic[];
  /** The same inside the branch `branch` of the choice `sentinel`, which no
   *  configuration takes, at the witness its run reads: the sites in the
   *  branch's reach alone. */
  ownFindingsInDeadBranch(origin: string, sentinel: object, branch: string): readonly AnalysisDiagnostic[];
  /** Every own-check site and its keys, relation sites included. */
  readonly ownKeys: ReadonlyMap<string, readonly OwnSolvedKey[]>;
  /** Every relation site the census found, by id. */
  readonly relationSites: ReadonlyMap<string, RelationSite>;
  /** Where a relation site holding at `witness` finds otherwise judged on the
   *  regions its key reads carved than on the same regions whole — one line per
   *  site — and what each site's key carves there. */
  carveParityAt(witness: Witness, variant: number): { readonly mismatches: string[]; readonly carved: ReadonlyMap<string, readonly Keys[]> };
  /** Where a CEL site or an own-check site holding at `witness` finds otherwise
   *  judged in its key's environment — its regions, its module's globals base
   *  and the entries its classes narrow — than on its declarations normalized
   *  whole with the module documents whole: one line per site, and how many
   *  sites of each family were compared. */
  keyParityAt(
    witness: Witness,
    variant: number,
  ): {
    readonly mismatches: string[];
    /** Where a key judged with the declarations it reaches by name held whole
     *  finds otherwise than judged with the parts its key holds of them. */
    readonly byName: string[];
    readonly compared: { readonly cel: number; readonly own: number; readonly views: number };
  };
  /** What the relation instance a run's marker stands for finds in
   *  `assignment` and `variant` — an internal error for an instance the census
   *  does not hold. A view's instance is found by where its anchor stands in
   *  the union. */
  relationFindingsAt(marker: RelationMarker, assignment: Assignment, variant: number): RelationFound;
  /** The same inside the branch `branch` of the choice `sentinel`, which no
   *  configuration takes, at the witness its run reads — nothing for a site
   *  outside the branch's reach. */
  relationFindingsInDeadBranch(marker: RelationMarker, sentinel: object, branch: string): RelationFound;
}

/** One key of an own-check site, judged once. */
export interface OwnSolvedKey {
  readonly text: string;
  condition: Condition;
  readonly variant: number;
  verdict: OwnVerdict;
  readonly dead?: DeadBranch;
}

/** One expression of the union, as written. */
interface UnionSite {
  readonly id: string;
  readonly declaration: ConditionedDeclaration;
  /** The path to it through the union (an {@link Alternatives} node transparent). */
  readonly unionKeys: Keys;
  /** The options taken on the way, and their conjunction with the
   *  declaration's condition. */
  readonly options: readonly AlternativeOption[];
  readonly condition: Condition;
  readonly engine: string;
  readonly source: string;
  /** Set for a site inside a branch no configuration takes. */
  readonly dead?: { readonly branch: DeadBranch };
}

/** The verdicts of the keys holding at one written place as one, in the
 *  order a run meets their expressions — each occurrence by its own position
 *  in the door's layout, the consumer's own site's first: each finding once,
 *  each key's in the order its first occurrence is met, and every occurrence's
 *  facts in turn. */
function mergedVerdict(verdicts: readonly CelSiteVerdict[]): CelSiteVerdict {
  if (verdicts.length === 1) return verdicts[0]!;
  const met = (verdict: CelSiteVerdict): readonly number[] => verdict.facts[0]?.layout ?? [];
  const seen = new Set<string>();
  const diagnostics: AnalysisDiagnostic[] = [];
  for (const verdict of [...verdicts].sort((a, b) => layoutOrder(met(a), met(b)))) {
    for (const d of verdict.diagnostics) {
      const text = textOf([d.code, d.data, d.message]);
      if (seen.has(text)) continue;
      seen.add(text);
      diagnostics.push(d);
    }
  }
  const facts = verdicts.flatMap((verdict) => verdict.facts).sort((a, b) => layoutOrder(a.layout, b.layout));
  return { diagnostics, facts };
}

/** Positions in a door's layout, compared: a shorter prefix first. */
function layoutOrder(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** The identity of a site: the written place a finding about it is reported
 *  at. */
export function celSiteId(kind: unknown, name: unknown, filePath: unknown, path: string): string {
  return JSON.stringify([kind, name, filePath, path]);
}

/** Whether `site` is a template body's expression. */
export function isBodySiteId(site: string): boolean {
  const [kind, , , path] = JSON.parse(site) as [unknown, unknown, unknown, string];
  return kind === "Telo.Definition" && TEMPLATE_BODY_FIELDS.includes(path.split(/[.[]/)[0]!);
}

const readsIds = new WeakMap<object, number>();
let nextReadsId = 0;

/** A reader's identity, as a number. */
function readsIdOf(reads: object): number {
  let id = readsIds.get(reads);
  if (id === undefined) readsIds.set(reads, (id = nextReadsId++));
  return id;
}

/** A place's text: where it is, and — past a reference — which reader reads
 *  on, so two readers of one place are kept apart. */
function placeText(place: ReadPlace): string {
  if (place.kind !== "reference" && place.kind !== "referrers") return textOf(place);
  return textOf([place, readsIdOf(place.reads)]);
}

/** A value's text, every value a manifest may hold. */
function textOf(value: unknown): string {
  return JSON.stringify(value, (key, field: unknown) => {
    if (typeof field === "bigint") return { $bigint: field.toString() };
    if (isAlternatives(field)) return { $alternatives: field.options.length };
    return field;
  });
}

/** Every expression of the union outside a template body — a dead branch's
 *  included, each such site carrying the branch and the choices forced to
 *  reach it — and of its forward views: a view's expression, at a place a
 *  forward moves to where its consumer wrote it, is a site whose id is that
 *  place, unless its upstream evaluated it before forwarding it. One written
 *  place may be several sites: the expression's own declaration, where no view
 *  built from it holds it, and each view holding it, where that view holds. */
function unionSites(
  union: ConditionedExpansion,
  dead: readonly DeadBranch[],
  evaluatedBefore: (view: ConditionedView, unionKeys: Keys) => boolean,
): UnionSite[] {
  const { space } = union;
  const out: UnionSite[] = [];
  const deadOf = (step: ChoiceStep): DeadBranch | undefined =>
    dead.find((entry) => entry.sentinel === step.sentinel && entry.branch === step.branch);
  /** The dead branch a path takes, read where its run reads it — its baseline,
   *  the branch forced; undefined for a path some configuration takes, or one
   *  that run does not take. */
  const deadPath = (path: readonly ChoiceStep[]): UnionSite["dead"] => {
    const branch = path.map(deadOf).find((entry) => entry !== undefined);
    if (!branch) return undefined;
    const forcing = new Map([[branch.sentinel, branch.branch]]) as unknown as Forcing;
    return takenAt(space, FALSE, path, branch.baseline, forcing) ? { branch } : undefined;
  };
  const views = new Set<ConditionedDeclaration>(union.views);
  const walk = (declaration: ConditionedDeclaration, view: ConditionedView | undefined): void => {
    const holder = declaration.holder;
    const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
    const kind = holder.kind ?? expansionTagLabel(holder);
    const definition = declaration.manifest.kind === "Telo.Definition";
    /** `written` is where the place is written in the holder — undefined for a
     *  view's own place, which no forward moves; `exact`, that every place
     *  beneath is reported there. */
    const visit = (
      value: unknown,
      unionKeys: Keys,
      written: Keys | undefined,
      exact: boolean,
      options: readonly AlternativeOption[],
      condition: Condition,
    ): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          if (!option.present) continue;
          const at = exact ? written : option.moved || !view ? option.at : written;
          visit(option.value, unionKeys, at, exact || !!option.exact, [...options, option], space.and(condition, option.condition));
        }
        return;
      }
      if (isTaggedSentinel(value)) {
        if (isRefSentinel(value) || written === undefined) return;
        if (view && evaluatedBefore(view, unionKeys)) return;
        // Every option on the way: one a view reads across a reference carries
        // only the steps of the declaration it names.
        const path = [...declaration.path, ...options.flatMap((option) => option.path)];
        let deadAt = condition === FALSE ? deadPath(path) : undefined;
        // A view is in a dead branch's run only where it holds at the branch's
        // baseline, that branch forced.
        if (
          deadAt &&
          view &&
          !takenAt(space, view.condition, view.path, deadAt.branch.baseline, new Map([[deadAt.branch.sentinel, deadAt.branch.branch]]) as unknown as Forcing)
        ) {
          deadAt = undefined;
        }
        // A dead branch no reading names, or one its run does not take there,
        // has nowhere to be judged.
        if (condition === FALSE && !deadAt) return;
        out.push({
          id: celSiteId(kind, meta?.name, meta?.source, pathText(written)),
          declaration,
          unionKeys,
          options,
          condition,
          engine: value.engine,
          source: value.source,
          ...(deadAt ? { dead: deadAt } : {}),
        });
        return;
      }
      // A construct left as written (refused, or not decided) is walked as the
      // mapping it is.
      if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return;
      const at = (key: string | number): Keys | undefined => (written === undefined || exact ? written : [...written, key]);
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...unionKeys, i], at(i), exact, options, condition));
        return;
      }
      for (const [key, field] of Object.entries(value)) {
        // A template body's expressions are judged in each of its variants.
        if (definition && unionKeys.length === 0 && TEMPLATE_BODY_FIELDS.includes(key)) continue;
        visit(field, [...unionKeys, key], at(key), exact, options, condition);
      }
    };
    visit(declaration.manifest, [], view ? undefined : declaration.at, false, [], declaration.condition);
  };
  for (const declaration of union.declarations) walk(declaration, undefined);
  for (const view of union.views) walk(view, view);
  // A place a view built from a declaration holds is the view's where it holds
  // it: the declaration's site there holds only elsewhere, and is no site where
  // that leaves nothing.
  const upstreamOf = (declaration: ConditionedDeclaration): ConditionedDeclaration[] => {
    const chain: ConditionedDeclaration[] = [];
    for (let at = declaration; views.has(at); ) {
      at = (at as ConditionedView).upstream;
      chain.push(at);
    }
    // A consumer written inside a declaration forwards that declaration's own
    // values.
    const within = chain.at(-1)?.declaredIn;
    if (within) chain.push(within);
    return chain;
  };
  const byId = new Map<string, UnionSite[]>();
  for (const site of out) byId.set(site.id, [...(byId.get(site.id) ?? []), site]);
  const kept: UnionSite[] = [];
  for (const site of out) {
    const downstream = (byId.get(site.id) ?? []).filter(
      (other) => other !== site && upstreamOf(other.declaration).includes(site.declaration),
    );
    if (downstream.length === 0) {
      kept.push(site);
      continue;
    }
    if (site.dead) {
      if (!downstream.some((other) => other.dead?.branch === site.dead!.branch)) kept.push(site);
      continue;
    }
    const condition = space.and(site.condition, space.not(space.some(downstream.filter((o) => !o.dead).map((o) => o.condition))));
    if (condition !== FALSE) kept.push({ ...site, condition });
  }
  return kept;
}

/** The expressions of a CEL-bearing tag, each parsed. */
function parsedExpressions(engine: string, source: string, moduleNames: ReadonlySet<string>): CelNode[] {
  const out: CelNode[] = [];
  for (const expression of celExpressionsOf(engine, source)) {
    const parsed = parseCelSource(expression, moduleNames);
    if (parsed) out.push(parsed.root);
  }
  return out;
}

function moduleCallNames(node: CelNode, into: Set<string>): void {
  const call = moduleCallOf(node);
  if (call) into.add(call.qualified);
  for (const child of childNodes(node)) moduleCallNames(child, into);
}

/** What a site reads, as its expression's tree says. */
interface TreeReads {
  readonly chains: readonly string[][];
  readonly calls: ReadonlySet<string>;
}

function treeReads(engine: string, source: string, moduleNames: ReadonlySet<string>): TreeReads {
  const chains: string[][] = [];
  const calls = new Set<string>();
  for (const root of parsedExpressions(engine, source, moduleNames)) {
    chains.push(...extractAccessChains(root));
    moduleCallNames(root, calls);
  }
  return { chains, calls };
}

export function solveCelSites(input: CelSiteSolveInput): CelSiteSolution {
  const { union, universe, choices } = input;
  const { space } = union;
  const deadBranches: DeadBranch[] = choices.unreachable.map((entry) => ({
    sentinel: entry.site.sentinel as object,
    branch: entry.branch,
    baseline: entry.baseline,
  }));
  const sites = unionSites(union, deadBranches, input.evaluatedBeforeForward);
  const viewSites = new Set<ConditionedDeclaration>(union.views);
  const declarations = liveDeclarations(union);
  const nameIndex = input.names;

  // --- Projection at one witness -------------------------------------------
  const taken = (condition: Condition, path: readonly ChoiceStep[], wit: Witness): boolean =>
    takenAt(space, condition, path, wit.assignment, wit.forcing);
  const optionAt = (value: unknown, wit: Witness): AlternativeOption | undefined =>
    isAlternatives(value) ? value.options.find((option) => taken(option.condition, option.path, wit)) : undefined;
  const declared = (declaration: ConditionedDeclaration, wit: Witness): boolean =>
    taken(declaration.condition, declaration.path, wit);
  const project = (value: unknown, wit: Witness) => union.project(value, wit.assignment, wit.forcing);

  /** The union node at expanded `keys` from `root`, and the condition of every
   *  option deciding what is there (an earlier list item's presence included). */
  const navigate = (root: unknown, keys: Keys, wit: Witness): { node: unknown; present: boolean; taken: Condition } => {
    let node = root;
    let held = TRUE;
    const settle = (): boolean => {
      while (isAlternatives(node)) {
        const option = optionAt(node, wit);
        if (!option) return false;
        held = space.and(held, option.condition);
        if (!option.present) return false;
        node = option.value;
      }
      return true;
    };
    for (const key of keys) {
      if (!settle()) return { node: undefined, present: false, taken: held };
      if (Array.isArray(node) && typeof key === "number") {
        let count = -1;
        let found: unknown;
        for (const item of node) {
          let present = true;
          let probe = item;
          while (isAlternatives(probe)) {
            const option = optionAt(probe, wit);
            if (!option) {
              present = false;
              break;
            }
            held = space.and(held, option.condition);
            present = option.present;
            if (!present) break;
            probe = option.value;
          }
          if (!present) continue;
          if (++count === key) {
            found = item;
            break;
          }
        }
        if (found === undefined) return { node: undefined, present: false, taken: held };
        node = found;
        continue;
      }
      if (node === null || typeof node !== "object" || Array.isArray(node)) return { node: undefined, present: false, taken: held };
      node = (node as Record<string, unknown>)[key as string];
      if (node === undefined) return { node: undefined, present: false, taken: held };
    }
    return { node, present: true, taken: held };
  };

  /** The union node at union `keys` from `root` — a list item by where it is
   *  written, whatever is present before it — and the condition of every
   *  option on the way. */
  const navigateUnion = (root: unknown, keys: Keys, wit: Witness): { node: unknown; present: boolean; taken: Condition } => {
    let node = root;
    let held = TRUE;
    for (const key of keys) {
      while (isAlternatives(node)) {
        const option = optionAt(node, wit);
        if (!option) return { node: undefined, present: false, taken: held };
        held = space.and(held, option.condition);
        if (!option.present) return { node: undefined, present: false, taken: held };
        node = option.value;
      }
      if (node === null || typeof node !== "object") return { node: undefined, present: false, taken: held };
      node = (node as Record<string | number, unknown>)[key as string];
      if (node === undefined) return { node: undefined, present: false, taken: held };
    }
    return { node, present: true, taken: held };
  };

  /**
   * A place of `declaration` read at projected `keys`, keyed by its UNION
   * position — never by the index a configuration projects it at, which the
   * presence of earlier list items decides: its union keys and the options on
   * the way to it. A place absent at the witness is keyed by the union keys
   * reached and the projected keys left; its condition then also holds the
   * earlier items deciding where the walk stopped.
   */
  const placeAt = (
    declaration: ConditionedDeclaration,
    keys: Keys,
    wit: Witness,
  ): { present: boolean; node: unknown; keys: unknown; taken: Condition } => {
    const at = placeByProjectedKeys(union, declaration, keys, wit);
    if (at.present) return { present: true, node: at.node, keys: at.unionKeys, taken: at.path };
    return {
      present: false,
      node: undefined,
      keys: ["absent", at.unionKeys, keys.slice(at.at.length)],
      taken: space.and(at.path, at.position),
    };
  };

  /** What a class covers, merged into a key's {@link KeyCoverage}. */
  interface Cover {
    readonly names?: Iterable<string>;
    /** Why each of {@link names} is held whole. */
    readonly readers?: ReadonlyMap<string, WholeNameReader>;
    readonly named?: Iterable<string>;
    readonly outcomes?: Iterable<string>;
    readonly parts?: Iterable<{ readonly declaration: ConditionedDeclaration; readonly roots: readonly Keys[] }>;
    readonly referrers?: Iterable<string>;
    readonly presence?: true;
    readonly observed?: boolean;
  }

  /** One class: its text, the configurations holding it, and what it covers. */
  interface ReadClass {
    readonly text: string;
    readonly condition: Condition;
    readonly covers?: Cover;
  }

  /** The names a value's references and module calls reach. */
  const namesIn = (
    value: unknown,
    into: Set<string>,
    calls: boolean,
    moduleNames: ReadonlySet<string> = new Set(),
  ): void => {
    if (isRefSentinel(value)) {
      const parsed = (value as { parsed?: { name?: unknown } }).parsed;
      const name = typeof parsed?.name === "string" ? parsed.name : value.source.split(".").pop()!;
      into.add(name);
      into.add(value.source);
      return;
    }
    if (isTaggedSentinel(value)) {
      if (!calls) return;
      const found = new Set<string>();
      for (const root of parsedExpressions(value.engine, value.source, moduleNames)) moduleCallNames(root, found);
      for (const qualified of found) into.add(qualified.slice(qualified.indexOf(".") + 1));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) namesIn(item, into, calls, moduleNames);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      // A `$ref` to a named shape names its declaration.
      if (key === "$ref" && typeof field === "string") {
        const shape = input.shapeNameOf(field);
        if (shape !== undefined) into.add(shape);
        continue;
      }
      namesIn(field, into, calls, moduleNames);
    }
  };

  /** Whether every declaration of `name` is a named shape: what alone makes a
   *  whole hold of it the schema read. */
  const allNamedShapes = (name: string): boolean => {
    const found = nameIndex.declarationsNamed(name);
    return found.length > 0 && found.every((declaration) => input.isNamedShape(declaration.manifest));
  };

  /** Every declaration named `name`: present or absent, and its content —
   *  held whole, labelled `shape` where every declaration of the name is a
   *  named shape and for `reader` otherwise. */
  const declarationClass = (names: Iterable<string>, wit: Witness, transitive: boolean, reader: WholeNameReader): ReadClass => {
    const parts: unknown[] = [];
    let condition = TRUE;
    const seen = new Set<string>();
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const declaration of nameIndex.declarationsNamed(name)) {
        if (!declared(declaration, wit)) {
          condition = space.and(condition, space.not(declaration.condition));
          parts.push([name, null]);
          continue;
        }
        const projected = project(declaration.manifest, wit);
        condition = space.and(condition, space.and(declaration.condition, projected.taken));
        parts.push([name, projected.value]);
        if (transitive) {
          const reached = new Set<string>();
          namesIn(projected.value, reached, true, input.moduleNamesOf(declaration.manifest));
          queue.push(...reached);
        }
      }
    }
    const readers = new Map([...seen].map((name): [string, WholeNameReader] => [name, allNamedShapes(name) ? "shape" : reader]));
    return { text: textOf(parts), condition, covers: { names: seen, readers } };
  };

  /** The named shapes `names` name, each held whole as the schema it is —
   *  and, onward, the shapes their content names; a name some declaration of
   *  which is no named shape is held as its identity alone. */
  const shapeClasses = (names: Iterable<string>, wit: Witness): ReadClass[] => {
    const whole = new Set<string>();
    const others = new Set<string>();
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (whole.has(name) || others.has(name)) continue;
      if (!allNamedShapes(name)) {
        others.add(name);
        continue;
      }
      whole.add(name);
      for (const declaration of nameIndex.declarationsNamed(name)) {
        if (!declared(declaration, wit)) continue;
        const reached = new Set<string>();
        namesIn(project(declaration.manifest, wit).value, reached, true, input.moduleNamesOf(declaration.manifest));
        queue.push(...reached);
      }
    }
    const classes = whole.size > 0 ? [declarationClass(whole, wit, false, "schema")] : [];
    if (others.size > 0) classes.push(...nameReadClasses(others, wit, () => [], false).classes);
    return classes;
  };

  /** Which declarations there are: what a read of a name none answers to is
   *  refused with — each present one held as its identity alone. */
  const presenceClass = (wit: Witness): ReadClass => {
    const parts: unknown[] = [];
    const held: { declaration: ConditionedDeclaration; roots: Keys[] }[] = [];
    let condition = TRUE;
    for (const declaration of declarations) {
      const present = declared(declaration, wit);
      condition = space.and(condition, present ? declaration.condition : space.not(declaration.condition));
      if (!present) {
        parts.push([declaration.manifest.metadata?.name, false]);
        continue;
      }
      const identity = identityAt(declaration, wit);
      condition = space.and(condition, identity.taken);
      parts.push([declaration.manifest.metadata?.name, identity.value]);
      held.push({ declaration, roots: [] });
    }
    return { text: textOf(parts), condition, covers: { presence: true, parts: held } };
  };

  /** A present declaration's identity — its `kind` and `metadata` — at the
   *  witness. */
  const identityAt = (declaration: ConditionedDeclaration, wit: Witness): { value: unknown; taken: Condition } => {
    const projected = project({ kind: declaration.manifest.kind, metadata: declaration.manifest.metadata }, wit);
    return { value: projected.value, taken: projected.taken };
  };

  /** Every reference `value` holds, as written. */
  const refsIn = (value: unknown, into: unknown[] = []): unknown[] => {
    if (isRefSentinel(value)) into.push(value);
    else if (value !== null && typeof value === "object" && !isTaggedSentinel(value)) {
      for (const field of Array.isArray(value) ? value : Object.values(value)) refsIn(field, into);
    }
    return into;
  };

  /**
   * What the reference `ref`, written in the kind document `holder`, names by
   * the one template-body lookup — siblings first, then the defining module,
   * then an alias through its imports — at the witness; a sibling entry with
   * its projected keys. Undefined where `holder` declares no body or `ref` is
   * no reference by name.
   */
  const bodyTargetOf = (
    holder: ConditionedDeclaration,
    ref: unknown,
    wit: Witness,
  ): { readonly target: TemplateBodyTarget; readonly name: string; readonly keys?: Keys; readonly found: ReadClass } | undefined => {
    if (!isRefSentinel(ref) || !isKindDocument(holder.manifest)) return undefined;
    const parsed = (ref as { parsed?: { name?: unknown; alias?: unknown } }).parsed;
    if (typeof parsed?.name !== "string") return undefined;
    // Which entries there are, and what each is named, at the witness.
    let condition = TRUE;
    const settle = (value: unknown): unknown => {
      while (isAlternatives(value)) {
        const option = optionAt(value, wit);
        condition = space.and(condition, option?.condition ?? FALSE);
        value = option?.present ? option.value : undefined;
      }
      return value;
    };
    const entries = settle((holder.manifest as Record<string, unknown>).resources);
    if (!Array.isArray(entries)) return undefined;
    const siblings = new Map<string, number>();
    let dynamicSiblings = false;
    let index = 0;
    for (const item of entries) {
      const entry = settle(item);
      if (entry === undefined) continue;
      const metadata = settle((entry as { metadata?: unknown } | null)?.metadata) as { name?: unknown } | undefined;
      const name = settle(metadata?.name);
      if (typeof name === "string") siblings.set(name, index);
      else if (isTaggedSentinel(name)) dynamicSiblings = true;
      index++;
    }
    const target = templateBodyReference(
      { name: parsed.name, ...(typeof parsed.alias === "string" ? { alias: parsed.alias } : {}) },
      { siblings: new Set(siblings.keys()), dynamicSiblings, moduleDeclares: (name) => nameIndex.declarationsNamed(name).length > 0 },
    );
    const keys: Keys | undefined =
      target.kind === "sibling" ? ["resources", siblings.get(target.name)!] : target.kind === "undecided" ? ["resources"] : undefined;
    const found: ReadClass = { text: textOf(["body", ref.source, target.kind, keys ?? null]), condition };
    return { target, name: parsed.name, ...(keys ? { keys } : {}), found };
  };

  /**
   * A read by name — a CEL `resources.<name>` read, a module call: every
   * declaration of each name, present or absent, a present one held as its
   * identity and the places `placesOf` names in it, never whole; the named
   * shapes those places reach whole; and, `onward`, the module calls its places
   * make read the same way in turn. Where a name is `own`'s, the site's own
   * declaration, its places are returned as reads of the site's region (by
   * projected keys) instead.
   */
  const nameReadClasses = (
    names: Iterable<string>,
    wit: Witness,
    placesOf: (declaration: ConditionedDeclaration, wit: Witness) => readonly Keys[],
    onward: boolean,
    own?: ConditionedDeclaration,
  ): { classes: ReadClass[]; reads: Keys[] } => {
    const texts: unknown[] = [];
    const classes: ReadClass[] = [];
    const reads: Keys[] = [];
    const named = new Set<string>();
    const shapes = new Set<string>();
    let condition = TRUE;
    const queue = [...names];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (named.has(name)) continue;
      named.add(name);
      for (const declaration of nameIndex.declarationsNamed(name)) {
        if (!declared(declaration, wit)) {
          condition = space.and(condition, space.not(declaration.condition));
          texts.push([name, null]);
          continue;
        }
        const identity = identityAt(declaration, wit);
        condition = space.and(condition, space.and(declaration.condition, identity.taken));
        texts.push([name, identity.value]);
        const places = placesOf(declaration, wit);
        if (declaration === own) reads.push(...places);
        else classes.push(...regionClasses(declaration, places, wit));
        const moduleNames = input.moduleNamesOf(declaration.manifest);
        for (const keys of places) {
          const at = placeAt(declaration, keys, wit);
          if (!at.present) continue;
          const value = project(at.node, wit).value;
          if (declaration === own) namesIn(value, shapes, false);
          if (!onward) continue;
          const reached = new Set<string>();
          const referenced = new Set<string>();
          namesIn(value, reached, true, moduleNames);
          namesIn(value, referenced, false);
          for (const callee of reached) if (!referenced.has(callee)) queue.push(callee);
        }
      }
    }
    classes.unshift({ text: textOf(["named", texts]), condition, covers: { named } });
    classes.push(...shapeClasses(shapes, wit));
    return { classes, reads };
  };

  /** The places a module call reads in a callable it names: its signature and
   *  its body, where its kind lets an instance declare them. */
  const callablePlaces = (declaration: ConditionedDeclaration, wit: Witness): Keys[] =>
    callableInstanceFields(input.schemaOf(project(declaration.manifest, wit).value as Record<string, any>, declaration.manifest)).map(
      (field) => [field],
    );

  /** The declarations and views whose content may report observed state: a
   *  kind, at any depth and in any option, that may, and an optional resource
   *  input, which reads nullable whatever its kind. */
  const mayReport: ConditionedDeclaration[] = [];
  for (const declaration of [...union.declarations, ...union.views]) {
    const visit = (value: unknown): boolean => {
      if (isAlternatives(value)) return value.options.some((option) => option.present && visit(option.value));
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return false;
      if (Array.isArray(value)) return value.some(visit);
      const kind = (value as { kind?: unknown }).kind;
      if (typeof kind === "string" && input.mayReportObservedState(kind, declaration.manifest)) return true;
      return Object.values(value).some(visit);
    };
    if (isOptionalResourceInput(declaration.manifest) || visit(declaration.manifest)) mayReport.push(declaration);
  }

  /** Whether any declaration reports observed state, decided by every
   *  declaration and view that may report, held as it is at the witness — present with
   *  the same content, or absent — where it cannot differ. */
  const observedFlags = new Map<string, boolean>();
  const observedClass = (wit: Witness): ReadClass => {
    let condition = TRUE;
    const present: ConditionedDeclaration[] = [];
    const contents: unknown[] = [];
    for (const declaration of mayReport) {
      if (!declared(declaration, wit)) {
        condition = space.and(condition, space.not(declaration.condition));
        contents.push(null);
        continue;
      }
      const projected = project(declaration.manifest, wit);
      condition = space.and(condition, space.and(declaration.condition, projected.taken));
      present.push(declaration);
      contents.push(projected.value);
    }
    const memo = textOf(contents);
    let flag = observedFlags.get(memo);
    if (flag === undefined) observedFlags.set(memo, (flag = input.reportsObservedState(present, wit)));
    return { text: textOf(["observed", flag]), condition, covers: { observed: flag } };
  };

  /** The names of the declarations referencing `declaration`, in any option. */
  const referrerNamesOf = new Map<ConditionedDeclaration, string[]>();
  const referrerNames = (declaration: ConditionedDeclaration): string[] => {
    let found = referrerNamesOf.get(declaration);
    if (found) return found;
    found = [];
    const name = declaration.manifest.metadata?.name;
    for (const other of declarations) {
      if (other === declaration || typeof name !== "string") continue;
      const reached = new Set<string>();
      namesIn(other.manifest, reached, false);
      const otherName = other.manifest.metadata?.name;
      if (typeof otherName === "string" && reached.has(name)) found.push(otherName);
    }
    referrerNamesOf.set(declaration, found);
    return found;
  };

  /** A place of `declaration`: its projected value, and — for a reference read
   *  — what it reads in the declarations the references there name, or — for a
   *  referrers read — in the declarations referencing `declaration`: the places
   *  its reader names in each. A place of `own`, the key's own
   *  declaration, a read reaches is pushed onto `ownReads` (projected keys)
   *  instead. */
  const placeClasses = (
    declaration: ConditionedDeclaration,
    place: ReadPlace,
    wit: Witness,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    if (place.kind === "tagged") return taggedClasses(declaration, place.keys, wit, ownReads);
    if (place.kind === "referrers") {
      const name = declaration.manifest.metadata?.name;
      const covers = typeof name === "string" ? { referrers: [name] } : {};
      const [first, ...rest] = namedReadClasses([{ referred: declaration, reads: place.reads }], wit, ownReads);
      return [{ ...first!, covers: { ...first!.covers, ...covers } }, ...rest];
    }
    const at = placeAt(declaration, place.keys, wit);
    if (!at.present) return [{ text: textOf([at.keys, null]), condition: at.taken }];
    const projected = project(at.node, wit);
    const own: ReadClass = { text: textOf([at.keys, projected.value]), condition: space.and(at.taken, projected.taken) };
    if (place.kind === "value") return [own];
    const hop = { value: projected.value, reads: place.reads, transitive: place.transitive, holder: declaration, at: place.keys };
    return [own, ...namedReadClasses([hop], wit, ownReads)];
  };

  /** Which members of the object at projected `keys` of `declaration` hold a
   *  tagged value, and each such value: one class over what every member is —
   *  a tagged value itself, else a scalar, a reference, an object or a list
   *  alike — holding wherever each member is what it is at the witness, and
   *  the tagged members as places read; `ownReads` takes them for the key's
   *  own declaration. */
  const taggedClasses = (
    declaration: ConditionedDeclaration,
    keys: Keys,
    wit: Witness,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const at = placeAt(declaration, keys, wit);
    if (!at.present) return [{ text: textOf(["tagged", at.keys, null]), condition: at.taken }];
    /** What a member is, as this class tells members apart. */
    const what = (value: unknown): unknown =>
      value === undefined
        ? null
        : isTaggedSentinel(value) && !isRefSentinel(value)
          ? value
          : value !== null && typeof value === "object" && !isTaggedSentinel(value)
            ? "{}"
            : "-";
    /** Every value a union node may be, with the condition it is that. */
    const leaves = (value: unknown, held: Condition): { value: unknown; condition: Condition }[] =>
      isAlternatives(value)
        ? value.options.flatMap((option) =>
            leaves(option.present ? option.value : undefined, space.and(held, option.condition)),
          )
        : [{ value, condition: held }];
    /** What `value` is at the witness, and where it is that. */
    const alike = (value: unknown): { value: unknown; condition: Condition } => {
      let taken = value;
      while (isAlternatives(taken)) {
        const option = optionAt(taken, wit);
        taken = option?.present ? option.value : undefined;
      }
      if (!isAlternatives(value)) return { value: taken, condition: TRUE };
      const shown = textOf(what(taken));
      return {
        value: taken,
        condition: space.some(leaves(value, TRUE).filter((leaf) => textOf(what(leaf.value)) === shown).map((leaf) => leaf.condition)),
      };
    };
    const object = alike(at.node);
    let condition = space.and(at.taken, object.condition);
    const node = object.value;
    if (node === null || typeof node !== "object" || Array.isArray(node) || isTaggedSentinel(node)) {
      return [{ text: textOf(["tagged", at.keys, what(node)]), condition }];
    }
    const members: unknown[] = [];
    const tagged: Keys[] = [];
    for (const [member, field] of Object.entries(node as Record<string, unknown>)) {
      const found = alike(field);
      condition = space.and(condition, found.condition);
      members.push([member, what(found.value)]);
      if (isTaggedSentinel(found.value) && !isRefSentinel(found.value)) tagged.push([...keys, member]);
    }
    const shown: ReadClass = { text: textOf(["tagged", at.keys, members]), condition };
    if (ownReads?.own === declaration) {
      ownReads.reads.push(...tagged);
      return [shown];
    }
    return [shown, ...(tagged.length > 0 ? regionClasses(declaration, tagged, wit, true) : [])];
  };

  /** Where references naming `name` stand in `declaration`, in any option, by
   *  union keys. */
  const slotsNaming = new Map<ConditionedDeclaration, Map<string, Keys[]>>();
  const slotsOf = (declaration: ConditionedDeclaration, name: string): Keys[] => {
    let byName = slotsNaming.get(declaration);
    if (!byName) slotsNaming.set(declaration, (byName = new Map()));
    let found = byName.get(name);
    if (found) return found;
    found = [];
    const visit = (value: unknown, keys: Keys): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) if (option.present) visit(option.value, keys);
        return;
      }
      if (isRefSentinel(value)) {
        const named = new Set<string>();
        namesIn(value, named, false);
        if (named.has(name)) found!.push(keys);
        return;
      }
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
      if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...keys, i]));
      else for (const [key, field] of Object.entries(value)) visit(field, [...keys, key]);
    };
    visit(declaration.manifest, []);
    byName.set(name, found);
    return found;
  };

  /** A declaration as a reporter reads it, at the witness. */
  const referentAt = (target: ConditionedDeclaration, wit: Witness): Referent => {
    const value = project(target.manifest, wit).value as Record<string, any>;
    return {
      value,
      schema: input.schemaOf(value, target.manifest),
      shapeOf: (ref) => input.shapeOf(ref, wit),
      definition: input.definitionOf(value, target.manifest),
    };
  };

  /**
   * What a read reads beyond the place it stands at, from each of `start`'s
   * hops: a reference hop's `value`, the projected value at its place, names
   * declarations by its references; a referrers hop names every declaration
   * referencing `referred`; a resolved hop reads the one declaration a
   * reference resolved to, whose outcome its caller holds. Every declaration of
   * each name, present or absent,
   * a present one held as its identity and the places the hop's `reads` names
   * in it — a referrer also as each place holding a reference to `referred` —
   * a named shape whole, as the shape lookup holds it; a scope place read as
   * the annotations on the way to it read; and the places of each declaration
   * a reference at those places names in turn, as a reference place there
   * reads, or, `transitive`, by the same `reads`; and, `transitive`, the module
   * calls written there, read as a module call reads its callee. Never a
   * declaration whole but a named shape or a reader's whole place. A place of
   * the key's own declaration goes to `ownReads` instead.
   */
  type ReadHop =
    | {
        readonly value: unknown;
        readonly reads: ReferentReads;
        readonly transitive: boolean;
        readonly holder: ConditionedDeclaration;
        /** Where `value` stands in `holder`, by projected keys: a template
         *  body's reference there names by the body's lookup. */
        readonly at?: Keys;
      }
    | { readonly referred: ConditionedDeclaration; readonly reads: ReferrerReads }
    | { readonly resolved: ConditionedDeclaration; readonly reads: ReferentReads; readonly transitive: boolean }
    /** A scope member a reference resolved to, as the union holds it, near
     *  the declaration holding the reference: read as places of the
     *  declaration holding the member. */
    | { readonly member: object; readonly near: ConditionedDeclaration; readonly reads: ReferentReads; readonly transitive: boolean };
  const namedReadClasses = (
    start: readonly ReadHop[],
    wit: Witness,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const classes: ReadClass[] = [];
    const texts: unknown[] = [];
    const named = new Set<string>();
    const shapes = new Set<string>();
    const calls = new Set<string>();
    let condition = TRUE;
    const seen = new Map<ConditionedDeclaration, Set<unknown>>();
    const identified = new Set<string>();
    const queue: ReadHop[] = [...start];
    /** Each present declaration of `name`, every one identified once. */
    const identify = (name: string): ConditionedDeclaration[] => {
      const first = !identified.has(name);
      identified.add(name);
      named.add(name);
      const present: ConditionedDeclaration[] = [];
      for (const target of nameIndex.declarationsNamed(name)) {
        if (!declared(target, wit)) {
          if (first) {
            condition = space.and(condition, space.not(target.condition));
            texts.push([name, null]);
          }
          continue;
        }
        if (first) {
          const identity = identityAt(target, wit);
          condition = space.and(condition, space.and(target.condition, identity.taken));
          texts.push([name, identity.value]);
        }
        present.push(target);
      }
      return present;
    };
    /** Whether `target` is read by `token` for the first time. */
    const once = (target: ConditionedDeclaration, token: unknown): boolean => {
      const done = seen.get(target) ?? new Set<unknown>();
      if (done.has(token)) return false;
      seen.set(target, done.add(token));
      return true;
    };
    /** The places `places` of `target` read: held as its regions, a tagged
     *  one's members, a reference's and — `onward` — a value's references read
     *  on, a scope's annotations read, a referrers read queued. */
    const readIn = (
      target: ConditionedDeclaration,
      places: readonly (ReadPlace | ReferentPlace)[],
      onward?: { readonly reads: ReferentReads; readonly transitive: true },
    ): void => {
      const held: Keys[] = [];
      for (const p of places) {
        if (p.kind === "tagged") {
          classes.push(...taggedClasses(target, p.keys, wit, ownReads));
          continue;
        }
        if (p.kind === "referrers") {
          queue.push({ referred: target, reads: p.reads });
          continue;
        }
        if (p.kind === "scope") {
          if (!once(target, `scope ${textOf(p.keys)}`)) continue;
          const projected = project(target.manifest, wit).value;
          const along = nodesAlong(projected, p.keys, target.manifest, shapes, wit);
          for (const { node } of along) {
            for (const [keyword, value] of Object.entries(node)) if (keyword.startsWith("x-telo-")) namesIn(value, shapes, false);
          }
          readIn(target, annotationPlaces(along, p.keys, projected, target.manifest));
          continue;
        }
        held.push(p.keys);
        const next = p.kind === "reference" ? { reads: p.reads, transitive: p.transitive } : onward;
        if (!next) continue;
        const at = placeAt(target, p.keys, wit);
        if (at.present) queue.push({ value: project(at.node, wit).value, ...next, holder: target, at: p.keys });
      }
      if (ownReads?.own === target) ownReads.reads.push(...held);
      else classes.push(...regionClasses(target, held, wit, true));
    };
    while (queue.length > 0) {
      const next = queue.shift()!;
      if ("member" in next) {
        const found = memberAt(next.member, next.near, wit);
        if (!once(found.holder, `member ${textOf(found.at)} ${readsIdOf(next.reads)}`)) continue;
        const value = project(placeByProjectedKeys(union, found.holder, found.at, wit).node, wit).value as Record<string, any>;
        const places = next.reads({
          value,
          schema: input.schemaOf(value, found.holder.manifest),
          shapeOf: (shape) => input.shapeOf(shape, wit),
          definition: input.definitionOf(value, found.holder.manifest),
        });
        readIn(
          found.holder,
          [
            { kind: "value", keys: [...found.at, "metadata"] },
            ...places.map((place) => ({ ...place, keys: [...found.at, ...place.keys] })),
          ],
          next.transitive ? { reads: next.reads, transitive: true } : undefined,
        );
        continue;
      }
      if ("resolved" in next) {
        const target = next.resolved;
        const name = target.manifest.metadata?.name;
        if (input.isNamedShape(target.manifest)) {
          if (typeof name === "string") shapes.add(name);
          continue;
        }
        if (!once(target, next.reads)) continue;
        readIn(target, next.reads(referentAt(target, wit)), next.transitive ? { reads: next.reads, transitive: true } : undefined);
        continue;
      }
      if ("referred" in next) {
        const name = next.referred.manifest.metadata?.name;
        if (typeof name !== "string") continue;
        for (const referrer of referrerNames(next.referred)) {
          for (const target of identify(referrer)) {
            if (!once(target, `referrers ${readsIdOf(next.reads)} ${name}`)) continue;
            const slots: Keys[] = [];
            for (const unionKeys of slotsOf(target, name)) {
              const at = placeByUnionKeys(union, target, unionKeys, wit);
              if (at.present) slots.push(at.at);
              else classes.push({ text: textOf(["slot", target.manifest.metadata?.name, unionKeys, null]), condition: space.and(at.path, at.position) });
            }
            const places = next.reads({ ...referentAt(target, wit), slots });
            readIn(target, [...slots.map((keys): ReadPlace => ({ kind: "value", keys })), ...places]);
          }
        }
        continue;
      }
      const names = new Set<string>();
      namesIn(next.value, names, false);
      if (next.transitive) {
        const reached = new Set<string>();
        namesIn(next.value, reached, true, input.moduleNamesOf(next.holder.manifest));
        for (const callee of reached) if (!names.has(callee)) calls.add(callee);
      }
      // A reference a template body holds names a sibling entry first: read
      // as a place of the definition holding it, never by name.
      if (next.at !== undefined && TEMPLATE_BODY_FIELDS.includes(String(next.at[0]))) {
        for (const ref of refsIn(next.value)) {
          const body = bodyTargetOf(next.holder, ref, wit);
          if (!body) continue;
          classes.push(body.found);
          if (!body.keys) continue;
          if (body.target.kind === "sibling") names.delete(body.name);
          const holder = next.holder;
          if (!once(holder, `body ${readsIdOf(next.reads)} ${textOf(body.keys)}`)) continue;
          const entry = placeAt(holder, body.keys, wit);
          if (!entry.present) continue;
          const value = project(entry.node, wit).value as Record<string, any>;
          if (body.target.kind !== "sibling") {
            readIn(holder, [{ kind: "value", keys: body.keys }]);
            continue;
          }
          const places = next.reads({
            value,
            schema: input.schemaOf(value, holder.manifest),
            shapeOf: (shape) => input.shapeOf(shape, wit),
            definition: input.definitionOf(value, holder.manifest),
          });
          readIn(
            holder,
            [
              { kind: "value", keys: [...body.keys, "kind"] },
              { kind: "value", keys: [...body.keys, "metadata"] },
              ...places.map((place) => ({ ...place, keys: [...body.keys!, ...place.keys] })),
            ],
            next.transitive ? { reads: next.reads, transitive: true } : undefined,
          );
        }
      }
      for (const name of names) {
        for (const target of identify(name)) {
          if (input.isNamedShape(target.manifest)) {
            shapes.add(name);
            continue;
          }
          if (!once(target, next.reads)) continue;
          readIn(target, next.reads(referentAt(target, wit)), next.transitive ? { reads: next.reads, transitive: true } : undefined);
        }
      }
    }
    classes.unshift({ text: textOf(["named", texts]), condition, covers: { named } });
    if (calls.size > 0) {
      const found = nameReadClasses(calls, wit, callablePlaces, true, ownReads?.own);
      classes.push(...found.classes);
      ownReads?.reads.push(...found.reads);
    }
    classes.push(...shapeClasses(shapes, wit));
    return classes;
  };

  // --- Steps --------------------------------------------------------------
  /** An object of the union at the witness, but one member. */
  const projectExcept = (object: Record<string, unknown>, except: string, wit: Witness): { value: unknown; taken: Condition } => {
    const value: Record<string, unknown> = {};
    let held = TRUE;
    for (const [key, field] of Object.entries(object)) {
      if (key === except) continue;
      const projected = project(field, wit);
      held = space.and(held, projected.taken);
      if (projected.present) value[key] = projected.value;
    }
    return { value, taken: held };
  };

  /** The names of the objects written beneath each union node. */
  const namesBeneath = new WeakMap<object, ReadonlySet<string>>();
  const namedWithin = (value: unknown): ReadonlySet<string> => {
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return new Set();
    const known = namesBeneath.get(value);
    if (known) return known;
    const out = new Set<string>();
    if (isAlternatives(value)) {
      for (const option of value.options) for (const name of namedWithin(option.value)) out.add(name);
    } else {
      if (!Array.isArray(value) && typeof (value as { name?: unknown }).name === "string") {
        out.add((value as { name: string }).name);
      }
      for (const field of Array.isArray(value) ? value : Object.values(value)) {
        for (const name of namedWithin(field)) out.add(name);
      }
    }
    namesBeneath.set(value, out);
    return out;
  };

  /** The ordered names of the objects written beneath a union node, each
   *  choice's options in turn: what tells whether a choice decides the names. */
  const nameOrders = new WeakMap<object, string>();
  const nameOrderWithin = (value: unknown): string => {
    if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return "";
    const known = nameOrders.get(value);
    if (known !== undefined) return known;
    let out: string;
    if (isAlternatives(value)) out = `(${value.options.map((option) => (option.present ? nameOrderWithin(option.value) : "-")).join("|")})`;
    else {
      const parts: string[] = [];
      const name = Array.isArray(value) ? undefined : (value as { name?: unknown }).name;
      if (typeof name === "string") parts.push(JSON.stringify(name));
      else if (isAlternatives(name)) parts.push(textOf(name.options.map((option) => (option.present ? option.value : null))));
      for (const field of Array.isArray(value) ? value : Object.values(value)) {
        const inner = nameOrderWithin(field);
        if (inner !== "") parts.push(inner);
      }
      out = parts.length === 0 ? "" : `[${parts.join(",")}]`;
    }
    nameOrders.set(value, out);
    return out;
  };

  /** The names the `steps` record of `declaration` at `root` lists at the
   *  witness — read off its projection by the one step-name reader — and the
   *  options deciding them: the names only, never a step's content. */
  const stepRecordAt = (
    declaration: ConditionedDeclaration,
    projected: Record<string, unknown>,
    root: Keys,
    wit: Witness,
  ): {
    names: readonly string[] | undefined;
    namesClass: () => ReadClass;
    /** Each step the record lists: its name, its projected keys in the
     *  declaration and the field holding its value, where it has one. */
    steps: readonly { name: string; keys: Keys; valueField?: string }[];
  } => {
    const holder = valueAt(projected, root) as Record<string, any> | undefined;
    const schema = holder && typeof holder === "object" ? input.schemaOf(holder, declaration.manifest) : undefined;
    const names = schema ? stepRecordNames(holder!, schema) : undefined;
    const body = schema ? stepRecordBodies(holder!, schema).find((each) => each.entries.some((e) => e.form !== "none")) : undefined;
    const steps = (body?.entries ?? [])
      .filter((entry) => entry.form !== "none")
      .map((entry) => ({
        name: entry.name,
        keys: [...root, ...parseKeys(entry.stepPath)],
        ...(entry.form === "pure" && body!.slot.value ? { valueField: body!.slot.value } : {}),
      }));
    const namesClass = (): ReadClass => {
      const at = placeByProjectedKeys(union, declaration, root, wit);
      let condition = TRUE;
      const visit = (value: unknown): void => {
        if (isAlternatives(value)) {
          const option = optionAt(value, wit);
          if (!option) return;
          const orders = new Set(value.options.map((each) => (each.present ? nameOrderWithin(each.value) : "-")));
          if (orders.size > 1) condition = space.and(condition, option.condition);
          if (option.present) visit(option.value);
          return;
        }
        if (value === null || typeof value !== "object" || isTaggedSentinel(value) || nameOrderWithin(value) === "") return;
        for (const field of Array.isArray(value) ? value : Object.values(value)) visit(field);
      };
      if (at.present) visit(at.node);
      return { text: textOf(["step names", names ?? null]), condition };
    };
    return { names, namesClass, steps };
  };

  /** The site at `unionKeys` of `declaration` whose options are taken at the
   *  witness. */
  const siteAt = (declaration: ConditionedDeclaration, unionKeys: Keys, wit: Witness): UnionSite | undefined => {
    const text = textOf(unionKeys);
    return sites.find(
      (site) =>
        site.declaration === declaration &&
        textOf(site.unionKeys) === text &&
        site.options.every((option) => taken(option.condition, option.path, wit)),
    );
  };

  /** Every step object named `name` in `declaration` at the witness, and the
   *  condition of every option deciding whether one is there. */
  const stepObjects = (
    declaration: ConditionedDeclaration,
    name: string,
    wit: Witness,
  ): { objects: { object: Record<string, unknown>; unionKeys: Keys }[]; taken: Condition } => {
    const objects: { object: Record<string, unknown>; unionKeys: Keys }[] = [];
    let held = TRUE;
    const visit = (value: unknown, unionKeys: Keys): void => {
      if (!namedWithin(value).has(name)) return;
      if (isAlternatives(value)) {
        const option = optionAt(value, wit);
        if (!option) return;
        held = space.and(held, option.condition);
        if (option.present) visit(option.value, unionKeys);
        return;
      }
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...unionKeys, i]));
        return;
      }
      const record = value as Record<string, unknown>;
      if (record.name === name) objects.push({ object: record, unionKeys });
      for (const [key, field] of Object.entries(record)) visit(field, [...unionKeys, key]);
    };
    visit(declaration.manifest, []);
    return { objects, taken: held };
  };

  // --- Reads ----------------------------------------------------------------
  const stepReaders = new Map<UnionSite, Set<UnionSite>>();
  const treeOf = new Map<UnionSite, TreeReads>();
  for (const site of sites) {
    treeOf.set(site, treeReads(site.engine, site.source, input.moduleNamesOf(site.declaration.manifest)));
  }

  /** The names of the objects at each union path of a declaration, in any of
   *  its options. */
  const objectNames = new Map<ConditionedDeclaration, Map<string, Set<string>>>();
  const objectNamesOf = (declaration: ConditionedDeclaration): Map<string, Set<string>> => {
    const known = objectNames.get(declaration);
    if (known) return known;
    const out = new Map<string, Set<string>>();
    const visit = (value: unknown, unionKeys: Keys): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) if (option.present) visit(option.value, unionKeys);
        return;
      }
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
      if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, [...unionKeys, i]));
        return;
      }
      const name = (value as { name?: unknown }).name;
      if (typeof name === "string") {
        const text = textOf(unionKeys);
        out.set(text, (out.get(text) ?? new Set()).add(name));
      }
      for (const [key, field] of Object.entries(value)) visit(field, [...unionKeys, key]);
    };
    visit(declaration.manifest, []);
    objectNames.set(declaration, out);
    return out;
  };

  /** The producers a site's step reads may name, whatever the configuration. */
  const producersOf = (site: UnionSite): Set<UnionSite> => {
    const known = stepReaders.get(site);
    if (known) return known;
    const out = new Set<UnionSite>();
    stepReaders.set(site, out);
    const names = new Set<string>();
    let whole = false;
    for (const chain of treeOf.get(site)!.chains) {
      if (chain[0] !== "steps") continue;
      if (chain.length < 2 || chain[1] === INDEX_SEGMENT) whole = true;
      else names.add(chain[1]!);
    }
    if (!whole && names.size === 0) return out;
    const named = objectNamesOf(site.declaration);
    for (const other of sites) {
      if (other === site || other.declaration !== site.declaration) continue;
      if (other.unionKeys[other.unionKeys.length - 1] !== "value") continue;
      const holders = named.get(textOf(other.unionKeys.slice(0, -1)));
      if (holders && (whole || [...holders].some((n) => names.has(n)))) out.add(other);
    }
    return out;
  };

  // Strongly connected groups of step reads read each other by content.
  const group = new Map<UnionSite, number>();
  {
    let counter = 0;
    const index = new Map<UnionSite, number>();
    const low = new Map<UnionSite, number>();
    const stack: UnionSite[] = [];
    const onStack = new Set<UnionSite>();
    let groups = 0;
    const strong = (v: UnionSite): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      for (const w of producersOf(v)) {
        if (!index.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (low.get(v) === index.get(v)) {
        let member: UnionSite;
        const id = groups++;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          group.set(member, id);
        } while (member !== v);
      }
    };
    for (const site of sites) if (!index.has(site)) strong(site);
  }

  const solved = new Map<string, SolvedKey[]>();
  /** The output type each judged key of a producer yields. */
  /** Each judged key's producer fact, and the facts as comparable identities. */
  const factOf = new WeakMap<SolvedKey, StepFact>();
  const factIdentities = new FactIdentities();
  /** The fact `producer`'s judged key `key` gives its readers. */
  const keyFact = (producer: UnionSite, key: SolvedKey): StepFact => {
    const known = factOf.get(key);
    if (known) return known;
    if (!celRequests.has(key)) throw new Error(`internal: the producer ${producer.id} was read before its key was judged.`);
    const facts = key.verdict.facts[0];
    const fact = producerFact(producer.engine, facts?.type, facts?.produced);
    factOf.set(key, fact);
    return fact;
  };

  const keyHolding = (site: string, assignment: Assignment, variant: number): SolvedKey | undefined =>
    solved.get(site)?.find((key) => !key.dead && !key.wholeCare && key.variant === variant && space.holds(key.condition, assignment));
  /** Each union site's own keys: one written place may be several sites. */
  const siteKeys = new Map<UnionSite, SolvedKey[]>();
  const sitesOfId = new Map<string, UnionSite[]>();
  for (const site of sites) sitesOfId.set(site.id, [...(sitesOfId.get(site.id) ?? []), site]);
  // A branch no configuration takes is read where its run reads it: its
  // baseline — fixed by the whole space, whatever `within` keeps — with the
  // branch forced. Its REACH is the sites of the declarations holding its
  // choice, or lying in it, whose region holds the forced branch there: each
  // judged once there, and nothing else asked for in its run.
  const deadWitnesses = new Map<DeadBranch, Witness>();
  const deadWitness = (branch: DeadBranch): Witness => {
    let witness = deadWitnesses.get(branch);
    if (!witness) {
      witness = { assignment: branch.baseline, forcing: new Map([[branch.sentinel, branch.branch]]) as unknown as Forcing };
      deadWitnesses.set(branch, witness);
    }
    return witness;
  };
  const deadBranchOf = (sentinel: object, branch: string): DeadBranch => {
    const found = deadBranches.find((entry) => entry.sentinel === sentinel && entry.branch === branch);
    if (!found) throw new Error(`internal: a run reads the branch '${branch}' as one no configuration takes, which the choice reading does not name.`);
    return found;
  };
  const throughBranch = (path: readonly ChoiceStep[], branch: DeadBranch): boolean =>
    path.some((step) => step.sentinel === branch.sentinel && step.branch === branch.branch);
  /** The key of a site some configuration takes, read where the run of a
   *  branch no configuration takes reads it outside its reach: a WHOLE-CARE
   *  key, judged at that witness for the whole space and read there lazily for
   *  its facts alone — never a marker's answer, no branch its own. A key judged
   *  for the configurations kept never answers there, by text or by condition:
   *  its door held fixed what the kept configurations do not vary, which the
   *  witness may vary. Whole-care keys of the site with the same text are one:
   *  each is judged once, whichever witness reaches it first. */
  const wholeCare = new Map<UnionSite, Map<Witness, SolvedKey | null>>();
  const wholeCareKeyOf = (site: UnionSite, wit: Witness): SolvedKey | undefined => {
    let byWitness = wholeCare.get(site);
    if (!byWitness) wholeCare.set(site, (byWitness = new Map()));
    const known = byWitness.get(wit);
    if (known !== undefined) return known ?? undefined;
    if (!taken(site.condition, [...site.declaration.path, ...site.options.flatMap((option) => option.path)], wit)) {
      byWitness.set(wit, null);
      return undefined;
    }
    const found = keyAt(site, wit);
    const keys = siteKeys.get(site) ?? [];
    const shared = keys.find((key) => key.wholeCare && key.text === found.text);
    if (shared) {
      byWitness.set(wit, shared);
      return shared;
    }
    const key: SolvedKey = { text: found.text, condition: FALSE, variant: 0, verdict: { diagnostics: [], facts: [] }, wholeCare: true };
    byWitness.set(wit, key);
    siteKeys.set(site, [...keys, key]);
    solved.set(site.id, [...(solved.get(site.id) ?? []), key]);
    const { region } = regionOfKey(site, wit, found.region);
    judge(site.id, site.declaration, key, wit, found.coverage, region, site.unionKeys);
    return key;
  };
  /** The key of `site` a run of the branch `dead` reads at its witness: the
   *  site's own key there when it lies in the branch, else its whole-care key —
   *  the one lookup every family's read at a forced witness goes through. */
  const forcedKeyOf = (site: UnionSite, dead: DeadBranch, wit: Witness): SolvedKey | undefined => {
    const key = site.dead
      ? siteKeys.get(site)?.find((k) => k.dead === site.dead!.branch)
      : (siteKeys.get(site)?.find((k) => k.dead === dead) ?? wholeCareKeyOf(site, wit));
    if (key && observingKeyCosts()) {
      reportKeyCost({ kind: "forced-read", site: site.id, text: key.text, role: key.dead ? "dead" : key.wholeCare ? "whole-care" : "live" });
    }
    return key;
  };
  /** The dead branch a witness forces. */
  const forcedBranchOf = (wit: Witness): DeadBranch => {
    const forcing = wit.forcing as unknown as Map<object, string>;
    const found = deadBranches.find((entry) => forcing.get(entry.sentinel) === entry.branch);
    if (!found) throw new Error("internal: a witness forces a branch the choice reading names as none no configuration takes.");
    return found;
  };
  /** A key a kept configuration holds at `assignment`. */
  const liveKey = (keys: readonly SolvedKey[], assignment: Assignment): SolvedKey | undefined =>
    keys.find((k) => !k.dead && !k.wholeCare && space.holds(k.condition, assignment));
  /** The key of `site` read at `wit`: at a witness forcing a branch, what a run
   *  of that branch reads; otherwise the key a kept configuration holds. */
  const keyAtWitness = (site: UnionSite, wit: Witness): SolvedKey | undefined =>
    wit.forcing
      ? forcedKeyOf(site, forcedBranchOf(wit), wit)
      : site.dead
        ? siteKeys.get(site)?.find((key) => key.dead === site.dead!.branch)
        : liveKey(siteKeys.get(site) ?? [], wit.assignment);
  /** The keys of the written place `id` holding at `assignment` — inside the
   *  dead branch `dead`, what its run reads of each site there — one per site
   *  holding. */
  const keysAt = (id: string, assignment: Assignment, variant: number, dead?: DeadBranch): SolvedKey[] => {
    const own = sitesOfId.get(id);
    if (!own) {
      const key = dead ? wholeCareBodyKeyOf(id, variant, deadWitness(dead)) : keyHolding(id, assignment, variant);
      return key ? [key] : [];
    }
    const out: SolvedKey[] = [];
    for (const site of own) {
      const key = dead
        ? site.dead && site.dead.branch !== dead
          ? undefined
          : forcedKeyOf(site, dead, deadWitness(dead))
        : liveKey(siteKeys.get(site) ?? [], assignment);
      if (key) out.push(key);
    }
    return out;
  };
  /** What the keys holding at one written place found together: each
   *  finding once, and every occurrence's facts in turn. */
  const verdictOfKeys = (keys: readonly SolvedKey[]): CelSiteVerdict | undefined =>
    keys.length === 0 ? undefined : mergedVerdict(keys.map((key) => key.verdict));

  /** What the reference a step invokes resolves to, and the contract region
   *  of the declaration it resolves to — the reads typing that step's result. */
  const stepTargetClasses = (
    declaration: ConditionedDeclaration,
    invoke: unknown,
    stepKeys: Keys,
    wit: Witness,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] =>
    targetClasses(declaration, invoke, [...stepKeys, "invoke"], wit, (target) => dispatchPlaces(target, wit), ownReads);

  /** The places a dispatch to `target` is typed by: its contracts and, where
   *  neither it nor its kind declares an output contract, the value slot its
   *  kind derives one from. */
  const dispatchPlaces = (target: ConditionedDeclaration, wit: Witness): Keys[] =>
    dispatchPlacesOf(project(target.manifest, wit).value as Record<string, any>, target.manifest);
  /** {@link dispatchPlaces} of a declaration as projected, written in
   *  `within`'s module. */
  const dispatchPlacesOf = (projected: Record<string, any>, within: ResourceManifest): Keys[] => {
    const places: Keys[] = [["outputType"], ["inputType"]];
    if (projected.outputType !== undefined || input.kindContractOf(projected, within, "outputType") !== undefined) {
      return places;
    }
    const slot = valueDerivedSlot(input.schemaOf(projected, within), "outputType");
    return slot ? [...places, slot] : places;
  };
  /** What the reference `invoke`, written at `refKeys` of `declaration`,
   *  resolves to at the witness — its outcome class, covering the name's
   *  outcome alone — and the declaration of the union it names. */
  const resolutionAt = (
    declaration: ConditionedDeclaration,
    invoke: unknown,
    refKeys: Keys,
    wit: Witness,
  ):
    | {
        outcomeClass: ReadClass;
        resolved?: NonNullable<ReturnType<ConditionedNameIndex["locateAt"]>>["outcome"];
        target?: ConditionedDeclaration;
        name: string;
      }
    | undefined => {
    if (!isRefSentinel(invoke)) return undefined;
    const parsed = (invoke as { parsed?: { name?: unknown; alias?: unknown } }).parsed;
    const name = typeof parsed?.name === "string" ? parsed.name : undefined;
    if (name === undefined) return undefined;
    const alias = typeof parsed?.alias === "string" ? parsed.alias : undefined;
    const holder = declaration.manifest;
    const fromModule = (holder.metadata as { module?: string } | undefined)?.module;
    const targetModule = alias === undefined || alias === "Self" ? undefined : input.moduleForAlias(alias, holder);
    // A bare name reads the step's own scope first: a `with:` member it names
    // is the target there.
    const within =
      alias === undefined
        ? input.scopeAt(
            declaration,
            project(declaration.manifest, wit).value as Record<string, unknown>,
            expandedKeysOf(declaration.manifest, refKeys, wit),
          )
        : undefined;
    const outcome =
      alias === undefined || alias === "Self"
        ? nameIndex.locateAt("local", name, fromModule, within, wit)
        : targetModule === undefined
          ? undefined
          : nameIndex.inModuleAt(
              "exported",
              name,
              targetModule,
              (holder.metadata as { importPath?: string[] } | undefined)?.importPath,
              wit,
            );
    if (!outcome) return { outcomeClass: { text: textOf(["target", invoke.source, null]), condition: TRUE }, name };
    const resolved = outcome.outcome;
    const target =
      resolved.status === "unresolved"
        ? undefined
        : union.declarations.find((d) => d.manifest === resolved.declaration);
    const outcomeClass: ReadClass = {
      text: textOf([
        "target",
        invoke.source,
        resolved.status,
        resolved.status === "unresolved" ? null : [resolved.declaration.kind, resolved.address.key],
      ]),
      condition: outcome.condition,
      covers: { outcomes: [name] },
    };
    return { outcomeClass, resolved, target, name };
  };

  /** What the reference `invoke`, written at `refKeys` of `declaration`,
   *  resolves to, and the places `places` of the declaration it resolves to —
   *  the first a region read — with the named shapes its kind's contracts name. */
  const targetClasses = (
    declaration: ConditionedDeclaration,
    invoke: unknown,
    refKeys: Keys,
    wit: Witness,
    places: readonly Keys[] | ((target: ConditionedDeclaration) => readonly Keys[]),
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const resolution = resolutionAt(declaration, invoke, refKeys, wit);
    if (!resolution) return [];
    const { outcomeClass, resolved, target } = resolution;
    if (!resolved) return [outcomeClass];
    if (!target && resolved.status === "resolved" && resolved.address.scope) {
      // A scope member, written inside a declaration: the places a dispatch to
      // it is typed by, read as places of the declaration holding it, and the
      // named shapes its contracts and its kind's name.
      const member = resolved.declaration as unknown as object;
      const kindShapes = new Set<string>();
      const projectedMember = project(member, wit).value as Record<string, any>;
      for (const direction of ["outputType", "inputType"] as const) {
        namesIn(projectedMember[direction], kindShapes, false);
        namesIn(input.kindContractOf(projectedMember, declaration.manifest, direction), kindShapes, false);
      }
      return [outcomeClass, ...memberClasses(member, declaration, wit, ownReads), ...shapeClasses(kindShapes, wit)];
    }
    if (!target) return [outcomeClass];
    const kindShapes = new Set<string>();
    const projectedTarget = project(target.manifest, wit).value as Record<string, any>;
    for (const direction of ["outputType", "inputType"] as const) {
      // The kind's contract is the same everywhere; a named shape it names is not.
      namesIn(input.kindContractOf(projectedTarget, target.manifest, direction), kindShapes, false);
    }
    const shapes = shapeClasses(kindShapes, wit);
    return [outcomeClass, ...regionClasses(target, typeof places === "function" ? places(target) : places, wit), ...shapes];
  };

  /** What the reference `ref`, written at `refKeys` of `declaration`, resolves
   *  to at the witness, and what `reads` names in the declaration it resolves
   *  to — onward by name, and, `transitive`, again at its references — with
   *  the named shapes its kind's contracts name. A scope member it resolves to
   *  is written in a declaration: read as that member's own value. A place of
   *  `ownReads.own` a read reaches goes to its reads. */
  const resolvedTargetClasses = (
    declaration: ConditionedDeclaration,
    ref: unknown,
    refKeys: Keys,
    wit: Witness,
    reads: ReferentReads,
    transitive: boolean,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const resolution = resolutionAt(declaration, ref, refKeys, wit);
    if (!resolution) return [];
    const { outcomeClass, resolved, target } = resolution;
    if (!resolved) return [outcomeClass];
    const kindShapes = new Set<string>();
    const shapesOf = (projected: Record<string, any>, within: ResourceManifest): ReadClass[] => {
      for (const direction of ["outputType", "inputType"] as const) {
        // The kind's contract is the same everywhere; a named shape it names is not.
        namesIn(input.kindContractOf(projected, within, direction), kindShapes, false);
      }
      return shapeClasses(kindShapes, wit);
    };
    if (!target && resolved.status === "resolved" && resolved.address.scope) {
      // A scope member: the places `reads` names in it, read as places of the
      // declaration holding it.
      const member = resolved.declaration as unknown as object;
      return [
        outcomeClass,
        ...namedReadClasses([{ member, near: declaration, reads, transitive }], wit, ownReads),
        ...shapesOf(project(member, wit).value as Record<string, any>, declaration.manifest),
      ];
    }
    if (!target) return [outcomeClass];
    return [
      outcomeClass,
      ...namedReadClasses([{ resolved: target, reads, transitive }], wit, ownReads),
      ...shapesOf(project(target.manifest, wit).value as Record<string, any>, target.manifest),
    ];
  };

  /** The places `places` (projected keys) of `target`, a declaration a
   *  reference resolves to: each place's classes, the first covering the
   *  places present at the witness — the regions the key holds of the
   *  declaration, which it never holds whole. */
  const regionClasses = (
    target: ConditionedDeclaration,
    places: readonly Keys[],
    wit: Witness,
    asValues = false,
  ): ReadClass[] => {
    const regions: ReadClass[] = [];
    const roots: Keys[] = [];
    for (const keys of places) {
      regions.push(
        ...(asValues
          ? placeClasses(target, { kind: "value", keys }, wit)
          : placeClasses(target, { kind: "reference", keys, transitive: false, reads: READS_IDENTITY }, wit)),
      );
      const at = placeByProjectedKeys(union, target, keys, wit);
      if (at.present) roots.push(at.unionKeys);
    }
    const [first = { text: textOf(["places", null]), condition: TRUE }, ...rest] = regions;
    return [{ ...first, covers: { parts: [{ declaration: target, roots }] } }, ...rest];
  };

  /** The views built from each root consumer. */
  const viewsOf = new Map<ConditionedDeclaration, ConditionedView[]>();
  for (const view of union.views) {
    const owner = view.consumer.declaredIn ?? view.consumer;
    viewsOf.set(owner, [...(viewsOf.get(owner) ?? []), view]);
  }
  /** Where `member` — an object written in `declaration`, a scope member a
   *  reference resolves to — stands in it, by union keys. */
  const writtenKeys = new Map<ConditionedDeclaration, WeakMap<object, Keys>>();
  const unionKeysIn = (declaration: ConditionedDeclaration, member: object): Keys | undefined => {
    let known = writtenKeys.get(declaration);
    if (!known) {
      const found = new WeakMap<object, Keys>();
      const visit = (value: unknown, keys: Keys): void => {
        if (isAlternatives(value)) {
          for (const option of value.options) if (option.present) visit(option.value, keys);
          return;
        }
        if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
        if (!found.has(value)) found.set(value, keys);
        if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...keys, i]));
        else for (const [key, field] of Object.entries(value)) visit(field, [...keys, key]);
      };
      visit(declaration.manifest, []);
      writtenKeys.set(declaration, (known = found));
    }
    return known.get(member);
  };
  /** Where the scope member `member` — as the union holds it, resolved from a
   *  reference written in `near` — is written: the declaration of the union
   *  holding it, and its projected keys there at the witness. */
  const memberAt = (member: object, near: ConditionedDeclaration, wit: Witness): { holder: ConditionedDeclaration; at: Keys } => {
    const isView = viewSites.has(near);
    const within = isView ? (near as ConditionedView).consumer : near;
    // A view holds the scope members its body entry declares.
    for (const holder of [...(isView ? [near] : []), within, within.declaredIn, ...union.declarations]) {
      if (!holder) continue;
      const keys = unionKeysIn(holder, member);
      if (!keys) continue;
      const place = placeByUnionKeys(union, holder, keys, wit);
      if (!place.present) {
        throw new Error(`internal: the scope member at '${pathText(keys)}' of ${holder.manifest.kind}/${holder.manifest.metadata?.name} is absent where a reference resolves to it.`);
      }
      return { holder, at: place.at };
    }
    throw new Error(`internal: a scope member a reference in ${near.manifest.kind}/${near.manifest.metadata?.name} resolves to is written in no declaration of the union.`);
  };
  /** A scope member a read names, read as places of the declaration holding
   *  it: its `metadata` and the places a dispatch to it is typed by — a place
   *  of `ownReads.own` going to its reads. */
  const memberClasses = (
    member: object,
    near: ConditionedDeclaration,
    wit: Witness,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const found = memberAt(member, near, wit);
    const value = project(placeByProjectedKeys(union, found.holder, found.at, wit).node, wit).value as Record<string, any>;
    const places: Keys[] = [
      [...found.at, "metadata"],
      ...dispatchPlacesOf(value, found.holder.manifest).map((keys) => [...found.at, ...keys]),
    ];
    if (ownReads?.own === found.holder) {
      ownReads.reads.push(...places);
      return places.flatMap((keys) => placeClasses(found.holder, { kind: "value", keys }, wit));
    }
    return regionClasses(found.holder, places, wit, true);
  };

  /**
   * What a key over `declaration` reads across the references its forward
   * views cross, at the witness: for
   * each crossing whose holder the witness reaches (the declaration,
   * a consumer written in it, a view of it holding there, or a declaration an
   * earlier crossing names), the reference as the witness holds it, what it
   * resolves to, and the places read on in the declaration it names — never
   * that declaration whole. A scope member it resolves to is written in
   * `declaration` itself: the places read on in it are places of the
   * declaration the key reads (`reads`, projected keys), held in its region.
   */
  const crossedReads = (declaration: ConditionedDeclaration, wit: Witness): { classes: ReadClass[]; reads: Keys[] } => {
    const views = (viewsOf.get(declaration) ?? []).filter((view) => declared(view, wit));
    const reached = new Set<ConditionedDeclaration>([declaration, ...views.map((view) => view.consumer), ...views]);
    const read = new Set<object>();
    const out: ReadClass[] = [];
    const reads: Keys[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const crossing of views.flatMap((view) => view.crossed)) {
        if (read.has(crossing) || !reached.has(crossing.holder)) continue;
        read.add(crossing);
        grew = true;
        const at = navigateUnion(crossing.holder.manifest, crossing.at, wit);
        const reference = at.present ? project(at.node, wit) : undefined;
        out.push({
          text: textOf(["crossed", crossing.at, reference?.present ? reference.value : null]),
          condition: reference ? space.and(at.taken, reference.taken) : at.taken,
        });
        if (!reference?.present) continue;
        const resolution = resolutionAt(crossing.holder, reference.value, crossing.at, wit);
        if (!resolution) continue;
        out.push(resolution.outcomeClass);
        const { target, resolved } = resolution;
        if (!target) {
          const member = resolved && resolved.status !== "unresolved" && resolved.address.scope ? resolved.declaration : undefined;
          if (!member) continue;
          const found = memberAt(member, crossing.holder, wit);
          const keys = [...found.at, ...crossing.rest];
          if (found.holder !== declaration) {
            out.push(...regionClasses(found.holder, [keys], wit));
            continue;
          }
          const at = placeByProjectedKeys(union, declaration, keys, wit);
          if (!at.present) {
            out.push(...placeClasses(declaration, { kind: "value", keys }, wit));
            continue;
          }
          reads.push(at.at);
          out.push(...placeClasses(declaration, { kind: "reference", keys: at.at, transitive: false, reads: READS_IDENTITY }, wit));
          continue;
        }
        reached.add(target);
        out.push(...regionClasses(target, [crossing.rest], wit));
      }
    }
    return { classes: out, reads };
  };

  /** The classes of `steps.<name>` read in `declaration` — by the expression
   *  `site`, when one reads it; a place of `ownReads.own` a step target's
   *  contracts are read at goes to its reads. */
  const stepClasses = (
    declaration: ConditionedDeclaration,
    name: string,
    wit: Witness,
    site?: UnionSite,
    ownReads?: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const parts: unknown[] = [];
    const found = stepObjects(declaration, name, wit);
    let condition = found.taken;
    const targets: ReadClass[] = [];
    for (const { object, unionKeys } of found.objects) {
      const producer =
        isTaggedSentinel(object.value) || isAlternatives(object.value)
          ? siteAt(declaration, [...unionKeys, "value"], wit)
          : undefined;
      // An expression step reads its own name as what the other steps of that
      // name produce.
      if (site && producer === site) continue;
      const restProjected = projectExcept(object, "value", wit);
      condition = space.and(condition, restProjected.taken);
      targets.push(...stepTargetClasses(declaration, (restProjected.value as { invoke?: unknown }).invoke, unionKeys, wit, ownReads));
      if (producer && (!site || group.get(producer) !== group.get(site))) {
        const key = keyAtWitness(producer, wit);
        if (!key) throw new Error(`internal: the producer ${producer.id} holds no key in ${assignmentKey(wit.assignment)}.`);
        // Keyed on the whole fact: two keys of the producer typing it alike
        // but forwarding different schemas are two classes.
        const fact = factIdentities.identity(keyFact(producer, key));
        let yielding = FALSE;
        if (key.dead) yielding = key.condition;
        else {
          for (const other of siteKeys.get(producer) ?? []) {
            if (!other.dead && factIdentities.identity(keyFact(producer, other)) === fact) {
              yielding = space.or(yielding, other.condition);
            }
          }
        }
        condition = space.and(condition, yielding);
        parts.push([restProjected.value, { fact }]);
        continue;
      }
      const projected = project(object.value, wit);
      condition = space.and(condition, projected.taken);
      parts.push([restProjected.value, projected.present ? projected.value : null]);
    }
    return [{ text: textOf(parts), condition }, ...targets];
  };

  /** The class of an input read: what the configuration decides of it — the
   *  witness's baseline, since forcing a branch decides no input. */
  const inputClass = (
    module: string | undefined,
    importPath: readonly string[] | undefined,
    block: "variables" | "secrets" | "resources",
    name: string | undefined,
    wit: Witness,
  ): ReadClass => {
    const w = wit.assignment;
    const decided = narrowingAt(choices, wit)(module, importPath);
    const prefix = name === undefined ? `${block}.` : `${block}.${name}`;
    const holds = (chain: string) => chain === prefix || chain.startsWith(name === undefined ? prefix : `${prefix}.`);
    const parts: unknown[] = [];
    for (const [chain, value] of decided?.chains ?? []) if (holds(chain)) parts.push([chain, value]);
    for (const chain of decided?.present ?? []) if (holds(chain)) parts.push([chain, true]);
    let condition = TRUE;
    for (const dimension of choices.inputDimensions(module, importPath, block, name)) {
      condition = space.and(condition, space.literal(dimension.key, [w[dimension.key]]));
    }
    return { text: textOf(parts.sort((a, b) => textOf(a).localeCompare(textOf(b)))), condition };
  };

  /** The schema nodes on the way to `keys` of a projected declaration, each
   *  with its data path, and where the innermost declaration begins — and the
   *  named shapes the walk follows. */
  const nodesAlong = (
    data: unknown,
    keys: Keys,
    within: ResourceManifest,
    shapes: Set<string>,
    wit: Witness,
  ): { node: Record<string, any>; at: Keys; root: Keys }[] => {
    const out: { node: Record<string, any>; at: Keys; root: Keys }[] = [];
    const visit = (
      node: unknown,
      depth: number,
      root: Keys,
      document: Record<string, any>,
      seen: Set<object>,
    ): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      let schema = node as Record<string, any>;
      if (seen.has(schema)) return;
      const guard = new Set(seen).add(schema);
      if (typeof schema.$ref === "string") {
        const ref = schema.$ref as string;
        if (!ref.startsWith("#/")) {
          const shape = input.shapeNameOf(ref);
          if (shape !== undefined) shapes.add(shape);
        }
        const target = ref.startsWith("#/")
          ? (resolvePointer(document, ref.slice(1)) as Record<string, any> | undefined)
          : input.shapeOf(ref, wit);
        if (target) {
          if (!ref.startsWith("#/")) document = target;
          visit(target, depth, root, document, guard);
        }
      }
      out.push({ node: schema, at: keys.slice(0, depth), root });
      for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
        if (Array.isArray(schema[branch])) for (const member of schema[branch]) visit(member, depth, root, document, guard);
      }
      if (depth >= keys.length) return;
      const key = keys[depth]!;
      const value = valueAt(data, keys.slice(0, depth + 1));
      // An inline declaration beneath a field is judged by its own kind.
      if (
        depth + 1 < keys.length &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { kind?: unknown }).kind === "string" &&
        (value as { kind: string }).kind !== "Telo.Definition"
      ) {
        const nested = input.schemaOf(value as Record<string, any>, within);
        if (nested) {
          visit(nested, depth + 1, keys.slice(0, depth + 1), nested, new Set());
          return;
        }
      }
      if (typeof key === "number") {
        if (Array.isArray(schema.items)) visit(schema.items[key], depth + 1, root, document, guard);
        else if (schema.items) visit(schema.items, depth + 1, root, document, guard);
        if (Array.isArray(schema.prefixItems)) visit(schema.prefixItems[key], depth + 1, root, document, guard);
        return;
      }
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (properties && Object.hasOwn(properties, key)) {
        visit(properties[key], depth + 1, root, document, guard);
        return;
      }
      let matched = false;
      for (const [pattern, child] of Object.entries((schema.patternProperties ?? {}) as Record<string, unknown>)) {
        try {
          if (new RegExp(pattern, "u").test(key)) {
            matched = true;
            visit(child, depth + 1, root, document, guard);
          }
        } catch {
          // A pattern JS cannot read is the schema check's to report.
        }
      }
      if (!matched && schema.additionalProperties && typeof schema.additionalProperties === "object") {
        visit(schema.additionalProperties, depth + 1, root, document, guard);
      }
    };
    const rootSchema = input.schemaOf(data as Record<string, any>, within);
    if (rootSchema) visit(rootSchema, 0, [], rootSchema, new Set());
    return out;
  };

  /** The definition the kind of the declaration at `root` of `data`, written
   *  in `within`'s module, resolves to. */
  const definitionAt = (data: unknown, root: Keys, within: ResourceManifest): Record<string, any> | undefined => {
    const value = valueAt(data, root);
    return value && typeof value === "object" && !Array.isArray(value)
      ? input.definitionOf(value as Record<string, any>, within)
      : undefined;
  };

  /** The places every annotation on the way to a site at `keys` of `data`, a
   *  declaration written in `within`'s module, reads. */
  const annotationPlaces = (
    along: readonly { node: Record<string, any>; at: Keys; root: Keys }[],
    keys: Keys,
    data: unknown,
    within: ResourceManifest,
  ): ReadPlace[] => {
    const out: ReadPlace[] = [];
    for (const { node, at, root } of along) {
      const definition = definitionAt(data, root, within);
      const local = at.slice(root.length);
      const rest = keys.slice(root.length);
      let item: Keys = [];
      for (let i = Math.min(local.length, rest.length - 1); i >= 0; i--) {
        if (typeof rest[i] === "number") {
          item = rest.slice(0, i + 1);
          break;
        }
      }
      const annotated = (target: Record<string, any>): ReadPlace[] => {
        const places: ReadPlace[] = [];
        for (const [keyword, value] of Object.entries(target)) {
          if (!keyword.startsWith("x-telo-")) continue;
          const reporter = readReporterOf(keyword);
          if (!reporter) continue;
          places.push(...reporter({ value, node: target, at: local, item, delegate: annotated, definition }));
        }
        return places;
      };
      for (const place of annotated(node)) {
        out.push(place.kind === "referrers" ? place : { ...place, keys: [...root, ...place.keys] });
      }
    }
    return out;
  };

  /** Expanded keys of a site at the witness, from its union path. */
  const expandedKeys = (site: UnionSite, wit: Witness): Keys => expandedKeysOf(site.declaration.manifest, site.unionKeys, wit);
  /** Expanded keys of union path `unionKeys` from `root` at the witness. */
  const expandedKeysOf = (root: unknown, unionKeys: Keys, wit: Witness): Keys => {
    const out: (string | number)[] = [];
    let node: unknown = root;
    for (const key of unionKeys) {
      while (isAlternatives(node)) node = optionAt(node, wit)?.value;
      if (Array.isArray(node) && typeof key === "number") {
        let count = 0;
        for (let i = 0; i < key; i++) {
          let item: unknown = node[i];
          let present = true;
          while (isAlternatives(item)) {
            const option = optionAt(item, wit);
            present = !!option?.present;
            if (!present) break;
            item = option!.value;
          }
          if (present) count++;
        }
        out.push(count);
        node = node[key];
        continue;
      }
      out.push(key);
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[key as string] : undefined;
    }
    return out;
  };

  /** What the objects enclosing a site hold beside the way to it — what a
   *  union branch is selected by. */
  const shallowClass = (site: UnionSite, wit: Witness): ReadClass => enclosingClass(site.declaration, site.unionKeys, wit);
  /** What the objects on the union path `unionKeys` of `declaration` hold
   *  beside it, and the object there. */
  const enclosingClass = (declaration: ConditionedDeclaration, unionKeys: Keys, wit: Witness): ReadClass => {
    const parts: unknown[] = [];
    let condition = TRUE;
    let node: unknown = declaration.manifest;
    for (const key of [...unionKeys, undefined]) {
      while (isAlternatives(node)) node = optionAt(node, wit)?.value;
      if (node && typeof node === "object" && !Array.isArray(node) && !isTaggedSentinel(node)) {
        for (const [member, field] of Object.entries(node as Record<string, unknown>)) {
          if (member === key) continue;
          let value = field;
          while (isAlternatives(value)) {
            const option = optionAt(value, wit);
            condition = space.and(condition, option?.condition ?? FALSE);
            value = option?.present ? option.value : undefined;
          }
          parts.push([member, value && typeof value === "object" && !isTaggedSentinel(value) ? (Array.isArray(value) ? "[]" : "{}") : value]);
        }
      }
      if (key === undefined) break;
      node = node && typeof node === "object" ? (node as Record<string | number, unknown>)[key as string] : undefined;
    }
    return { text: textOf(parts), condition };
  };

  /** A key from its classes: its text, its condition and what it covers. */
  const keyOf = (prefix: unknown[], condition: Condition, classes: readonly ReadClass[]) => {
    const names = new Set<string>();
    const wholeReads = new Map<string, Set<WholeNameReader>>();
    const named = new Set<string>();
    const outcomes = new Set<string>();
    const parts = new Map<ConditionedDeclaration, Map<string, Keys>>();
    const referrers = new Set<string>();
    let presence = false;
    let observed: boolean | undefined;
    for (const read of classes) {
      condition = space.and(condition, read.condition);
      const covers = read.covers;
      if (!covers) continue;
      for (const n of covers.names ?? []) {
        names.add(n);
        let readers = wholeReads.get(n);
        if (!readers) wholeReads.set(n, (readers = new Set()));
        const reader = covers.readers?.get(n);
        if (reader) readers.add(reader);
      }
      for (const n of covers.named ?? []) named.add(n);
      for (const n of covers.outcomes ?? []) outcomes.add(n);
      for (const { declaration, roots } of covers.parts ?? []) {
        let held = parts.get(declaration);
        if (!held) parts.set(declaration, (held = new Map()));
        for (const keys of roots) held.set(textOf(keys), keys);
      }
      for (const n of covers.referrers ?? []) referrers.add(n);
      if (covers.presence) presence = true;
      if (covers.observed !== undefined) observed = covers.observed;
    }
    const coverage: KeyCoverage = {
      names,
      wholeReads,
      named,
      outcomes,
      parts: new Map([...parts].map(([declaration, held]) => [declaration, [...held.values()]])),
      referrers,
      presence,
      ...(observed !== undefined ? { observed } : {}),
    };
    return { text: textOf([...prefix, ...classes.map((c) => c.text)]), condition, coverage };
  };

  /** A site's key at the witness. */
  const keyAt = (
    site: UnionSite,
    wit: Witness,
  ): { text: string; condition: Condition; coverage: KeyCoverage; region: () => CelRegion } => {
    const module = (site.declaration.manifest.metadata as { module?: string } | undefined)?.module;
    const importPath = (site.declaration.manifest.metadata as { importPath?: string[] } | undefined)?.importPath;
    const classes: ReadClass[] = [shallowClass(site, wit)];
    const { chains, calls } = treeOf.get(site)!;
    const keys = expandedKeys(site, wit);
    const projected = project(site.declaration.manifest, wit).value as Record<string, unknown>;
    const shapes = new Set<string>();
    const along = nodesAlong(projected, keys, site.declaration.manifest, shapes, wit);
    // A schema an annotation on the way holds (a context's) names shapes too.
    for (const { node } of along) {
      for (const [keyword, value] of Object.entries(node)) {
        if (keyword.startsWith("x-telo-")) namesIn(value, shapes, false);
      }
    }
    const root = along.reduce<Keys>((deepest, n) => (n.root.length > deepest.length ? n.root : deepest), []);
    let record: ReturnType<typeof stepRecordAt> | undefined;
    let namesTaken = false;
    /** The places beyond the site it reads, by projected keys, and the steps
     *  whose objects it reads. */
    const reads: Keys[] = [];
    const ownReads = { own: site.declaration, reads };
    const stepsHeld = new Set<string>();
    /** The step-names class, once: what a read naming no step, or of `steps`
     *  whole, is judged against. */
    const takeNames = (): void => {
      if (namesTaken || record!.names === undefined) return;
      namesTaken = true;
      classes.push(record!.namesClass());
    };
    for (const chain of chains) {
      const [head, second, third] = chain;
      const name = second === undefined || second === INDEX_SEGMENT ? undefined : second;
      if (head === "variables" || head === "secrets") {
        classes.push(inputClass(module, importPath, head, name, wit));
        // A module document's own expression reads the block it declares.
        if (isModuleKind(site.declaration.manifest.kind)) reads.push([head]);
      } else if (head === "resources") {
        classes.push(inputClass(module, importPath, "resources", name, wit));
        const named = [name, third].filter((n): n is string => typeof n === "string" && n !== INDEX_SEGMENT);
        const declaredName = named.some((n) => nameIndex.declarationsNamed(n).length > 0);
        // A reading is typed from its declaration's identity and the places a
        // dispatch to it is typed by; everything else from its kind.
        const readNames = (names: Iterable<string>): void => {
          const found = nameReadClasses(names, wit, dispatchPlaces, false, site.declaration);
          classes.push(...found.classes);
          reads.push(...found.reads);
        };
        if (name === undefined) readNames(nameIndex.names());
        else if (declaredName) readNames(named);
        // A name no declaration answers to is refused with every declared name.
        else classes.push(presenceClass(wit));
        classes.push(...scopeMemberReads(site.declaration, keys, name, name !== undefined && !declaredName, wit, ownReads));
      } else if (head === "steps") {
        record ??= stepRecordAt(site.declaration, projected, root, wit);
        if (name === undefined) {
          takeNames();
          for (const n of [...(record.names ?? [])].sort()) {
            stepsHeld.add(n);
            classes.push(...stepClasses(site.declaration, n, wit, site, ownReads));
          }
        } else if (record.names?.includes(name)) {
          stepsHeld.add(name);
          classes.push(...stepClasses(site.declaration, name, wit, site, ownReads));
        } else {
          takeNames();
        }
      } else if (head === "inputs") {
        const holder = (valueAt(projected, root) ?? {}) as Record<string, any>;
        const kindContract = input.kindContractOf(holder, site.declaration.manifest, "inputType");
        for (const place of contractReads("inputType", holder, kindContract, input.definitionOf(holder, site.declaration.manifest))) {
          if (place.kind !== "referrers") reads.push([...root, ...place.keys]);
          classes.push(
            ...placeClasses(
              site.declaration,
              place.kind === "referrers" ? place : { ...place, keys: [...root, ...place.keys] },
              wit,
              { own: site.declaration, reads },
            ),
          );
        }
        // The kind's contract is the same everywhere; a named shape it names is not.
        const kindShapes = new Set<string>();
        namesIn(kindContract, kindShapes, false);
        classes.push(...shapeClasses(kindShapes, wit));
      }
    }
    if (readsObservedStateGate(site.declaration.manifest, site.unionKeys, chains)) classes.push(observedClass(wit));
    if (calls.size > 0) {
      const found = nameReadClasses([...calls].map((q) => q.slice(q.indexOf(".") + 1)), wit, callablePlaces, true, site.declaration);
      classes.push(...found.classes);
      reads.push(...found.reads);
    }
    for (const place of annotationPlaces(along, keys, projected, site.declaration.manifest)) {
      if (place.kind !== "referrers") reads.push(place.keys);
      classes.push(...placeClasses(site.declaration, place, wit, { own: site.declaration, reads }));
    }
    // The named shapes the site's schema path follows.
    classes.push(...shapeClasses(shapes, wit));
    const crossed = crossedReads(site.declaration, wit);
    classes.push(...crossed.classes);
    reads.push(...crossed.reads);
    if (!isKindDocument(site.declaration.manifest)) {
      classes.push(...scopeMembersClass(site.declaration, celRootsOf(site, wit, root, reads, stepsHeld.size > 0 ? record : undefined, stepsHeld).roots, wit));
    }
    const region = () =>
      celRegionOf(site, wit, root, reads, stepsHeld.size > 0 ? record : undefined, stepsHeld, namesTaken ? record!.names : undefined);
    const prefix = viewSites.has(site.declaration) ? [site.id, site.declaration.manifest.metadata?.name] : [site.id];
    return { ...keyOf(prefix, site.condition, classes), region };
  };

  /** The fact a carved producer's stand-in carries at the witness: the one
   *  the producer's key holding there gives. */
  const carvedFact = (producer: UnionSite, wit: Witness): StepFact => {
    const key = keyAtWitness(producer, wit);
    if (!key) throw new Error(`internal: the producer ${producer.id} holds no key in ${assignmentKey(wit.assignment)}.`);
    return keyFact(producer, key);
  };

  /** The roots of the region a CEL key judges its site on at the witness, by
   *  union keys — the site, the places its annotations and contracts read
   *  beyond it, the step objects it reads and the input contract they read —
   *  and each step object's place. */
  const celRootsOf = (
    site: UnionSite,
    wit: Witness,
    root: Keys,
    reads: readonly Keys[],
    record: ReturnType<typeof stepRecordAt> | undefined,
    stepsHeld: ReadonlySet<string>,
  ): { roots: Keys[]; steps: { step: { valueField?: string }; at: ReturnType<typeof placeByProjectedKeys> }[] } => {
    const declaration = site.declaration;
    const roots = new Map<string, Keys>([[textOf(site.unionKeys), site.unionKeys]]);
    const byProjected = (keys: Keys) => {
      const at = placeByProjectedKeys(union, declaration, keys, wit);
      if (at.present) roots.set(textOf(at.unionKeys), at.unionKeys);
      return at;
    };
    for (const keys of reads) byProjected(keys);
    const steps: { step: { valueField?: string }; at: ReturnType<typeof placeByProjectedKeys> }[] = [];
    if (record) {
      byProjected([...root, "inputType"]);
      for (const step of record.steps) {
        if (stepsHeld.has(step.name)) steps.push({ step, at: byProjected(step.keys) });
      }
    }
    return { roots: [...roots.values()], steps };
  };

  /** The scopes declared on the way to the regions of `declaration` at
   *  `roots` (union keys) no root holds, by projected keys. */
  const scopesOnTheWay = (declaration: ConditionedDeclaration, roots: readonly Keys[], wit: Witness): Keys[] => {
    const places = roots.map((keys) => placeByUnionKeys(union, declaration, keys, wit)).filter((place) => place.present);
    const out = new Map<string, Keys>();
    for (const place of places) {
      for (const keys of scopePlacesOf(place, input.scopeFieldsOf)) {
        if (!places.some((other) => isAtOrAbove(other.at, keys))) out.set(textOf(keys), keys);
      }
    }
    return [...out.values()];
  };

  /** The members of the scopes declared on the way to the regions of
   *  `declaration` at `roots` (union keys), which a key's region holds as
   *  their identities: which there are, where, and each one's `kind` and
   *  `metadata` — never a member's content. */
  const scopeMembersClass = (declaration: ConditionedDeclaration, roots: readonly Keys[], wit: Witness): ReadClass[] => {
    const scopes = scopesOnTheWay(declaration, roots, wit);
    if (scopes.length === 0) return [];
    const parts: unknown[] = [];
    let condition = TRUE;
    for (const keys of scopes) {
      const scope = placeAt(declaration, keys, wit);
      condition = space.and(condition, scope.taken);
      if (!scope.present || !Array.isArray(scope.node)) {
        parts.push([scope.keys, null]);
        continue;
      }
      const items: unknown[] = [];
      scope.node.forEach((item: unknown, i: number) => {
        let value = item;
        while (isAlternatives(value)) {
          const option = optionAt(value, wit);
          condition = space.and(condition, option?.condition ?? FALSE);
          value = option?.present ? option.value : undefined;
        }
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          items.push([i, null]);
          return;
        }
        const member = value as Record<string, unknown>;
        const identity = project({ kind: member.kind, metadata: member.metadata }, wit);
        condition = space.and(condition, identity.taken);
        items.push([i, identity.value]);
      });
      parts.push([scope.keys, items]);
    }
    return [{ text: textOf(["scope members", parts]), condition }];
  };

  /** Each scope member a `resources.<name>` read written at projected `keys`
   *  of `declaration` may name, read as a member is read: in a scope declared
   *  on the way, where it shadows a declaration of the module, or in the
   *  declaration's own scopes — all of them for a bare `resources` read — and,
   *  `anywhere` (a name no declaration answers to, refused naming the scope
   *  declaring it), in every declaration's own scopes. */
  const scopeMemberReads = (
    declaration: ConditionedDeclaration,
    keys: Keys,
    name: string | undefined,
    anywhere: boolean,
    wit: Witness,
    ownReads: { readonly own: ConditionedDeclaration; readonly reads: Keys[] },
  ): ReadClass[] => {
    const own = new Map<string, Keys>();
    const site = placeByProjectedKeys(union, declaration, keys, wit);
    if (site.present) for (const scope of scopePlacesOf(site, input.scopeFieldsOf)) own.set(textOf(scope), scope);
    for (const field of input.scopeFieldsOf(declaration.manifest)) own.set(textOf([field]), [field]);
    const holders: [ConditionedDeclaration, Keys[]][] = [[declaration, [...own.values()]]];
    if (anywhere) {
      for (const holder of declarations) {
        if (holder === declaration || !declared(holder, wit) || !namedWithin(holder.manifest).has(name!)) continue;
        holders.push([holder, input.scopeFieldsOf(holder.manifest).map((field): Keys => [field])]);
      }
    }
    const out: ReadClass[] = [];
    for (const [holder, scopes] of holders) {
      for (const scopeKeys of scopes) {
        const scope = placeByProjectedKeys(union, holder, scopeKeys, wit);
        if (!scope.present || !Array.isArray(scope.node)) continue;
        for (const item of scope.node) {
          let value: unknown = item;
          while (isAlternatives(value)) {
            const option = optionAt(value, wit);
            value = option?.present ? option.value : undefined;
          }
          if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
          const metadata = (value as { metadata?: unknown }).metadata;
          const named = metadata === undefined ? undefined : (project(metadata, wit).value as { name?: unknown } | undefined)?.name;
          if (name !== undefined && named !== name) continue;
          out.push(...memberClasses(value, holder, wit, ownReads));
        }
      }
    }
    return out;
  };

  /** The region a CEL key judges its site on at the witness, by union keys:
   *  the site, the places its annotations and contracts read beyond it, the
   *  step objects it reads, and the members of the scopes on the way as their
   *  identities. A read step's tagged
   *  value another group's key types — a forward included — is carved, its
   *  stand-in carrying that key's fact; a value held (a literal, or a member
   *  of the site's own read group) reaches no further steps, since its tagged
   *  members are open in its shape and a group member is read as `dyn`. */
  const celRegionOf = (
    site: UnionSite,
    wit: Witness,
    root: Keys,
    reads: readonly Keys[],
    record: ReturnType<typeof stepRecordAt> | undefined,
    stepsHeld: ReadonlySet<string>,
    stepNames: readonly string[] | undefined,
  ): CelRegion => {
    const declaration = site.declaration;
    const { roots, steps } = celRootsOf(site, wit, root, reads, record, stepsHeld);
    const carved = new Map<string, { keys: Keys; fact: StepFact }>();
    for (const { step, at } of steps) {
      if (!at.present || step.valueField === undefined) continue;
      const valueKeys = [...at.unionKeys, step.valueField];
      if (!navigate(declaration.manifest, valueKeys, wit).present) continue;
      const producer = siteAt(declaration, valueKeys, wit);
      if (producer && producer !== site && group.get(producer) !== group.get(site)) {
        carved.set(textOf(valueKeys), { keys: valueKeys, fact: carvedFact(producer, wit) });
      }
    }
    return { roots, carved: [...carved.values()], ...(stepNames ? { stepNames } : {}) };
  };

  /** A CEL key's own extent at the witness, counted from the union as written
   *  (`regionExtent`): its regions, each carved place one node. */
  const celExtentOf = (declaration: ConditionedDeclaration, region: CelRegion, wit: Witness): number =>
    regionExtent(union, declaration, region.roots, region.carved.map((carve) => carve.keys), wit, input.scopeFieldsOf);

  /** A key's region, read at the witness judging it — its own, or another
   *  where carve parity re-judges it — for a site judged on region parts: any
   *  but a kind document's. */
  const regionOfKey = (
    site: UnionSite,
    witness: Witness,
    region: () => CelRegion,
  ): { region?: (at: Witness) => CelRegion } =>
    isKindDocument(site.declaration.manifest)
      ? {}
      : { region: (at) => (at === witness ? region() : keyAt(site, at).region()) };

  /** What a key covers beyond its site's own region. */
  const coveredBy = (coverage: KeyCoverage): number =>
    coverage.names.size + coverage.named.size + coverage.outcomes.size + coverage.parts.size + coverage.referrers.size;

  /** Report whether the site of a key about to be judged is absent at its
   *  witness — a template body's site never is — and which key it is. */
  const reportPresence = (
    family: "cel" | "schema" | "relation",
    site: string,
    declaration: ConditionedDeclaration,
    unionKeys: Keys | undefined,
    witness: Witness,
    reads: number,
    coverage: KeyCoverage,
    key: { readonly variant: number; readonly dead?: DeadBranch; readonly wholeCare?: true },
  ): void => {
    if (!observingKeyCosts()) return;
    const absent = unionKeys !== undefined && !placeByUnionKeys(union, declaration, unionKeys, witness).present;
    const role = key.dead ? "dead" : key.wholeCare ? "whole-care" : "live";
    reportKeyCost({
      kind: "key-presence",
      family,
      site,
      declaration,
      unionKeys,
      variant: key.variant,
      role,
      absent,
      reads,
      covered: coveredBy(coverage),
    });
  };

  // --- The witness loop ----------------------------------------------------
  /** Judge one key in its own environment, and record what it yields. */
  const judge = (
    site: string,
    declaration: ConditionedDeclaration,
    key: SolvedKey,
    witness: Witness,
    coverage: KeyCoverage,
    region?: (witness: Witness) => CelRegion,
    unionKeys?: Keys,
  ): void => {
    if (region && observingKeyCosts()) {
      reportKeyCost({ kind: "cel-extent", site, nodes: celExtentOf(declaration, region(witness), witness) });
    }
    reportPresence("cel", site, declaration, unionKeys, witness, region ? region(witness).roots.length - 1 : 0, coverage, key);
    const verdict = input.judgeKey({
      site,
      key: key.text,
      declaration,
      witness,
      variant: key.variant,
      coverage,
      ...(region ? { region } : {}),
    });
    (key as { verdict: CelSiteVerdict }).verdict = verdict;
    celRequests.set(key, { declaration, coverage, ...(region ? { region } : {}) });
  };

  const celRequests = new WeakMap<
    SolvedKey,
    { declaration: ConditionedDeclaration; coverage: KeyCoverage; region?: (witness: Witness) => CelRegion }
  >();

  // Sites in the order their step reads go: a producer before its readers.
  const levelOf = new Map<UnionSite, number>();
  const level = (site: UnionSite, trail: Set<UnionSite>): number => {
    const known = levelOf.get(site);
    if (known !== undefined) return known;
    trail.add(site);
    let out = 0;
    for (const producer of producersOf(site)) {
      if (group.get(producer) === group.get(site) || trail.has(producer)) continue;
      out = Math.max(out, level(producer, trail) + 1);
    }
    trail.delete(site);
    levelOf.set(site, out);
    return out;
  };
  const levels: UnionSite[][] = [];
  for (const site of sites) (levels[level(site, new Set())] ??= []).push(site);

  for (const wave of levels) {
    if (!wave) continue;
    const pending: {
      site: UnionSite;
      key: SolvedKey;
      witness: Witness;
      coverage: KeyCoverage;
      region?: (witness: Witness) => CelRegion;
    }[] = [];
    for (const site of wave) {
      const keys: SolvedKey[] = siteKeys.get(site) ?? [];
      siteKeys.set(site, keys);
      const all = solved.get(site.id) ?? [];
      solved.set(site.id, all);
      if (site.dead) {
        // One key, read where its choice is reached with the branch forced: it
        // holds in no configuration.
        const witness = deadWitness(site.dead.branch);
        const found = keyAt(site, witness);
        const key: SolvedKey = {
          text: found.text,
          condition: FALSE,
          variant: 0,
          verdict: { diagnostics: [], facts: [] },
          dead: site.dead.branch,
        };
        keys.push(key);
        all.push(key);
        pending.push({ site, key, witness, coverage: found.coverage, ...regionOfKey(site, witness, found.region) });
        continue;
      }
      let remaining = space.and(site.condition, universe);
      while (remaining !== FALSE) {
        const w = space.firstAssignment(remaining)!;
        const witness: Witness = { assignment: w };
        const found = keyAt(site, witness);
        // A key some configuration holds is judged for the kept ones alone.
        const condition = space.and(found.condition, universe);
        if (!space.holds(condition, w)) {
          throw new Error(`internal: the key of ${site.id} does not hold where it was read.`);
        }
        const known = keys.find((key) => !key.dead && key.text === found.text);
        if (known) known.condition = space.or(known.condition, condition);
        else {
          const key: SolvedKey = { text: found.text, condition, variant: 0, verdict: { diagnostics: [], facts: [] } };
          keys.push(key);
          all.push(key);
          pending.push({ site, key, witness, coverage: found.coverage, ...regionOfKey(site, witness, found.region) });
        }
        remaining = space.and(remaining, space.not(condition));
      }
    }
    for (const { site, key, witness, coverage, region } of pending) judge(site.id, site.declaration, key, witness, coverage, region, site.unionKeys);
  }

  // A template body's expressions, per variant: read off each variant's
  // expansion of the body, where they are.
  const body = new Set<string>();
  const holderOf = new Map<ResourceManifest, ConditionedDeclaration>();
  for (const declaration of union.declarations) holderOf.set(declaration.manifest, declaration);
  /** Each template body site's declaration and reads, per variant. */
  const bodyEntries = new Map<string, { declaration: ConditionedDeclaration; entry: CensusEntry; reads: ReturnType<typeof treeReads>[] }>();
  /** A template body site's key at the witness, in `variant`. */
  const bodyKeyAt = (id: string, variant: number, witness: Witness) => {
    const { entry, reads } = bodyEntries.get(`${id}\0${variant}`)!;
    const classes: ReadClass[] = [];
    for (const { chains, calls } of reads) {
      for (const chain of chains) {
        const [head, second] = chain;
        const name = second === undefined || second === INDEX_SEGMENT ? undefined : second;
        if (head === "variables" || head === "secrets" || head === "resources") {
          classes.push(inputClass(entry.module, entry.importPath, head, name, witness));
        }
        if (head === "resources") classes.push(...nameReadClasses(name ? [name] : nameIndex.names(), witness, dispatchPlaces, false).classes);
      }
      if (calls.size > 0) {
        classes.push(...nameReadClasses([...calls].map((q) => q.slice(q.indexOf(".") + 1)), witness, callablePlaces, true).classes);
      }
    }
    // A body's site is a kind document's: typed through the observed-state
    // context where no region of its own applies.
    classes.push(observedClass(witness));
    return keyOf([id, variant], universe, classes);
  };
  for (let variant = 0; variant < input.variants; variant++) {
    const census = input.bodyCensus(variant);
    const pending: { id: string; declaration: ConditionedDeclaration; key: SolvedKey; witness: Witness; coverage: KeyCoverage }[] = [];
    for (const [id, entry] of census) {
      if (!isBodySiteId(id)) continue;
      const declaration = holderOf.get(entry.holder);
      if (!declaration) throw new Error(`internal: the template body site ${id} has no declaration in the union.`);
      body.add(id);
      const keys: SolvedKey[] = solved.get(id) ?? [];
      solved.set(id, keys);
      const reads = entry.expressions.map(({ engine, source }) => treeReads(engine, source, entry.moduleNames));
      bodyEntries.set(`${id}\0${variant}`, { declaration, entry, reads });
      let remaining = universe;
      while (remaining !== FALSE) {
        const w = space.firstAssignment(remaining)!;
        const witness: Witness = { assignment: w };
        const found = bodyKeyAt(id, variant, witness);
        const known = keys.find((key) => !key.wholeCare && key.variant === variant && key.text === found.text);
        if (known) known.condition = space.or(known.condition, found.condition);
        else {
          const key: SolvedKey = { text: found.text, condition: found.condition, variant, verdict: { diagnostics: [], facts: [] } };
          keys.push(key);
          pending.push({ id, declaration, key, witness, coverage: found.coverage });
        }
        remaining = space.and(remaining, space.not(found.condition));
      }
    }
    for (const { id, declaration, key, witness, coverage } of pending) judge(id, declaration, key, witness, coverage);
  }
  /** A template body site read where a branch no configuration takes reads it:
   *  its whole-care key at that witness, shared by text with the site's other
   *  whole-care keys of the variant. */
  const wholeCareBody = new Map<string, Map<Witness, SolvedKey | null>>();
  const wholeCareBodyKeyOf = (id: string, variant: number, wit: Witness): SolvedKey | undefined => {
    const held = bodyEntries.get(`${id}\0${variant}`);
    if (!held) return undefined;
    let byWitness = wholeCareBody.get(`${id}\0${variant}`);
    if (!byWitness) wholeCareBody.set(`${id}\0${variant}`, (byWitness = new Map()));
    const known = byWitness.get(wit);
    let key = known ?? undefined;
    if (known === undefined) {
      const found = bodyKeyAt(id, variant, wit);
      const keys = solved.get(id)!;
      key = keys.find((k) => k.wholeCare && k.variant === variant && k.text === found.text);
      if (!key) {
        key = { text: found.text, condition: FALSE, variant, verdict: { diagnostics: [], facts: [] }, wholeCare: true };
        keys.push(key);
        judge(id, held.declaration, key, wit, found.coverage);
      }
      byWitness.set(wit, key);
    }
    if (key && observingKeyCosts()) reportKeyCost({ kind: "forced-read", site: id, text: key.text, role: "whole-care" });
    return key;
  };

  // --- A declaration's own checks ----------------------------------------
  // Each site of a declaration's own checks (`own-check-sites.ts`) is judged
  // once per key: the region's content as the witness projects it, its cut
  // regions aside, and what checking it reads beyond it — the named shapes its
  // kind's schema reaches, the inputs a whole-value chain in it is held to
  // as their decided value, and every annotation read in it.
  /** Whether a site rooted at `path`, its region holding the branches `held`
   *  no configuration takes at the branch's witness, is in its reach. */
  const inReach = (path: readonly ChoiceStep[], held: readonly AlternativeOption[], branch: DeadBranch): boolean =>
    throughBranch(path, branch) || held.some((option) => throughBranch(option.path, branch));
  /** The branches no configuration takes whose choice `declaration` holds, or
   *  which it lies in, in the choice reading's order. */
  const deadBranchesIn = new Map<ConditionedDeclaration, readonly DeadBranch[]>();
  const deadBranchesOf = (declaration: ConditionedDeclaration): readonly DeadBranch[] => {
    const known = deadBranchesIn.get(declaration);
    if (known) return known;
    const found = new Set<DeadBranch>();
    const take = (path: readonly ChoiceStep[]) => {
      for (const branch of deadBranches) if (throughBranch(path, branch)) found.add(branch);
    };
    take(declaration.path);
    const walk = (value: unknown): void => {
      if (isAlternatives(value)) {
        for (const option of value.options) {
          take(option.path);
          if (option.present) walk(option.value);
        }
        return;
      }
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
      for (const field of Array.isArray(value) ? value : Object.values(value)) walk(field);
    };
    if (deadBranches.length > 0) walk(declaration.manifest);
    const out = deadBranches.filter((branch) => found.has(branch));
    deadBranchesIn.set(declaration, out);
    return out;
  };
  /** The own-check and relation sites in each branch's reach, in site order. */
  const ownReach = new Map<DeadBranch, string[]>();
  const relationReach = new Map<DeadBranch, Set<string>>();

  /** The union node at `unionKeys` of `root`, every choice on the way settled
   *  at the witness; the last, the region's own root, left as it is. */
  const unionNodeAt = (root: unknown, unionKeys: Keys, wit: Witness): unknown => {
    let node = root;
    for (const key of unionKeys) {
      while (isAlternatives(node)) {
        const option = optionAt(node, wit);
        node = option?.present ? option.value : undefined;
      }
      if (node === null || typeof node !== "object") return undefined;
      node = (node as Record<string | number, unknown>)[key as string];
    }
    return node;
  };

  /** A site's region at the witness, its cut regions standing as markers: its
   *  content, the options taken in it, its expressions and its inline
   *  declarations. */
  const regionOf = (site: OwnSite, wit: Witness) => {
    const expressions: { engine: string; source: string }[] = [];
    const refs: { value: unknown; unionKeys: Keys }[] = [];
    const inlines: Record<string, any>[] = [];
    const dead: AlternativeOption[] = [];
    const walk = (value: unknown, keys: Keys): { value: unknown; taken: Condition } => {
      if (keys.length > site.unionKeys.length && site.carved.has(JSON.stringify(keys))) return { value: CARVED_PLACE, taken: TRUE };
      if (isAlternatives(value)) {
        for (const option of value.options) if (option.unreachable && option.present) dead.push(option);
        const option = optionAt(value, wit);
        if (!option) return { value: "$none", taken: FALSE };
        if (!option.present) return { value: "$absent", taken: option.condition };
        const inner = walk(option.value, keys);
        return { value: inner.value, taken: space.and(option.condition, inner.taken) };
      }
      if (isTaggedSentinel(value)) {
        if (isRefSentinel(value)) refs.push({ value, unionKeys: keys });
        else expressions.push({ engine: value.engine, source: value.source });
        return { value, taken: TRUE };
      }
      if (value === null || typeof value !== "object" || (value as { __compiled?: unknown }).__compiled) return { value, taken: TRUE };
      let taken = TRUE;
      if (Array.isArray(value)) {
        const items = value.map((item, i) => {
          const inner = walk(item, [...keys, i]);
          taken = space.and(taken, inner.taken);
          return inner.value;
        });
        return { value: items, taken };
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value)) {
        const inner = walk(field, [...keys, key]);
        taken = space.and(taken, inner.taken);
        out[key] = inner.value;
      }
      if (keys.length > 0 && typeof out.kind === "string") inlines.push(out);
      return { value: out, taken };
    };
    const projected = walk(unionNodeAt(site.declaration.manifest, site.unionKeys, wit), site.unionKeys);
    return { ...projected, expressions, refs, inlines, dead };
  };

  /** Every schema node a declaration's data at `keys`, on the way to it and
   *  beneath it is judged against, each with its data path and where its
   *  declaration begins; the named shapes followed join `shapes`. */
  const nodesUnder = (
    data: unknown,
    keys: Keys,
    within: ResourceManifest,
    shapes: Set<string>,
    wit: Witness,
    carved: readonly Keys[] = [],
  ): { node: Record<string, any>; at: Keys; root: Keys }[] => {
    const out: { node: Record<string, any>; at: Keys; root: Keys }[] = [];
    const carvedTexts = new Set(carved.map((keys) => textOf(keys)));
    const visit = (node: unknown, at: Keys, root: Keys, document: Record<string, any>, seen: Set<object>): void => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      // A carved place is its own site's: nothing at or beneath it is read here.
      if (carvedTexts.size > 0 && carvedTexts.has(textOf(at))) return;
      const schema = node as Record<string, any>;
      if (seen.has(schema)) return;
      const guard = new Set(seen).add(schema);
      if (typeof schema.$ref === "string") {
        const ref = schema.$ref as string;
        if (!ref.startsWith("#/")) {
          const shape = input.shapeNameOf(ref);
          if (shape !== undefined) shapes.add(shape);
        }
        const target = ref.startsWith("#/")
          ? (resolvePointer(document, ref.slice(1)) as Record<string, any> | undefined)
          : input.shapeOf(ref, wit);
        if (target) visit(target, at, root, ref.startsWith("#/") ? document : target, guard);
      }
      out.push({ node: schema, at, root });
      for (const branch of ["allOf", "anyOf", "oneOf"] as const) {
        if (Array.isArray(schema[branch])) for (const member of schema[branch]) visit(member, at, root, document, guard);
      }
      const value = valueAt(data, at);
      if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
      // On the way to the region its one key; beneath it, every child.
      const children: [string | number, unknown][] =
        at.length < keys.length
          ? [[keys[at.length]!, valueAt(value, [keys[at.length]!])]]
          : Array.isArray(value)
            ? value.map((item, i) => [i, item])
            : Object.entries(value as Record<string, unknown>);
      for (const [key, child] of children) {
        const next = [...at, key];
        // An inline declaration beneath a field is judged by its own kind.
        if (
          at.length > 0 &&
          child &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          typeof (child as { kind?: unknown }).kind === "string" &&
          (child as { kind: string }).kind !== "Telo.Definition"
        ) {
          const nested = input.schemaOf(child as Record<string, any>, within);
          if (nested) {
            visit(nested, next, next, nested, new Set());
            continue;
          }
        }
        if (typeof key === "number") {
          if (schema.items && !Array.isArray(schema.items)) visit(schema.items, next, root, document, guard);
          if (Array.isArray(schema.items)) visit(schema.items[key], next, root, document, guard);
          if (Array.isArray(schema.prefixItems)) visit(schema.prefixItems[key], next, root, document, guard);
          continue;
        }
        const properties = schema.properties as Record<string, unknown> | undefined;
        if (properties && Object.hasOwn(properties, key)) {
          visit(properties[key], next, root, document, guard);
          continue;
        }
        let matched = false;
        for (const [pattern, member] of Object.entries((schema.patternProperties ?? {}) as Record<string, unknown>)) {
          try {
            if (new RegExp(pattern, "u").test(key)) {
              matched = true;
              visit(member, next, root, document, guard);
            }
          } catch {
            // A pattern JS cannot read is the schema check's to report.
          }
        }
        if (!matched && schema.additionalProperties && typeof schema.additionalProperties === "object") {
          visit(schema.additionalProperties, next, root, document, guard);
        }
      }
    };
    const rootSchema = input.schemaOf(data as Record<string, any>, within);
    if (rootSchema) visit(rootSchema, [], [], rootSchema, new Set());
    return out;
  };

  /** The places every annotation in a region of `data`, a declaration
   *  written in `within`'s module, reads: each annotated node read for every
   *  list item it may cover. */
  const regionAnnotationPlaces = (
    nodes: readonly { node: Record<string, any>; at: Keys; root: Keys }[],
    data: unknown,
    within: ResourceManifest,
  ): ReadPlace[] => {
    const out = new Map<string, ReadPlace>();
    for (const { node, at, root } of nodes) {
      const definition = definitionAt(data, root, within);
      const local = at.slice(root.length);
      let deepest: Keys = [];
      for (let i = local.length - 1; i >= 0; i--) {
        if (typeof local[i] === "number") {
          deepest = local.slice(0, i + 1);
          break;
        }
      }
      const items: Keys[] = [deepest];
      const value = valueAt(data, at);
      if (Array.isArray(value)) value.forEach((_, i) => items.push([...local, i]));
      for (const item of items) {
        const annotated = (target: Record<string, any>): ReadPlace[] => {
          const places: ReadPlace[] = [];
          for (const [keyword, annotation] of Object.entries(target)) {
            if (!keyword.startsWith("x-telo-")) continue;
            const reporter = readReporterOf(keyword);
            if (!reporter) continue;
            places.push(...reporter({ value: annotation, node: target, at: local, item, delegate: annotated, definition }));
          }
          return places;
        };
        for (const place of annotated(node)) {
          const rooted = place.kind === "referrers" ? place : { ...place, keys: [...root, ...place.keys] };
          out.set(placeText(rooted), rooted);
        }
      }
    }
    return [...out.values()];
  };

  // What every CEL site of a declaration was typed as is read by the checks
  // joining a value to its slot: each site's facts at the witness, a class
  // holding wherever the site's keys give the same facts.
  const unionSitesOf = new Map<ConditionedDeclaration, UnionSite[]>();
  for (const u of sites) unionSitesOf.set(u.declaration, [...(unionSitesOf.get(u.declaration) ?? []), u]);
  // A template body's sites, by the definition holding them: what a relation
  // site of its body reads the facts of.
  const bodySitesOf = new Map<string, string[]>();
  for (const id of body) {
    const identity = JSON.stringify((JSON.parse(id) as unknown[]).slice(0, 3));
    bodySitesOf.set(identity, [...(bodySitesOf.get(identity) ?? []), id]);
  }
  const factsTexts = new WeakMap<SolvedKey, string>();
  const factsTextOf = (key: SolvedKey): string => {
    let text = factsTexts.get(key);
    if (text === undefined) factsTexts.set(key, (text = textOf(key.verdict.facts)));
    return text;
  };
  /** What the expressions written at `id` were typed as at `wit`, occurrence
   *  by occurrence: a dead branch's own keys where the witness forces it. A
   *  relation key reads those of its own declaration's sites alone — another
   *  declaration's at the same written place (a view's beside its consumer's,
   *  two declarations of one holder) are not its occurrences. */
  const celFactsAt = (id: string, wit: Witness, variant: number, dead: DeadBranch | undefined, only: ConditionedDeclaration) => {
    const all = sitesOfId.get(id);
    if (!all) return verdictOfKeys(keysAt(id, wit.assignment, variant, dead))?.facts;
    const keys: SolvedKey[] = [];
    for (const site of all) {
      const key = dead
        ? site.dead && site.dead.branch !== dead
          ? undefined
          : forcedKeyOf(site, dead, deadWitness(dead))
        : liveKey(siteKeys.get(site) ?? [], wit.assignment);
      if (!key) continue;
      if (site.declaration === only) keys.push(key);
    }
    return verdictOfKeys(keys)?.facts;
  };
  /** The class of what the expressions written at `id` were typed as at `wit`:
   *  holding wherever each site there holds a key giving the same facts, and
   *  every other site there holds none. */
  const factsClassAt = (id: string, wit: Witness, variant: number, dead: DeadBranch | undefined): ReadClass | undefined => {
    const own = sitesOfId.get(id);
    const keys = keysAt(id, wit.assignment, own ? 0 : variant, dead);
    if (keys.length === 0) return undefined;
    let condition = TRUE;
    const texts: string[] = [];
    const sameFacts = (list: readonly SolvedKey[], key: SolvedKey): Condition => {
      if (key.dead) return key.condition;
      let held = FALSE;
      for (const other of list) {
        if (!other.dead && other.variant === key.variant && factsTextOf(other) === factsTextOf(key)) held = space.or(held, other.condition);
      }
      return held;
    };
    if (!own) {
      condition = sameFacts(solved.get(id) ?? [], keys[0]!);
      texts.push(factsTextOf(keys[0]!));
    } else {
      for (const site of own) {
        const list = siteKeys.get(site) ?? [];
        if (!keys.some((k) => list.includes(k))) {
          condition = space.and(condition, space.not(space.some(list.filter((k) => !k.dead).map((k) => k.condition))));
        }
      }
      for (const key of keys) {
        const list = own.map((site) => siteKeys.get(site) ?? []).find((l) => l.includes(key))!;
        condition = space.and(condition, sameFacts(list, key));
        texts.push(factsTextOf(key));
      }
    }
    return { text: textOf(["facts", id, texts]), condition };
  };

  /** An own-check site's key at the witness, in `variant`. */
  const ownKeyAt = (site: OwnSite, wit: Witness, variant: number, dead?: DeadBranch) => {
    const outcomeClasses = (declaration: ConditionedDeclaration, ref: { value: unknown; unionKeys: Keys }): ReadClass[] => {
      const resolution = resolutionAt(declaration, ref.value, ref.unionKeys, wit);
      return resolution ? [resolution.outcomeClass] : [];
    };
    const declaration = site.declaration;
    const module = (declaration.manifest.metadata as { module?: string } | undefined)?.module;
    const importPath = (declaration.manifest.metadata as { importPath?: string[] } | undefined)?.importPath;
    const region = regionOf(site, wit);
    const classes: ReadClass[] = [{ text: textOf(region.value), condition: region.taken }];
    // A site whose root is absent at the witness judges nothing, and reads nothing.
    const place = placeByUnionKeys(union, declaration, site.unionKeys, wit);
    if (!place.present) {
      return { ...keyOf([site.id, variant], site.condition, classes), dead: region.dead, reads: [] as Keys[] };
    }
    // The named shapes the schemas checking it reach.
    const shapes = new Set<string>();
    for (const value of [declaration.manifest as Record<string, any>, ...region.inlines]) {
      namesIn(input.schemaOf(value, declaration.manifest), shapes, false);
    }
    // An input a whole-value chain reads is held to its slot as its decided value.
    for (const { engine, source } of region.expressions) {
      for (const [head, second] of treeReads(engine, source, input.moduleNamesOf(declaration.manifest)).chains) {
        if (head !== "variables" && head !== "secrets" && head !== "resources") continue;
        const name = second === undefined || second === INDEX_SEGMENT ? undefined : second;
        classes.push(inputClass(module, importPath, head, name, wit));
      }
    }
    // What every annotation in the region reads.
    const projected = project(declaration.manifest, wit).value as Record<string, unknown>;
    const keys = place.at;
    const carvedAt = [...site.carved]
      .map((text) => placeByUnionKeys(union, declaration, JSON.parse(text) as Keys, wit))
      .filter((at) => at.present)
      .map((at) => at.at);
    /** The places of the declaration the key reads beyond its region. */
    const readKeys: Keys[] = [];
    if (valueAt(projected, keys) !== undefined) {
      const nodes = nodesUnder(projected, keys, declaration.manifest, shapes, wit, carvedAt);
      for (const { node } of nodes) {
        for (const [keyword, value] of Object.entries(node)) if (keyword.startsWith("x-telo-")) namesIn(value, shapes, false);
      }
      // A reference an annotation reads is read for its own content and what
      // it resolves to; a read crossing it reads what it names.
      for (const place of regionAnnotationPlaces(nodes, projected, declaration.manifest)) {
        if (place.kind !== "referrers") readKeys.push(place.keys);
        // A reference an annotation reads one hop is judged by what it
        // resolves to; one it follows on, by the places its reader names.
        if (place.kind !== "reference" || place.transitive) {
          classes.push(...placeClasses(declaration, place, wit, { own: declaration, reads: readKeys }));
          continue;
        }
        classes.push(...placeClasses(declaration, { kind: "value", keys: place.keys }, wit));
        const at = placeByProjectedKeys(union, declaration, place.keys, wit);
        if (!at.present) continue;
        const read = regionOf({ declaration, unionKeys: at.unionKeys, carved: new Set() } as unknown as OwnSite, wit);
        for (const ref of read.refs) {
          // A template body's reference to a sibling entry reads that entry,
          // a place of the definition.
          const body = TEMPLATE_BODY_FIELDS.includes(String(place.keys[0])) ? bodyTargetOf(declaration, ref.value, wit) : undefined;
          if (body) classes.push(body.found);
          if (body?.keys) readKeys.push(body.keys);
          if (body?.target.kind !== "sibling") classes.push(...outcomeClasses(declaration, ref));
        }
      }
    }
    // A kind document or a named shape is checked against what it names: the
    // shapes it references, whole, and — a kind document's — what every
    // reference in it resolves to, in its body by the template body's lookup,
    // a sibling entry read as a place of its own.
    if (isKindDocument(declaration.manifest)) {
      const named = new Set<string>();
      namesIn(region.value, named, false);
      for (const name of named) if (allNamedShapes(name)) shapes.add(name);
      for (const ref of region.refs) {
        const body = TEMPLATE_BODY_FIELDS.includes(String(ref.unionKeys[0])) ? bodyTargetOf(declaration, ref.value, wit) : undefined;
        if (body) classes.push(body.found);
        if (body?.keys) readKeys.push(body.keys);
        if (body?.target.kind !== "sibling") classes.push(...outcomeClasses(declaration, ref));
      }
    } else if (declaration.manifest.kind === "Telo.JsonSchema") {
      namesIn(region.value, shapes, false);
    } else {
      // What every reference in it resolves to: its outcome, never the content
      // of the declaration it names.
      for (const ref of region.refs) classes.push(...outcomeClasses(declaration, ref));
    }
    // Its contracts, resolved with the kind's: what a projection in either
    // reads, and the shapes the kind's contract names.
    for (const direction of ["inputType", "outputType"] as const) {
      const kindContract = input.kindContractOf(projected, declaration.manifest, direction);
      if (kindContract === undefined && projected[direction] === undefined) continue;
      for (const place of contractReads(direction, projected, kindContract, input.definitionOf(projected, declaration.manifest))) {
        if (place.kind !== "referrers") readKeys.push(place.keys);
        classes.push(...placeClasses(declaration, place, wit, { own: declaration, reads: readKeys }));
      }
      namesIn(kindContract, shapes, false);
    }
    classes.push(...shapeClasses(shapes, wit));
    const reads = new Map<string, Keys>();
    for (const keys of readKeys) reads.set(textOf(keys), keys);
    // The members of the scopes on the way to the region and its reads.
    const roots: Keys[] = [site.unionKeys];
    for (const keys of reads.values()) {
      const at = placeByProjectedKeys(union, declaration, keys, wit);
      if (at.present) roots.push(at.unionKeys);
    }
    classes.push(...scopeMembersClass(declaration, roots, wit));
    return { ...keyOf([site.id, variant], site.condition, classes), dead: region.dead, reads: [...reads.values()] };
  };

  /**
   * A schema site's own extent at the witness, counted from the union as
   * written — never from what a key normalizes: the declaration's `kind` and
   * `metadata`, each object on the way to the region's root with what it holds
   * beside the way (one node each) and the `kind` and `metadata` of an inline
   * declaration on it, each member of the scopes on the way as its identity,
   * and the region, each carved place one node; nothing where the region is
   * absent.
   */
  const ownExtentOf = (site: OwnSite, wit: Witness): number => {
    const content = regionOf(site, wit).value;
    if (site.unionKeys.length === 0) return countNodes(content);
    const place = placeByUnionKeys(union, site.declaration, site.unionKeys, wit);
    if (!place.present) return 0;
    // What holding the members of the scopes on the way, each its identity,
    // adds to the region's extent.
    const scoped =
      regionExtent(union, site.declaration, [site.unionKeys], [], wit, input.scopeFieldsOf) -
      regionExtent(union, site.declaration, [site.unionKeys], [], wit, () => []);
    const identity = (value: { kind: unknown; metadata: unknown }) =>
      countNodes(value.kind) + (value.metadata === undefined ? 0 : countNodes(value.metadata));
    let n = 1 + identity({ kind: site.declaration.manifest.kind, metadata: site.declaration.manifest.metadata });
    for (let depth = 0; depth < place.at.length; depth++) {
      const declared = depth === 0 || place.identities.has(depth);
      for (const member of Object.keys(place.enclosing.get(depth) ?? {})) {
        if (declared && (member === "kind" || member === "metadata")) continue;
        n++;
      }
      if (depth + 1 === place.at.length) continue;
      n++;
      const inner = place.identities.get(depth + 1);
      if (inner && typeof place.at[depth + 1] !== "number") n += identity(inner);
    }
    return n + countNodes(content) + scoped;
  };

  const ownSolved = new Map<string, OwnSolvedKey[]>();
  const ownRequests = new WeakMap<
    OwnSolvedKey,
    { site: OwnSite; sites: readonly OwnSite[]; coverage: KeyCoverage; reads: readonly Keys[] }
  >();
  /** The sites each declaration's findings were found at, by the written
   *  place of the declaration they were judged on. */
  const ownByOrigin = new Map<string, OwnSite[]>();
  const judgedOrigins = new Set<string>();
  const judgeOwn = (
    site: OwnSite,
    sites: readonly OwnSite[],
    key: OwnSolvedKey,
    witness: Witness,
    found: { coverage: KeyCoverage; reads: readonly Keys[] },
  ): void => {
    const { coverage, reads } = found;
    reportPresence("schema", site.id, site.declaration, site.unionKeys, witness, reads.length, coverage, key);
    if (observingKeyCosts()) {
      reportKeyCost({ kind: "schema-extent", site: site.id, nodes: ownExtentOf(site, witness) });
      // A read beyond the region lands in an enclosing site's region; one
      // landing in a sibling's or a carved sub-site's is another site's.
      for (const keys of reads) {
        const at = placeByProjectedKeys(union, site.declaration, keys, witness);
        if (!at.present) continue;
        let holder: OwnSite | undefined;
        for (const other of sites) {
          if (!isAtOrAbove(other.unionKeys, at.unionKeys)) continue;
          if (!holder || other.unionKeys.length > holder.unionKeys.length) holder = other;
        }
        const carvedBeneath = [...site.carved].some((text) => isAtOrAbove(at.unionKeys, JSON.parse(text) as Keys));
        if ((holder && holder !== site && !isAtOrAbove(holder.unionKeys, site.unionKeys)) || carvedBeneath) {
          reportKeyCost({ kind: "carve-read", site: site.id, keys: at.unionKeys });
        }
      }
    }
    const verdict = input.judgeOwnKey({
      site,
      key: key.text,
      witness,
      variant: key.variant,
      coverage,
      sites,
      reads,
    });
    key.verdict = verdict;
    ownRequests.set(key, { site, sites, coverage, reads });
    for (const origin of verdict.origins) judgedOrigins.add(origin);
    for (const d of verdict.diagnostics) {
      const origin = (d.data as { ownOrigin?: string } | undefined)?.ownOrigin;
      if (origin === undefined) throw new Error(`internal: a finding of own-check site ${site.id} names no declaration it was judged on.`);
      const list = ownByOrigin.get(origin) ?? [];
      if (!list.includes(site)) ownByOrigin.set(origin, [...list, site]);
    }
  };
  const isDefinitionSite = (site: OwnSite) => site.declaration.manifest.kind === "Telo.Definition";
  const viewSiteName = (view: ConditionedView): string => viewSiteNameOf(union, view);
  // A forward view's schema checks are its own sites', keyed on its regions;
  // the declaration it is built from holds none of them.
  for (const declaration of [...union.declarations, ...union.views]) {
    const view = viewSites.has(declaration);
    const cutStarted = observingKeyCosts() ? performance.now() : undefined;
    const schemaSites = ownSitesOf(declaration, space, input.ownSchemas, view ? viewSiteName(declaration as ConditionedView) : undefined);
    if (cutStarted !== undefined) reportKeyCost({ kind: "own-cut", milliseconds: performance.now() - cutStarted });
    for (const site of schemaSites) {
      const sites = schemaSites;
      const keys: OwnSolvedKey[] = [];
      ownSolved.set(site.id, keys);
      const pending: { key: OwnSolvedKey; witness: Witness; found: { coverage: KeyCoverage; reads: readonly Keys[] } }[] = [];
      const rootPath = [...declaration.path, ...(site.options[site.options.length - 1]?.path ?? [])];
      if (space.and(site.condition, universe) !== FALSE) {
        for (let variant = 0; variant < (isDefinitionSite(site) ? input.variants : 1); variant++) {
          let remaining = space.and(site.condition, universe);
          while (remaining !== FALSE) {
            const w = space.firstAssignment(remaining)!;
            const witness: Witness = { assignment: w };
            const found = ownKeyAt(site, witness, variant);
            const condition = space.and(found.condition, universe);
            if (!space.holds(condition, w)) {
              throw new Error(`internal: the key of own-check site ${site.id} does not hold where it was read.`);
            }
            const known = keys.find((key) => !key.dead && key.text === found.text);
            if (known) known.condition = space.or(known.condition, condition);
            else {
              const key: OwnSolvedKey = { text: found.text, condition, variant, verdict: { diagnostics: [], origins: [] } };
              keys.push(key);
              pending.push({ key, witness, found });
            }
            remaining = space.and(remaining, space.not(condition));
          }
        }
      }
      // Each branch no configuration takes whose reach the site is in: one key,
      // at the witness its run reads.
      for (const branch of deadBranchesOf(declaration)) {
        const witness = deadWitness(branch);
        if (!taken(site.condition, rootPath, witness)) continue;
        const found = ownKeyAt(site, witness, 0, branch);
        if (!inReach(rootPath, found.dead, branch)) continue;
        const key: OwnSolvedKey = { text: found.text, condition: FALSE, variant: 0, verdict: { diagnostics: [], origins: [] }, dead: branch };
        keys.push(key);
        pending.push({ key, witness, found });
        ownReach.set(branch, [...(ownReach.get(branch) ?? []), site.id]);
      }
      for (const { key, witness, found } of pending) judgeOwn(site, sites, key, witness, found);
    }
  }

  // --- Relation sites ------------------------------------------------------
  // Each relational group's instances are found by a CENSUS by position: one
  // run of a declaration's root region at its first witness, then one run of
  // every option not taken there, at the first assignment of that option's
  // condition — forced at its baseline for a branch no configuration takes —
  // nested options carved out of each run, so every written place is
  // enumerated once. An instance exists exactly where its anchor's written
  // place exists; a site is keyed by its anchor's content and what it reads.
  const relationSites = new Map<string, RelationSite>();
  /** What names a view's relation instances in a run's findings: the group,
   *  the consumer the findings are reported at and the view's place beneath it. */
  const viewRelationSites = new Map<string, RelationSite[]>();
  const viewRelationKey = (view: ConditionedView, group: string): string => {
    const root = view.consumer;
    const reportedAs = (root.declaredIn ?? root).manifest;
    const named = union.placeOf(reportedAs).resource ?? { kind: reportedAs.kind, name: reportedAs.metadata?.name };
    const source = (root.manifest.metadata as { source?: unknown } | undefined)?.source;
    return JSON.stringify([group, viewChainOf(view.manifest, root.manifest), named.kind, named.name, source]);
  };
  /** What names a declaration's relation sites: its holder's identity; a
   *  view's, its own — a view is written nowhere. */
  const holderIdentity = (declaration: ConditionedDeclaration) => {
    if (viewSites.has(declaration)) {
      const meta = declaration.manifest.metadata as { source?: unknown } | undefined;
      return { kind: declaration.manifest.kind, name: viewSiteName(declaration as ConditionedView), source: meta?.source };
    }
    const holder = declaration.holder;
    const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
    return { kind: holder.kind ?? expansionTagLabel(holder), name: meta?.name, source: meta?.source };
  };
  /** Where an option is read: the first configuration taking it. */
  const witnessFor = (condition: Condition): Witness | undefined => {
    const live = space.and(condition, universe);
    return live === FALSE ? undefined : { assignment: space.firstAssignment(live)! };
  };
  if (input.relationGroups.length > 0) {
    for (const declaration of [...union.declarations, ...union.views]) {
      const identity = holderIdentity(declaration);
      const isDefinition = declaration.manifest.kind === "Telo.Definition";
      for (let variant = 0; variant < (isDefinition ? input.variants : 1); variant++) {
        const runs: { unionKeys: Keys; witness: Witness; dead?: true }[] = [];
        const base = witnessFor(declaration.condition);
        if (base) runs.push({ unionKeys: [], witness: base });
        // Each branch no configuration takes in the declaration: one run of its
        // root region where the branch's run reads it.
        for (const branch of deadBranchesOf(declaration)) {
          const witness = deadWitness(branch);
          if (taken(declaration.condition, declaration.path, witness)) runs.push({ unionKeys: [], witness, dead: true });
        }
        while (runs.length > 0) {
          const run = runs.shift()!;
          for (const group of input.relationGroups) {
            for (const anchor of input.relationAnchors(group, declaration, run.unionKeys, run.witness, variant)) {
              const place = placeByProjectedKeys(union, declaration, anchor, run.witness);
              if (!place.present) {
                throw new Error(`internal: the ${group} reader reports an anchor at '${pathText(anchor)}' its region does not hold.`);
              }
              const id = relationSiteId(
                group,
                identity.kind,
                identity.name,
                identity.source,
                viewSites.has(declaration) ? viewAnchorText(place) : pathText(place.written),
              );
              if (relationSites.has(id)) continue;
              const site: RelationSite = {
                id,
                group,
                declaration,
                unionKeys: place.unionKeys,
                written: place.written,
                options: place.options,
                condition: place.path,
              };
              relationSites.set(id, site);
              if (viewSites.has(declaration)) {
                const held = viewRelationKey(declaration as ConditionedView, group);
                viewRelationSites.set(held, [...(viewRelationSites.get(held) ?? []), site]);
              }
            }
          }
          // The options beneath a configuration's run it does not take: each a
          // run of its own where some configuration takes it.
          if (run.dead) continue;
          const root = placeByUnionKeys(union, declaration, run.unionKeys, run.witness);
          if (!root.present) continue;
          const visit = (value: unknown, unionKeys: Keys, condition: Condition): void => {
            if (isAlternatives(value)) {
              for (const option of value.options) {
                if (!option.present) continue;
                if (taken(option.condition, option.path, run.witness)) {
                  visit(option.value, unionKeys, space.and(condition, option.condition));
                  continue;
                }
                const witness = witnessFor(space.and(condition, option.condition));
                if (witness) runs.push({ unionKeys, witness });
              }
              return;
            }
            if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return;
            if (Array.isArray(value)) {
              value.forEach((item, i) => visit(item, [...unionKeys, i], condition));
              return;
            }
            for (const [key, field] of Object.entries(value)) visit(field, [...unionKeys, key], condition);
          };
          visit(root.node, run.unionKeys, root.path);
        }
      }
    }
  }

  // The census anchors of each declaration, by group: what a relation key
  // carves out of the regions it reads.
  const censusOf = new Map<ConditionedDeclaration, Map<string, RelationSite[]>>();
  for (const site of relationSites.values()) {
    let byGroup = censusOf.get(site.declaration);
    if (!byGroup) censusOf.set(site.declaration, (byGroup = new Map()));
    byGroup.set(site.group, [...(byGroup.get(site.group) ?? []), site]);
  }
  /** The union paths of `site`'s own group's anchors nested beneath `root`,
   *  the outermost of each nest — never one holding the site's own anchor. */
  const nestedAnchors = (site: RelationSite, root: Keys): Keys[] => {
    const beneath = (censusOf.get(site.declaration)?.get(site.group) ?? []).filter(
      (other) =>
        other.unionKeys.length > root.length &&
        isAtOrAbove(root, other.unionKeys) &&
        !isAtOrAbove(other.unionKeys, site.unionKeys),
    );
    return beneath
      .filter((other) => !beneath.some((outer) => outer.unionKeys.length < other.unionKeys.length && isAtOrAbove(outer.unionKeys, other.unionKeys)))
      .map((other) => other.unionKeys);
  };

  /** The step objects of `declaration` a read of `names` reaches at the
   *  witness — those named, and those their values read, transitively — each by
   *  its union path; the first class is their content, then what each target
   *  resolves to and its contracts. */
  const stepReadClasses = (
    declaration: ConditionedDeclaration,
    names: readonly string[],
    wit: Witness,
    carvedUnder: (root: Keys) => readonly Keys[],
  ): { classes: ReadClass[]; roots: Keys[] } => {
    // A compound step is read without the nested items another site judges.
    const projectStep = (object: unknown, unionKeys: Keys) => {
      const within = carvedUnder(unionKeys).map((keys) => keys.slice(unionKeys.length));
      return project(within.length > 0 ? union.carve(object, within, CARVED_PLACE) : object, wit);
    };
    const reached = new Set(names);
    const queue = [...names];
    const parts: unknown[] = [];
    const targets: ReadClass[] = [];
    const roots: Keys[] = [];
    /** Places of the declaration a target's contracts are read at. */
    const ownReads = { own: declaration, reads: [] as Keys[] };
    let condition = TRUE;
    let whole = false;
    while (queue.length > 0) {
      const name = queue.shift()!;
      const found = stepObjects(declaration, name, wit);
      condition = space.and(condition, found.taken);
      for (const { object, unionKeys } of found.objects) {
        const projected = projectStep(object, unionKeys);
        condition = space.and(condition, projected.taken);
        parts.push([name, projected.value]);
        roots.push(unionKeys);
        targets.push(...stepTargetClasses(declaration, (projected.value as { invoke?: unknown }).invoke, unionKeys, wit, ownReads));
        for (const read of stepNamesReadBy(projected.value)) {
          if (read === undefined) whole = true;
          else if (!reached.has(read)) {
            reached.add(read);
            queue.push(read);
          }
        }
      }
    }
    if (whole) {
      // A whole read lists the names the declaration's `steps` record holds.
      const record = stepRecordAt(declaration, project(declaration.manifest, wit).value as Record<string, unknown>, [], wit);
      targets.push(record.namesClass());
      for (const name of [...(record.names ?? [])].sort()) {
        if (reached.has(name)) continue;
        reached.add(name);
        const found = stepObjects(declaration, name, wit);
        condition = space.and(condition, found.taken);
        for (const { object, unionKeys } of found.objects) {
          const projected = projectStep(object, unionKeys);
          condition = space.and(condition, projected.taken);
          parts.push([name, projected.value]);
          roots.push(unionKeys);
          targets.push(...stepTargetClasses(declaration, (projected.value as { invoke?: unknown }).invoke, unionKeys, wit, ownReads));
        }
      }
    }
    // A pure step forwarding the declaration's own inputs is typed by its
    // input contract.
    const inputType = navigate(declaration.manifest, ["inputType"], wit);
    condition = space.and(condition, inputType.taken);
    if (inputType.present) {
      const projected = project(inputType.node, wit);
      condition = space.and(condition, projected.taken);
      parts.push(["inputType", projected.value]);
      roots.push(["inputType"]);
    }
    for (const keys of ownReads.reads) {
      const at = placeByProjectedKeys(union, declaration, keys, wit);
      if (at.present) roots.push(at.unionKeys);
    }
    return { classes: [{ text: textOf(["steps", parts]), condition }, ...targets], roots };
  };

  /** How the objects written beneath each declaration are judged, once. */
  const nestedIn = new Map<ConditionedDeclaration, ReturnType<OwnSiteSchemas["nestedPlacesOf"]>>();
  const nestedOf = (declaration: ConditionedDeclaration) => {
    let known = nestedIn.get(declaration);
    if (!known) nestedIn.set(declaration, (known = input.ownSchemas.nestedPlacesOf(declaration)));
    return known;
  };
  /** Whether the object written at projected `keys` of `declaration` is a
   *  declaration normalization draws out of it, as the runs' enumeration
   *  settles. */
  const extractedAt = (declaration: ConditionedDeclaration, keys: Keys, wit: Witness): boolean => {
    const at = placeByProjectedKeys(union, declaration, keys, wit);
    return at.present && at.node !== null && typeof at.node === "object" && nestedOf(declaration).of(at.node) === "extracted";
  };
  /** The union paths a relation key carves out of the extracted declarations its
   *  reader follows `targets` into: every member the target does not read. */
  const extractedRestarts = (declaration: ConditionedDeclaration, targets: readonly RelationTarget[], wit: Witness): Keys[] => {
    const out: Keys[] = [];
    for (const target of targets) {
      if (target.hop !== "resolved" || !extractedAt(declaration, target.at, wit)) continue;
      const at = placeByProjectedKeys(union, declaration, target.at, wit);
      const value = project(at.node, wit).value as Record<string, any>;
      const kept = new Set<string | number>(["kind", "metadata"]);
      const places = target.reads({
        value,
        schema: input.schemaOf(value, declaration.manifest),
        shapeOf: (shape) => input.shapeOf(shape, wit),
        definition: input.definitionOf(value, declaration.manifest),
      });
      if (places.some((place) => place.keys.length === 0)) continue;
      for (const place of places) kept.add(place.keys[0]!);
      for (const member of Object.keys(at.node as Record<string, unknown>)) {
        if (!kept.has(member)) out.push([...at.unionKeys, member]);
      }
    }
    return out;
  };

  /** A relation site's key at the witness, in `variant`: its anchor's content,
   *  the places of its declaration it reads, the inputs its expressions read,
   *  what the annotations in force at its anchor read, the places its targets
   *  read in the declarations they reach (a named shape whole), what its
   *  dependent reads add, what its expressions were typed as and the step
   *  results it reads — where its reader asks for them; and the places it
   *  read, every one its reader may ask for. */
  const relationKeyAt = (site: RelationSite, wit: Witness, variant: number, dead?: DeadBranch, carving = true) => {
    const declaration = site.declaration;
    const module = (declaration.manifest.metadata as { module?: string } | undefined)?.module;
    const importPath = (declaration.manifest.metadata as { importPath?: string[] } | undefined)?.importPath;
    // Every region the key reads carves its own group's anchors nested beneath it.
    const carved = new Map<string, Keys>();
    // What an extracted declaration a target is read at holds beside the
    // places the target reads is the extraction's own: carved, restarting there.
    let restarted: Keys[] = [];
    const carvedUnder = (root: Keys): readonly Keys[] => {
      const found = carving
        ? [...nestedAnchors(site, root), ...restarted.filter((keys) => keys.length > root.length && isAtOrAbove(root, keys))]
        : [];
      for (const keys of found) carved.set(textOf(keys), keys);
      return found;
    };
    let anchorCarved = carvedUnder(site.unionKeys);
    const regionAt = () =>
      regionOf(
        { declaration, unionKeys: site.unionKeys, carved: new Set(anchorCarved.map((keys) => JSON.stringify(keys))) } as unknown as OwnSite,
        wit,
      );
    let region = regionAt();
    let declared = input.relationReads(site.group, declaration, site.unionKeys, wit, variant, anchorCarved);
    if (carving) {
      restarted = extractedRestarts(declaration, declared.targets ?? [], wit);
      if (restarted.length > 0) {
        anchorCarved = carvedUnder(site.unionKeys);
        region = regionAt();
        declared = input.relationReads(site.group, declaration, site.unionKeys, wit, variant, anchorCarved);
      }
    }
    const classes: ReadClass[] = [{ text: textOf(["anchor", region.value]), condition: region.taken }];
    const expressions = [...region.expressions];
    /** Union paths and written places of the anchor and every read place. */
    const read: { unionKeys: Keys; written: Keys }[] = [{ unionKeys: site.unionKeys, written: site.written }];
    /** Every place of the declaration read: declared, dependent, or reached
     *  by name through a target. */
    const places: Keys[] = [];
    const placeTexts = new Set<string>();
    const ownReads = { own: declaration, reads: [] as Keys[] };
    const readPlace = (keys: Keys): void => {
      const text = textOf(keys);
      if (placeTexts.has(text)) return;
      placeTexts.add(text);
      places.push(keys);
      const at = placeAt(declaration, keys, wit);
      if (!at.present) {
        classes.push({ text: textOf([at.keys, null]), condition: at.taken });
        return;
      }
      const place = placeByProjectedKeys(union, declaration, keys, wit);
      read.push({ unionKeys: place.unionKeys, written: place.written });
      const within = carvedUnder(place.unionKeys).map((inner) => inner.slice(place.unionKeys.length));
      const readValue = project(within.length > 0 ? union.carve(at.node, within, CARVED_PLACE) : at.node, wit);
      classes.push({ text: textOf([at.keys, readValue.value]), condition: space.and(at.taken, readValue.taken) });
      const collect = (value: unknown): void => {
        if (isTaggedSentinel(value)) {
          if (!isRefSentinel(value)) expressions.push({ engine: value.engine, source: value.source });
          return;
        }
        if (value === null || typeof value !== "object") return;
        for (const field of Array.isArray(value) ? value : Object.values(value)) collect(field);
      };
      collect(readValue.value);
    };
    // What each target it follows reaches, and the places it reads there.
    const follow = (target: RelationTarget): void => {
      if (target.hop === "resolved" && extractedAt(declaration, target.at, wit)) {
        const found = placeByProjectedKeys(union, declaration, target.at, wit);
        classes.push(...namedReadClasses([{ member: found.node as object, near: declaration, reads: target.reads, transitive: target.transitive }], wit, ownReads));
        return;
      }
      if (target.hop === "named") {
        classes.push(
          ...placeClasses(declaration, { kind: "reference", keys: target.at, transitive: target.transitive, reads: target.reads }, wit, ownReads),
        );
        return;
      }
      const ref = placeByProjectedKeys(union, declaration, target.at, wit);
      if (!ref.present) return;
      classes.push(...resolvedTargetClasses(declaration, project(ref.node, wit).value, ref.unionKeys, wit, target.reads, target.transitive, ownReads));
    };
    for (const keys of declared.places) readPlace(keys);
    for (const target of declared.targets ?? []) follow(target);
    // The functions its expressions call, read as a module call reads its callee.
    if (declared.calls && declared.calls.length > 0) {
      classes.push(...nameReadClasses(declared.calls.map((q) => q.slice(q.indexOf(".") + 1)), wit, callablePlaces, true).classes);
    }
    // What it reads depending on what its declared places hold, asked of
    // those places alone.
    let dependent = declared.dependent;
    while (dependent) {
      const answered = new Set(placeTexts);
      const more = dependent((keys) => {
        if (!answered.has(textOf(keys))) {
          throw new Error(`internal: the ${site.group} reader of ${site.id} read '${pathText(keys)}' for a dependent read, which it does not declare.`);
        }
        const at = placeAt(declaration, keys, wit);
        return at.present ? project(at.node, wit).value : undefined;
      });
      for (const keys of more.places) readPlace(keys);
      for (const target of more.targets ?? []) follow(target);
      dependent = more.dependent;
    }
    // A place of its own declaration a target reached by name.
    for (const keys of ownReads.reads) readPlace(keys);
    const reads: RelationReads = { ...declared, places };
    for (const { engine, source } of expressions) {
      for (const [head, second] of treeReads(engine, source, input.moduleNamesOf(declaration.manifest)).chains) {
        if (head !== "variables" && head !== "secrets" && head !== "resources") continue;
        const name = second === undefined || second === INDEX_SEGMENT ? undefined : second;
        classes.push(inputClass(module, importPath, head, name, wit));
      }
    }
    // What each expression in the anchor and its read places was typed as.
    if (reads.facts) {
      for (const u of unionSitesOf.get(declaration) ?? []) {
        if (!read.some((r) => isAtOrAbove(r.unionKeys, u.unionKeys))) continue;
        if ([...carved.values()].some((keys) => isAtOrAbove(keys, u.unionKeys))) continue;
        const found = factsClassAt(u.id, wit, variant, dead);
        if (found) classes.push(found);
      }
      for (const id of bodySitesOf.get(JSON.stringify([holderIdentity(declaration).kind, holderIdentity(declaration).name, holderIdentity(declaration).source])) ?? []) {
        const path = parseKeys((JSON.parse(id) as unknown[])[3] as string);
        if (!read.some((r) => isAtOrAbove(r.written, path))) continue;
        const found = factsClassAt(id, wit, variant, dead);
        if (found) classes.push(found);
      }
    }
    // The step results it reads.
    const roots: Keys[] = [];
    if (reads.steps && reads.steps.length > 0) {
      const found = stepReadClasses(declaration, reads.steps, wit, carvedUnder);
      classes.push(...found.classes);
      roots.push(...found.roots);
    }
    // What the schemas in force at the anchor reach and the annotations there read.
    const shapes = new Set<string>();
    const anchor = placeByUnionKeys(union, declaration, site.unionKeys, wit);
    // The members of the scopes declared on the way to the anchor, its read
    // places and the step objects it reads, as their identities — what a name
    // written there resolves to, and where extraction places what it draws
    // out — and what each object on the way to every region normalized holds
    // beside it.
    const normalizedRoots = new Map<string, Keys>();
    for (const keys of [site.unionKeys, ...read.slice(1).map((r) => r.unionKeys), ...roots]) normalizedRoots.set(textOf(keys), keys);
    const regionRoots = [...normalizedRoots.values()];
    classes.push(...scopeMembersClass(declaration, regionRoots, wit));
    for (const keys of scopesOnTheWay(declaration, regionRoots, wit)) {
      const scope = placeByProjectedKeys(union, declaration, keys, wit);
      if (scope.present) normalizedRoots.set(textOf(scope.unionKeys), scope.unionKeys);
    }
    for (const keys of normalizedRoots.values()) classes.push(enclosingClass(declaration, keys, wit));
    const skeleton = regionSkeleton(
      { kind: declaration.manifest.kind, metadata: declaration.manifest.metadata },
      [{ place: anchor, content: region.value }],
    );
    const nodes = nodesUnder(skeleton, anchor.at, declaration.manifest, shapes, wit);
    for (const { node } of nodes) {
      for (const [keyword, value] of Object.entries(node)) if (keyword.startsWith("x-telo-")) namesIn(value, shapes, false);
    }
    // A reference an annotation reads is read for its own content: what it
    // names is a read only where the reader declares it (`targets`), and the
    // door refuses any other.
    for (const place of regionAnnotationPlaces(nodes, skeleton, declaration.manifest)) {
      classes.push(
        ...placeClasses(declaration, place.kind === "reference" || place.kind === "tagged" ? { kind: "value", keys: place.keys } : place, wit),
      );
    }
    classes.push(...shapeClasses(shapes, wit));
    return { ...keyOf([site.id, variant], site.condition, classes), dead: region.dead, reads, roots, carved: [...carved.values()] };
  };

  for (const site of relationSites.values()) {
    const keys: OwnSolvedKey[] = [];
    ownSolved.set(site.id, keys);
    const pending: { key: OwnSolvedKey; witness: Witness; coverage: KeyCoverage; reads: RelationReads; roots: Keys[]; carved: Keys[] }[] = [];
    const rootPath = relationSitePath(site);
    if (space.and(site.condition, universe) !== FALSE) {
      const variants = site.declaration.manifest.kind === "Telo.Definition" ? input.variants : 1;
      for (let variant = 0; variant < variants; variant++) {
        let remaining = space.and(site.condition, universe);
        while (remaining !== FALSE) {
          const witness: Witness = { assignment: space.firstAssignment(remaining)! };
          const found = relationKeyAt(site, witness, variant);
          const condition = space.and(found.condition, universe);
          if (!space.holds(condition, witness.assignment)) {
            throw new Error(`internal: the key of relation site ${site.id} does not hold where it was read.`);
          }
          const known = keys.find((key) => !key.dead && key.variant === variant && key.text === found.text);
          if (known) known.condition = space.or(known.condition, condition);
          else {
            const key: OwnSolvedKey = { text: found.text, condition, variant, verdict: { diagnostics: [], origins: [] } };
            keys.push(key);
            pending.push({ key, witness, coverage: found.coverage, reads: found.reads, roots: found.roots, carved: found.carved });
          }
          remaining = space.and(remaining, space.not(condition));
        }
      }
    }
    // Each branch no configuration takes whose reach the site is in: one key,
    // at the witness its run reads.
    for (const branch of deadBranchesOf(site.declaration)) {
      const witness = deadWitness(branch);
      if (!taken(site.condition, rootPath, witness)) continue;
      const found = relationKeyAt(site, witness, 0, branch);
      if (!inReach(rootPath, found.dead, branch)) continue;
      const key: OwnSolvedKey = { text: found.text, condition: FALSE, variant: 0, verdict: { diagnostics: [], origins: [] }, dead: branch };
      keys.push(key);
      pending.push({ key, witness, coverage: found.coverage, reads: found.reads, roots: found.roots, carved: found.carved });
      let reach = relationReach.get(branch);
      if (!reach) relationReach.set(branch, (reach = new Set()));
      reach.add(site.id);
    }
    for (const { key, witness, coverage, reads, roots, carved } of pending) {
      reportPresence(
        "relation",
        site.id,
        site.declaration,
        site.unionKeys,
        witness,
        reads.places.length + (reads.steps?.length ?? 0),
        coverage,
        key,
      );
      key.verdict = {
        diagnostics: input.judgeRelationKey({
          site,
          key: key.text,
          witness,
          variant: key.variant,
          coverage,
          reads,
          roots,
          carved,
          celFactsAt: (id) => celFactsAt(id, witness, key.variant, key.dead, site.declaration),
        }),
        origins: [],
      };
    }
  }
  /** What a relation site holding at `witness` finds judged on its carved
   *  regions, and on the same regions whole. */
  const carveParityAt = (witness: Witness, variant: number) => {
    const out: string[] = [];
    const carvedBy = new Map<string, readonly Keys[]>();
    const dead = witness.forcing
      ? deadBranches.find((entry) => (witness.forcing as unknown as Map<object, unknown>).get(entry.sentinel) === entry.branch)
      : undefined;
    for (const site of relationSites.values()) {
      const path = relationSitePath(site);
      if (!taken(site.condition, path, witness)) continue;
      const siteVariant = relationVariant(site.id, variant);
      const judged = (carving: boolean) => {
        const found = relationKeyAt(site, witness, siteVariant, dead, carving);
        if (carving) carvedBy.set(site.id, found.carved);
        return input.judgeRelationKey({
          site,
          key: found.text,
          witness,
          variant: siteVariant,
          coverage: found.coverage,
          reads: found.reads,
          roots: found.roots,
          carved: found.carved,
          celFactsAt: (id) => celFactsAt(id, witness, siteVariant, dead, site.declaration),
        });
      };
      const carved = textOf(judged(true));
      const whole = textOf(judged(false));
      if (carved !== whole) out.push(`${site.id}: carved ${carved}, whole ${whole}`);
    }
    return { mismatches: out, carved: carvedBy };
  };
  /** Each CEL and own-check site holding at `witness`, judged in its key's
   *  environment and on its declarations whole there; and each CEL, own-check
   *  and relation site whose key reaches a declaration by name, judged with
   *  that declaration whole and with the parts its key holds. At a forced
   *  witness only the sites keyed inside the forced branch are compared. */
  const keyParityAt = (witness: Witness, variant: number) => {
    const out: string[] = [];
    const byName: string[] = [];
    /** Whether a key reaches a declaration by name as parts. */
    const holdsParts = (coverage: KeyCoverage) => coverage.parts.size > 0;
    const compared = { cel: 0, own: 0, views: 0 };
    const dead = witness.forcing
      ? deadBranches.find((entry) => (witness.forcing as unknown as Map<object, unknown>).get(entry.sentinel) === entry.branch)
      : undefined;
    const holding = <K extends { dead?: DeadBranch; variant: number; condition: Condition }>(keys: readonly K[], siteVariant: number) =>
      dead
        ? keys.find((key) => key.dead === dead)
        : keys.find((key) => !key.dead && key.variant === siteVariant && space.holds(key.condition, witness.assignment));
    // Each union site's keys, a forward view's among them, then each template
    // body site's. Sites of one declaration sharing a written place are judged
    // together whole, so their keys holding here are compared together, as
    // the place's merged verdict.
    const together = new Map<string, UnionSite[]>();
    for (const site of siteKeys.keys()) {
      const at = textOf([site.id, union.declarations.indexOf(site.declaration), union.views.indexOf(site.declaration as ConditionedView)]);
      together.set(at, [...(together.get(at) ?? []), site]);
    }
    const celKeys: [string, (readonly SolvedKey[])[], boolean][] = [
      ...[...together.values()].map((group): [string, (readonly SolvedKey[])[], boolean] => [
        group[0]!.id,
        group.map((site) => siteKeys.get(site)!),
        viewSites.has(group[0]!.declaration),
      ]),
      ...[...solved].filter(([id]) => body.has(id)).map(([id, keys]): [string, (readonly SolvedKey[])[], boolean] => [id, [keys], false]),
    ];
    for (const [id, groups, ofView] of celKeys) {
      const keys = groups.flatMap((list) => {
        const key = holding(list, body.has(id) ? variant : 0);
        return key && celRequests.has(key) ? [key] : [];
      });
      if (keys.length === 0) continue;
      if (ofView) compared.views++;
      const judged = (key: SolvedKey, whole: boolean) =>
        input.judgeKey({ site: id, key: key.text, ...celRequests.get(key)!, witness, variant: key.variant, whole });
      compared.cel++;
      // A position is its own door's: the two sides agree on the order a run
      // meets the facts, never on the doors placing them.
      const comparable = (verdict: CelSiteVerdict) =>
        textOf([verdict.diagnostics, verdict.facts.map((facts) => ({ ...facts, layout: undefined }))]);
      const keyed = comparable(mergedVerdict(keys.map((key) => judged(key, false))));
      for (const key of keys) {
        const whole = comparable(judged(key, true));
        if (keyed !== whole) out.push(`${id}: keyed ${keyed}, whole ${whole}`);
      }
      if (keys.some((key) => holdsParts(celRequests.get(key)!.coverage))) {
        const named = comparable(
          mergedVerdict(
            keys.map((key) =>
              input.judgeKey({ site: id, key: key.text, ...celRequests.get(key)!, witness, variant: key.variant, byNameWhole: true }),
            ),
          ),
        );
        if (keyed !== named) byName.push(`${id}: parts ${keyed}, whole ${named}`);
      }
    }
    for (const [id, keys] of ownSolved) {
      const first = keys[0] && ownRequests.get(keys[0]);
      const key = first && holding(keys, isDefinitionSite(first.site) ? variant : 0);
      const request = key && ownRequests.get(key);
      if (!key || !request) continue;
      const judged = (whole: boolean, byNameWhole = false) =>
        textOf(
          input.judgeOwnKey({
            ...request,
            key: key.text,
            witness,
            variant: key.variant,
            whole,
            byNameWhole,
          }).diagnostics,
        );
      compared.own++;
      const keyed = judged(false);
      const whole = judged(true);
      if (keyed !== whole) out.push(`${id}: keyed ${keyed}, whole ${whole}`);
      if (holdsParts(request.coverage)) {
        const named = judged(false, true);
        if (keyed !== named) byName.push(`${id}: parts ${keyed}, whole ${named}`);
      }
    }
    for (const site of relationSites.values()) {
      const path = relationSitePath(site);
      if (!taken(site.condition, path, witness)) continue;
      const siteVariant = relationVariant(site.id, variant);
      const found = relationKeyAt(site, witness, siteVariant, dead);
      if (!holdsParts(found.coverage)) continue;
      const judged = (byNameWhole: boolean) =>
        textOf(
          input.judgeRelationKey({
            site,
            key: found.text,
            witness,
            variant: siteVariant,
            coverage: found.coverage,
            reads: found.reads,
            roots: found.roots,
            carved: found.carved,
            celFactsAt: (id) => celFactsAt(id, witness, siteVariant, dead, site.declaration),
            byNameWhole,
          }),
        );
      const keyed = judged(false);
      const named = judged(true);
      if (keyed !== named) byName.push(`${site.id}: parts ${keyed}, whole ${named}`);
    }
    return { mismatches: out, byName, compared };
  };
  const viewRelationKeyOf = (marker: RelationMarker): string =>
    JSON.stringify([marker.group, marker.forwardedFrom, marker.kind, marker.name, marker.source]);
  const relationKeys = (id: string): readonly OwnSolvedKey[] => {
    if (!relationSites.has(id)) {
      throw new Error(`internal: the relation site ${id} of a configuration run is no anchor of the census.`);
    }
    return ownSolved.get(id) ?? [];
  };
  const relationVariant = (id: string, variant: number) =>
    relationSites.get(id)!.declaration.manifest.kind === "Telo.Definition" ? variant : 0;

  /** The findings `pick` chooses, of every site the declaration written at
   *  `origin` was found at, in site order. */
  const ownFindings = (origin: string, pick: (site: OwnSite, keys: readonly OwnSolvedKey[]) => OwnSolvedKey | undefined) => {
    if (!judgedOrigins.has(origin)) {
      throw new Error(`internal: the own checks of the declaration written at ${origin} were judged in no key.`);
    }
    const out: AnalysisDiagnostic[] = [];
    for (const site of ownByOrigin.get(origin) ?? []) {
      for (const d of pick(site, ownSolved.get(site.id) ?? [])?.verdict.diagnostics ?? []) {
        if ((d.data as { ownOrigin?: string }).ownOrigin === origin) out.push(d);
      }
    }
    return out;
  };
  const ownHolding = (site: OwnSite, keys: readonly OwnSolvedKey[], assignment: Assignment, variant: number) =>
    keys.find((key) => !key.dead && key.variant === (isDefinitionSite(site) ? variant : 0) && space.holds(key.condition, assignment));

  return {
    keys: solved,
    isBodySite: (site) => body.has(site),
    verdictAt: (site, assignment, variant) => {
      const keys = keysAt(site, assignment, body.has(site) ? variant : 0);
      if (keys.some((key) => key.wholeCare)) throw new Error(`internal: a whole-care key of CEL site ${site} answers a configuration run.`);
      return verdictOfKeys(keys);
    },
    verdictInDeadBranch: (id, sentinel, branch) => {
      const dead = deadBranchOf(sentinel, branch);
      const keys: SolvedKey[] = [];
      for (const site of sitesOfId.get(id) ?? []) {
        if (site.dead?.branch !== dead) continue;
        const key = siteKeys.get(site)?.find((k) => k.dead === dead);
        if (!key) throw new Error(`internal: the CEL site ${id} in the reach of a branch no configuration takes holds no key there.`);
        keys.push(key);
      }
      return verdictOfKeys(keys);
    },
    ownKeys: ownSolved,
    relationSites,
    observedAt: (witness: Witness) => observedClass(witness).covers?.observed === true,
    carveParityAt,
    keyParityAt,
    relationFindingsAt: (marker, assignment, variant) => {
      const holding = (id: string) =>
        relationKeys(id).find((k) => !k.dead && k.variant === relationVariant(id, variant) && space.holds(k.condition, assignment));
      if (marker.forwardedFrom !== undefined) {
        const held = viewRelationKeyOf(marker);
        return {
          claim: held,
          diagnostics: (viewRelationSites.get(held) ?? []).flatMap((site) => {
            const key = holding(site.id);
            return key && taken(site.condition, relationSitePath(site), { assignment })
              ? key.verdict.diagnostics
              : [];
          }),
        };
      }
      const id = relationSiteId(marker.group, marker.kind, marker.name, marker.source, marker.path);
      const key = holding(id);
      if (!key) throw new Error(`internal: the relation site ${id} holds no key in ${assignmentKey(assignment)}.`);
      return { diagnostics: key.verdict.diagnostics };
    },
    relationFindingsInDeadBranch: (marker, sentinel, branch) => {
      const dead = deadBranchOf(sentinel, branch);
      const found = (id: string): readonly AnalysisDiagnostic[] => {
        if (!relationReach.get(dead)?.has(id)) return [];
        const key = relationKeys(id).find((k) => k.dead === dead);
        if (!key) throw new Error(`internal: the relation site ${id} in the reach of a branch no configuration takes holds no key there.`);
        return key.verdict.diagnostics;
      };
      if (marker.forwardedFrom !== undefined) {
        const held = viewRelationKeyOf(marker);
        return { claim: held, diagnostics: (viewRelationSites.get(held) ?? []).flatMap((site) => found(site.id)) };
      }
      return { diagnostics: found(relationSiteId(marker.group, marker.kind, marker.name, marker.source, marker.path)) };
    },
    ownFindingsAt: (origin, assignment, variant) =>
      ownFindings(origin, (site, keys) => ownHolding(site, keys, assignment, variant)),
    ownFindingsInDeadBranch: (origin, sentinel, branch) => {
      const dead = deadBranchOf(sentinel, branch);
      const out: AnalysisDiagnostic[] = [];
      for (const id of ownReach.get(dead) ?? []) {
        const key = ownSolved.get(id)?.find((k) => k.dead === dead);
        if (!key) throw new Error(`internal: the own-check site ${id} in the reach of a branch no configuration takes holds no key there.`);
        for (const d of key.verdict.diagnostics) if ((d.data as { ownOrigin?: string }).ownOrigin === origin) out.push(d);
      }
      return out;
    },
  };
}

/** What tells a view's sites from every other view's: its name, and where two
 *  views of the union share one (under disjoint conditions), its place among
 *  them. */
export function viewSiteNameOf(union: ConditionedExpansion, view: ConditionedView): string {
  const name = String(view.manifest.metadata?.name);
  const shared = union.views.filter((other) => String(other.manifest.metadata?.name) === name).length;
  return shared === 1 ? name : `${name}@${union.views.indexOf(view)}`;
}

/** What tells a view's anchors apart: where each stands in the union, and —
 *  where one place holds different content under different options — the
 *  options it is taken under. */
export function viewAnchorText(place: { readonly unionKeys: Keys; readonly options: readonly AlternativeOption[] }): string {
  return `${pathText(place.unionKeys)}${place.options.length === 0 ? "" : `#${place.options.map((option) => String(option.condition)).join(",")}`}`;
}

/** The declarations some configuration holds. */
function liveDeclarations(union: ConditionedExpansion): readonly ConditionedDeclaration[] {
  return union.declarations.filter((declaration) => !declaration.unreachable);
}


/** Whether a site's verdict may turn on whether any declaration reports
 *  observed state: a site typed through the observed-state context — a kind
 *  document's, or a module document's `imports:` entry's — and one reading
 *  observed state, which a startup field refuses only then. */
function readsObservedStateGate(
  declaration: ResourceManifest,
  keys: Keys,
  chains: readonly (readonly string[])[],
): boolean {
  if (isKindDocument(declaration)) return true;
  if (isModuleKind(declaration.kind as string | undefined) && keys[0] === "imports") return true;
  return chains.some((chain) => observedStateRead(chain) !== undefined);
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let node = root;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function valueAt(root: unknown, keys: ReadKeys): unknown {
  let node = root;
  for (const key of keys) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key as string];
  }
  return node;
}
