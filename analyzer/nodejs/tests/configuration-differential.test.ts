import { join } from "node:path";
import { expansionTagLabel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { observeAnalysisReadings, StaticAnalyzer } from "../src/analyzer.js";
import { observeKeyCosts } from "../src/cel-site-judgements.js";
import { agreesWith, assignmentKey, describeConfigurations, type Assignment, type Dimension } from "../src/configuration-dimensions.js";
import { pathOf } from "../src/choice-reading.js";
import { relocatePath, type ChoiceExpansion } from "../src/choice-expansion.js";
import {
  isAlternatives,
  takenAt,
  type ChoiceStep,
  type ConditionedExpansion,
  type ConditionedView,
  type Forcing,
  type PlaceMap,
  type Projected,
  type Witness,
} from "../src/conditioned-expansion.js";
import type { Condition } from "../src/presence-condition.js";
import { relocatedRendering } from "../src/quoted-place.js";
import { parseKeys, pathText } from "../src/template-expansion.js";
import type { AnalysisDiagnostic } from "../src/types.js";
import {
  careIdentity,
  careIdentityNested,
  deadReaders,
  flagSequence,
  flagTargets,
  forwardedSequence,
  forwardedSequenceNested,
  generatedCorpus,
  liftedForwardViews,
  loadGenerated,
  mergedPlaceViews,
  NESTED_PREFIX,
  nestedConsumers,
  nestedDeadBranch,
  nestedForwardViews,
  type NestedForm,
  scopeMemberCrossing,
  scopeMemberOnwardCrossing,
  scopeMemberMisspelled,
  scopePadding,
  topLevelCrossing,
  derivedResultTarget,
  nameReadPadding,
  rulePadding,
  catalogSetPadding,
  zonePadding,
  valueSchemaCrossing,
  referentPadding,
  referentPaddingFlaggedOutput,
  relationPadding,
  derivedEntryChoice,
  derivedEntrySibling,
  dispatchDerivedInput,
  valueSchemaCrossingFit,
  matchShapeChoice,
  kindDocumentReferentChoice,
  viewOnlyStatus,
  shiftedConsumerName,
  drawnOutOrder,
  nestedInlinePlaces,
  SWEPT_CHOICES,
} from "./configuration-cost-fixtures.js";
import { fileCorpus, loadFile, ROOT } from "./configuration-corpus.js";

/**
 * The oracle every step of the move to one analysis over every configuration
 * is held to. For each fixture and each configuration c:
 *  - the union of every configuration's expansion, kept where each element's
 *    condition holds at c, is c's own expansion;
 *  - the union's forward views holding at c, projected there, are the views
 *    the one view builder makes over c's own expansion — by consumer, content
 *    and where each place of each is reported;
 *  - what the whole analysis finds holding at c is what the analysis narrowed
 *    to c (`within: c`) finds — by code, place and message, the label naming
 *    the input configurations aside. A finding holding in no configuration
 *    (`data.configurations: []`) belongs to none;
 *  - the findings of the whole-application passes (duplicate names, unused
 *    declarations, unattached sinks, a required `status:`) holding at c are
 *    what the plain analysis of c's choice-free expansion finds;
 *  - for each branch no configuration takes, what the whole analysis finds in
 *    no configuration inside it is what an analysis of the expansion taking it
 *    — at a configuration reaching its choice — finds there.
 */

type Loaded = Awaited<ReturnType<typeof loadFile>>;

/** A choice at a declaration position holds its name in every configuration,
 *  whichever branch is taken, so a collision with one has no counterpart in a
 *  choice-free expansion. */
const inPassOracle = (d: AnalysisDiagnostic): boolean =>
  UNION_PASS_CODES.has(d.code as string) && !(d.code === "DUPLICATE_RESOURCE_NAME" && d.message.includes(" chooses declared earlier"));

/** What the passes over the whole application report. */
const UNION_PASS_CODES: ReadonlySet<string> = new Set([
  "DUPLICATE_RESOURCE_NAME",
  "UNUSED_DECLARATION",
  "SINK_UNATTACHED",
  "OBSERVED_STATE_REQUIRED_FORBIDDEN",
]);

const NESTED_FORMS: readonly NestedForm[] = ["inline", "with"];

/** The configurations a finding holds in: every one, or the entries the merge
 *  wrote (a definition finding's own entries name no dimension of the set). */
function holdsAt(d: AnalysisDiagnostic, c: Assignment, dimensions: readonly Dimension[]): boolean | "nowhere" {
  const entries = (d.data as { configurations?: Assignment[] } | undefined)?.configurations;
  if (!entries) return true;
  if (entries.length === 0) return "nowhere";
  const keys = new Set(dimensions.map((x) => x.key));
  if (!entries.every((e) => Object.keys(e).every((k) => keys.has(k)))) return true;
  return entries.some((e) => agreesWith(e, c));
}

function identityOf(d: AnalysisDiagnostic, message: string): string {
  const data = d.data as
    | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
    | undefined;
  return JSON.stringify([d.code, d.severity, data?.resource?.kind, data?.resource?.name, data?.filePath, data?.path, d.range ?? null, message]);
}

/** The message with the label naming input configurations removed. */
function unlabelled(d: AnalysisDiagnostic, configurations: readonly Assignment[], dimensions: readonly Dimension[]): string {
  const entries = (d.data as { configurations?: Assignment[] } | undefined)?.configurations;
  const keys = new Set(dimensions.map((x) => x.key));
  if (!entries || entries.length === 0 || !entries.every((e) => Object.keys(e).every((k) => keys.has(k)))) {
    return d.message;
  }
  const denoted = configurations.filter((c) => entries.some((e) => agreesWith(e, c)));
  const label = ` ${describeConfigurations(denoted, configurations, dimensions)}`;
  return d.message.endsWith(label) ? d.message.slice(0, -label.length) : d.message;
}

/** Every place of `value`, each as written. */
function placesOf(value: unknown, at: (string | number)[] = [], out: string[] = []): string[] {
  out.push(pathText(at));
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) placesOf(child, [...at, Array.isArray(value) ? Number(key) : key], out);
  }
  return out;
}

/** Where `path` of a view is reported through `places`: undefined where no
 *  forward moves it, so nothing is reported there. */
function reportedAt(places: PlaceMap, path: string): string | undefined {
  const keys = parseKeys(path);
  const moved = places.mappings.some(
    (m) => m.from.length <= keys.length && m.from.every((key, i) => String(key) === String(keys[i])),
  );
  return moved ? relocatePath(path, places.mappings) : undefined;
}

/** A forward view as a configuration reports it: its consumer — by identity,
 *  where it is written for one written beneath a declaration — its content, and where each of its places is reported,
 *  written. The view's own name, which nothing reports, is its consumer's. */
function viewRecord(
  consumer: { identity: unknown },
  projected: Projected,
  written: (path: string) => { resource: unknown; path: string },
): string {
  const places: Record<string, unknown> = {};
  for (const path of placesOf(projected.value)) {
    const at = reportedAt(projected.places, path);
    places[path] = at === undefined ? null : written(at);
  }
  const { metadata, ...content } = projected.value as { metadata?: Record<string, unknown> };
  const meta = { ...metadata };
  delete meta.name;
  return JSON.stringify([consumer.identity, { ...content, metadata: meta }, places], (key, v) =>
    typeof v === "bigint" ? `${v}n` : v,
  );
}

/** A lifted view's consumer: a top-level declaration by its own identity, one
 *  written beneath a declaration by where it is written there. */
function liftedConsumer(union: ConditionedExpansion, view: ConditionedView) {
  const consumer = view.consumer;
  const meta = consumer.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
  return {
    identity: consumer.declaredIn
      ? reportedIn(union, view)(pathText(consumer.at))
      : [consumer.manifest.kind, meta?.name, meta?.source],
  };
}

/** A view of a configuration's own expansion's consumer, as {@link liftedConsumer}. */
function runConsumer(expansion: ChoiceExpansion, view: ConditionedView) {
  const consumer = view.consumer;
  const meta = consumer.manifest.metadata as { name?: unknown; source?: unknown } | undefined;
  return {
    identity: consumer.declaredIn
      ? writtenIn(expansion, consumer.declaredIn.manifest)(pathText(consumer.at))
      : [consumer.manifest.kind, meta?.name, meta?.source],
  };
}

async function projects(loaded: Loaded): Promise<void> {
  const options = { moduleDocuments: loaded.moduleDocuments };
  const { configurations, union, unreachable, expansionAt, expansionOf, viewsAt } =
    new StaticAnalyzer().configurationsOf(loaded.manifests, options);
  for (const c of configurations) {
    expect(union.at(c), assignmentKey(c)).toEqual(expansionAt(c));
    // Every projected declaration's place map is the expansion's relocation.
    const expansion = expansionOf(c);
    // The expansion keys a relocation by kind, name and file, so a name declared
    // twice there (a duplicate) is compared nowhere.
    const projections = union.declarations
      .filter((declaration) => union.space.holds(declaration.condition, c))
      .map((declaration) => ({ declaration, projected: union.project(declaration.manifest, c) }));
    const identity = (value: unknown) => {
      const m = value as { kind?: unknown; metadata?: { name?: unknown; source?: unknown } };
      return JSON.stringify([m.kind, m.metadata?.name, m.metadata?.source]);
    };
    const seen = new Map<string, number>();
    for (const { projected } of projections) seen.set(identity(projected.value), (seen.get(identity(projected.value)) ?? 0) + 1);
    for (const { declaration, projected } of projections) {
      if (seen.get(identity(projected.value))! > 1) continue;
      expect(
        JSON.stringify(projected.places.mappings.length > 0 ? projected.places : null),
        `${assignmentKey(c)} ${String(declaration.manifest.metadata?.name)}`,
      ).toEqual(expansion.relocationOf(projected.value as { kind?: unknown; metadata?: unknown }));
    }
    // The union's views holding at c are the views of c's own expansion.
    const lifted = union.views
      .filter((view) => union.space.holds(view.condition, c))
      .map((view) => viewRecord(liftedConsumer(union, view), union.project(view.manifest, c), reportedIn(union, view)))
      .sort();
    const concrete = viewsAt(c)
      .map(({ view, projected }) =>
        viewRecord(runConsumer(expansion, view), projected, writtenIn(expansion, (view.consumer.declaredIn ?? view.consumer).manifest)),
      )
      .sort();
    expect(lifted, `views at ${assignmentKey(c)}`).toEqual(concrete);
  }
  // A branch no configuration takes, forced at a configuration reaching its
  // choice, projects as that configuration's expansion with the branch taken.
  for (const entry of unreachable) {
    const forcing = new Map([[entry.site.sentinel, entry.branch]]);
    expect(union.at(entry.baseline, forcing), `${entry.branch} at ${assignmentKey(entry.baseline)}`).toEqual(
      expansionOf(entry.baseline, forcing).manifests,
    );
    // And so do its views.
    const expansion = expansionOf(entry.baseline, forcing);
    const witness: Witness = { assignment: entry.baseline, forcing: forcing as unknown as Forcing };
    const lifted = union.views
      .filter((view) => takenAt(union.space, view.condition, view.path, entry.baseline, forcing as unknown as Forcing))
      .map((view) =>
        viewRecord(
          liftedConsumer(union, view),
          union.project(view.manifest, entry.baseline, forcing as unknown as Forcing),
          reportedIn(union, view),
        ),
      )
      .sort();
    const concrete = viewsAt(entry.baseline, forcing)
      .map(({ view, projected }) =>
        viewRecord(runConsumer(expansion, view), projected, writtenIn(expansion, (view.consumer.declaredIn ?? view.consumer).manifest)),
      )
      .sort();
    expect(lifted, `views of ${entry.branch} at ${assignmentKey(entry.baseline)}`).toEqual(concrete);
  }
}

/** Where a lifted view's places are reported: at the declaration of the union
 *  its consumer is, or is written in, as it is written. */
function reportedIn(union: ConditionedExpansion, view: ConditionedView) {
  const declaration = (view.consumer.declaredIn ?? view.consumer).manifest;
  const place = union.placeOf(declaration);
  const meta = declaration.metadata as { name?: unknown } | undefined;
  return (path: string) => ({ resource: place.resource ?? { kind: declaration.kind, name: meta?.name }, path });
}

/** Where a place of `consumer`, in a configuration's own expansion, is
 *  written. */
function writtenIn(expansion: ChoiceExpansion, consumer: { kind?: unknown; metadata?: unknown }) {
  const meta = consumer.metadata as { name?: unknown; source?: unknown } | undefined;
  return (path: string) => {
    const [moved] = expansion.relocate([
      {
        severity: 1,
        code: "PROBE",
        source: "test",
        message: "",
        data: { resource: { kind: consumer.kind, name: meta?.name }, filePath: meta?.source, path },
      } as AnalysisDiagnostic,
    ]);
    const data = moved!.data as { resource?: unknown; path?: unknown };
    return { resource: data.resource, path: String(data.path) };
  };
}

/** What an analysis judged: how many keys a kept configuration holds at each
 *  site — by family, site, declaration, union place and template variant —
 *  the keys judged for the whole space where a branch no configuration takes
 *  reads a site outside its reach, every key read at a witness forcing such a
 *  branch, and, for the keys a kept configuration holds, the declarations
 *  present that those configurations vary, and those normalized. */
interface KeysJudged {
  readonly live: ReadonlyMap<string, number>;
  readonly wholeCare: readonly string[];
  readonly forcedReads: readonly { readonly site: string; readonly text: string; readonly role: string }[];
  readonly varyingHeld: number;
  readonly varyingNormalized: number;
}

function keysJudged<T>(run: () => T): { result: T; keys: KeysJudged } {
  const live = new Map<string, number>();
  const wholeCare: string[] = [];
  const forcedReads: { site: string; text: string; role: string }[] = [];
  let varyingHeld = 0;
  let varyingNormalized = 0;
  const declarations = new Map<object, number>();
  const stop = observeKeyCosts((cost) => {
    if (cost.kind === "key-presence") {
      if (cost.role === "whole-care") wholeCare.push(`${cost.family} ${cost.site}`);
      if (cost.role !== "live") return;
      if (!declarations.has(cost.declaration)) declarations.set(cost.declaration, declarations.size);
      const at = JSON.stringify([cost.family, cost.site, declarations.get(cost.declaration), cost.unionKeys ?? null, cost.variant]);
      live.set(at, (live.get(at) ?? 0) + 1);
    } else if (cost.kind === "forced-read") forcedReads.push({ site: cost.site, text: cost.text, role: cost.role });
    else if (cost.kind === "varying" && cost.live) varyingHeld += cost.declarations;
    else if (cost.kind === "normalization" && cost.live && !cost.invariant) varyingNormalized++;
  });
  try {
    return { result: run(), keys: { live, wholeCare, forcedReads, varyingHeld, varyingNormalized } };
  } finally {
    stop();
  }
}

/** A branch no configuration takes never reads a key judged for the
 *  configurations kept, and judges at most one whole-care key per site and
 *  key text it reads outside its reach. */
function expectForcedReads(keys: KeysJudged, label: string): void {
  expect(keys.forcedReads.filter((read) => read.role === "live").map((read) => read.site), `live keys read at a forced witness, ${label}`).toEqual([]);
  const read = new Set(keys.forcedReads.filter((r) => r.role === "whole-care").map((r) => JSON.stringify([r.site, r.text])));
  expect(keys.wholeCare.length, `whole-care keys, ${label}`).toBeLessThanOrEqual(read.size);
}

/** Narrowed to one configuration, an analysis judges every site it keeps
 *  once, and its doors hold no declaration varying and normalize none: nothing
 *  varies there. */
function expectPlain(keys: KeysJudged, label: string): void {
  expect([...keys.live].filter(([, n]) => n !== 1), `sites keyed more than once, ${label}`).toEqual([]);
  expect(keys.varyingHeld, `varying declarations held, ${label}`).toBe(0);
  expect(keys.varyingNormalized, `varying declarations normalized, ${label}`).toBe(0);
}

async function judge(loaded: Loaded): Promise<void> {
  const options = { moduleDocuments: loaded.moduleDocuments };
  const { dimensions, configurations, unreachable, expansionOf } = new StaticAnalyzer().configurationsOf(
    loaded.manifests,
    options,
  );
  const analysed = keysJudged(() => new StaticAnalyzer().analyze(loaded.manifests, options));
  const whole = analysed.result;
  expectForcedReads(analysed.keys, "whole");
  const live = [...analysed.keys.live.values()].reduce((n, keys) => n + keys, 0);
  console.log(`whole analysis: ${live} live keys, ${analysed.keys.wholeCare.length} whole-care keys`);
  const nowhere = (diagnostics: readonly AnalysisDiagnostic[]) =>
    diagnostics.filter((d) => holdsAt(d, {}, dimensions) === "nowhere").map((d) => identityOf(d, d.message)).sort();
  for (const c of configurations) {
    const expected = whole
      .filter((d) => holdsAt(d, c, dimensions) === true)
      .map((d) => identityOf(d, unlabelled(d, configurations, dimensions)))
      .sort();
    const { result: narrowed, keys } = keysJudged(() =>
      new StaticAnalyzer().analyze(loaded.manifests, { ...options, within: c }),
    );
    expectPlain(keys, `within ${assignmentKey(c)}`);
    expectForcedReads(keys, `within ${assignmentKey(c)}`);
    const actual = narrowed
      .filter((d) => holdsAt(d, c, dimensions) !== "nowhere")
      .map((d) => identityOf(d, d.message))
      .sort();
    expect(actual, assignmentKey(c)).toEqual(expected);
    // A whole-application pass applies its own rule to the union, which the
    // narrowing above runs again: its findings at c are also what the plain
    // analysis of c's choice-free expansion finds. An input is read as written,
    // a choice's own condition included, which the expansion no longer holds:
    // an unused input there may be read by a choice, never the reverse.
    const expansion = expansionOf(c);
    const plain = relocatedRendering(new StaticAnalyzer().analyze(expansion.manifests, options), (found) =>
      expansion.relocate(found),
    )
      .filter(inPassOracle)
      .map((d) => [d.code, identityOf(d, d.message)] as const);
    const passes = whole
      .filter((d) => inPassOracle(d) && holdsAt(d, c, dimensions) === true)
      .map((d) => [d.code, identityOf(d, unlabelled(d, configurations, dimensions))] as const);
    const keep = (found: typeof plain, unused: boolean) =>
      found.filter(([code]) => (code === "UNUSED_DECLARATION") === unused).map(([, identity]) => identity).sort();
    expect(keep(passes, false), `whole-application passes at ${assignmentKey(c)}`).toEqual(keep(plain, false));
    for (const identity of keep(passes, true)) {
      expect(keep(plain, true), `unused input at ${assignmentKey(c)}`).toContain(identity);
    }
    // What holds in no configuration at all is reported whatever `within` keeps.
    expect(nowhere(narrowed), `in no configuration, within ${assignmentKey(c)}`).toEqual(nowhere(whole));
  }
  // What the whole analysis finds inside a branch no configuration takes is
  // what an analysis of the expansion taking it finds there, at a configuration
  // reaching its choice.
  for (const entry of unreachable) {
    const holder = entry.site.holder;
    const meta = holder.metadata as { name?: unknown; source?: unknown } | undefined;
    const kind = holder.kind ?? expansionTagLabel(holder);
    const at = pathOf(entry.keys);
    const inside = (d: AnalysisDiagnostic) => {
      const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
      return (
        data?.resource?.kind === kind &&
        data.resource.name === meta?.name &&
        data.filePath === meta?.source &&
        typeof data.path === "string" &&
        (data.path === at || data.path.startsWith(`${at}.`) || data.path.startsWith(`${at}[`))
      );
    };
    const expansion = expansionOf(entry.baseline, new Map([[entry.site.sentinel, entry.branch]]));
    // Placed as production places a configuration's findings: a message
    // quoting its place rendered from where the finding now stands.
    const expected = relocatedRendering(new StaticAnalyzer().analyze(expansion.manifests, options), (found) =>
      expansion.relocate(found),
    )
      .filter(inside)
      .map((d) => identityOf(d, d.message))
      .sort();
    const label = ` ${describeConfigurations([], configurations, dimensions)}`;
    const actual = whole
      .filter((d) => holdsAt(d, {}, dimensions) === "nowhere" && inside(d))
      .map((d) => identityOf(d, d.message.endsWith(label) ? d.message.slice(0, -label.length) : d.message))
      .sort();
    expect(actual, `${entry.branch} at ${assignmentKey(entry.baseline)}`).toEqual(expected);
  }
}

describe("each fixture projects as its configurations", () => {
  for (const file of fileCorpus()) {
    it(file, async () => projects(await loadFile(join(ROOT, file))), 120_000);
  }
  for (const [name, text] of generatedCorpus(SWEPT_CHOICES)) {
    it(`generated ${name}`, async () => projects(await loadGenerated(name, text)), 120_000);
  }
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    const name = `forwarded-sequence-${n}.yaml`;
    it(`generated ${name}`, async () => projects(await loadGenerated(name, forwardedSequence(n))), 120_000);
  }
  for (const form of NESTED_FORMS) {
    for (let n = 1; n <= 3; n++) {
      const name = `forwarded-sequence-${form}-${n}.yaml`;
      it(`generated ${name}`, async () => projects(await loadGenerated(name, forwardedSequenceNested(n, form))), 120_000);
    }
  }
  it("generated lifted-forward-views.yaml", async () =>
    projects(await loadGenerated("lifted-forward-views.yaml", liftedForwardViews())), 120_000);
  it("generated nested-forward-views.yaml", async () =>
    projects(await loadGenerated("nested-forward-views.yaml", nestedForwardViews())), 120_000);
  it("generated merged-place-views.yaml", async () =>
    projects(await loadGenerated("merged-place-views.yaml", mergedPlaceViews())), 120_000);
  it("generated nested-consumers.yaml", async () =>
    projects(await loadGenerated("nested-consumers.yaml", nestedConsumers())), 120_000);
  it("generated care-identity-nested.yaml", async () =>
    projects(await loadGenerated("care-identity-nested.yaml", careIdentityNested())), 120_000);
  for (const shadowed of [false, true]) {
    const name = `scope-member-crossing${shadowed ? "-shadowed" : ""}.yaml`;
    it(`generated ${name}`, async () => projects(await loadGenerated(name, scopeMemberCrossing(shadowed))), 120_000);
  }
  it("generated top-level-crossing.yaml", async () =>
    projects(await loadGenerated("top-level-crossing.yaml", topLevelCrossing())), 120_000);
  for (const topLevel of [false, true]) {
    const name = `scope-member-onward-crossing${topLevel ? "-top-level" : ""}.yaml`;
    it(`generated ${name}`, async () => projects(await loadGenerated(name, scopeMemberOnwardCrossing(topLevel))), 120_000);
  }
  it("generated view-only-status.yaml", async () =>
    projects(await loadGenerated("view-only-status.yaml", viewOnlyStatus())), 120_000);
  it("generated shifted-consumer-name.yaml", async () =>
    projects(await loadGenerated("shifted-consumer-name.yaml", shiftedConsumerName())), 120_000);
  it("generated drawn-out-order.yaml", async () =>
    projects(await loadGenerated("drawn-out-order.yaml", drawnOutOrder())), 120_000);
  for (const [lead, named] of [[false, false], [true, false], [false, true]] as const) {
    const name = `nested-inline-places${lead ? "-lead" : ""}${named ? "-named" : ""}.yaml`;
    it(`generated ${name}`, async () => projects(await loadGenerated(name, nestedInlinePlaces(lead, named))), 120_000);
  }
});

describe("each configuration's findings equal its own analysis", () => {
  for (const file of fileCorpus()) {
    it(file, async () => judge(await loadFile(join(ROOT, file))), 120_000);
  }
  for (const [name, text] of generatedCorpus(SWEPT_CHOICES)) {
    it(`generated ${name}`, async () => judge(await loadGenerated(name, text)), 120_000);
  }
  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    const name = `forwarded-sequence-${n}.yaml`;
    it(`generated ${name}`, async () => judge(await loadGenerated(name, forwardedSequence(n))), 120_000);
  }
  for (const form of NESTED_FORMS) {
    for (let n = 1; n <= 3; n++) {
      const name = `forwarded-sequence-${form}-${n}.yaml`;
      it(`generated ${name}`, async () => judge(await loadGenerated(name, forwardedSequenceNested(n, form))), 120_000);
    }
  }
  it("generated nested-forward-views.yaml", async () =>
    judge(await loadGenerated("nested-forward-views.yaml", nestedForwardViews())), 120_000);
  it("generated merged-place-views.yaml", async () =>
    judge(await loadGenerated("merged-place-views.yaml", mergedPlaceViews())), 120_000);
  it("generated nested-consumers.yaml", async () =>
    judge(await loadGenerated("nested-consumers.yaml", nestedConsumers())), 120_000);
  it("generated care-identity-nested.yaml", async () =>
    judge(await loadGenerated("care-identity-nested.yaml", careIdentityNested())), 120_000);
  for (const shadowed of [false, true]) {
    const name = `scope-member-crossing${shadowed ? "-shadowed" : ""}.yaml`;
    it(`generated ${name}`, async () => judge(await loadGenerated(name, scopeMemberCrossing(shadowed))), 120_000);
  }
  it("generated top-level-crossing.yaml", async () =>
    judge(await loadGenerated("top-level-crossing.yaml", topLevelCrossing())), 120_000);
  for (const topLevel of [false, true]) {
    const name = `scope-member-onward-crossing${topLevel ? "-top-level" : ""}.yaml`;
    it(`generated ${name}`, async () => judge(await loadGenerated(name, scopeMemberOnwardCrossing(topLevel))), 120_000);
  }
  it("generated scope-padding.yaml", async () => judge(await loadGenerated("scope-padding.yaml", scopePadding(2))), 120_000);
  it("generated scope-member-misspelled.yaml", async () =>
    judge(await loadGenerated("scope-member-misspelled.yaml", scopeMemberMisspelled())), 120_000);
  it("generated derived-result-target.yaml", async () =>
    judge(await loadGenerated("derived-result-target.yaml", derivedResultTarget())), 120_000);
  it("generated name-read-padding.yaml", async () =>
    judge(await loadGenerated("name-read-padding.yaml", nameReadPadding(0))), 120_000);
  for (const [name, fixture] of [
    ["rule-padding.yaml", rulePadding],
    ["catalog-set-padding.yaml", catalogSetPadding],
    ["zone-padding.yaml", zonePadding],
    ["value-schema-crossing.yaml", valueSchemaCrossing],
    ["referent-padding.yaml", referentPadding],
    ["referent-padding-flagged-output.yaml", referentPaddingFlaggedOutput],
    ["relation-padding.yaml", relationPadding],
  ] as const) {
    it(`generated ${name}`, async () => judge(await loadGenerated(name, fixture(0))), 120_000);
  }
  for (const [name, fixture] of [
    ["derived-entry-choice.yaml", derivedEntryChoice],
    ["derived-entry-sibling.yaml", derivedEntrySibling],
    ["dispatch-derived-input.yaml", dispatchDerivedInput],
    ["value-schema-crossing-fit.yaml", valueSchemaCrossingFit],
    ["match-shape-choice.yaml", matchShapeChoice],
    ["kind-document-referent-choice.yaml", kindDocumentReferentChoice],
  ] as const) {
    it(`generated ${name}`, async () => judge(await loadGenerated(name, fixture())), 120_000);
  }
  it("generated view-only-status.yaml", async () =>
    judge(await loadGenerated("view-only-status.yaml", viewOnlyStatus())), 120_000);
  it("generated shifted-consumer-name.yaml", async () =>
    judge(await loadGenerated("shifted-consumer-name.yaml", shiftedConsumerName())), 120_000);
  it("generated drawn-out-order.yaml", async () =>
    judge(await loadGenerated("drawn-out-order.yaml", drawnOutOrder())), 120_000);
  for (const [lead, named] of [[false, false], [true, false], [false, true]] as const) {
    const name = `nested-inline-places${lead ? "-lead" : ""}${named ? "-named" : ""}.yaml`;
    it(`generated ${name}`, async () => judge(await loadGenerated(name, nestedInlinePlaces(lead, named))), 120_000);
  }
});

describe("a forwarded finding", () => {
  /** Every finding under `steps`: its code, place, configurations, and its
   *  message after the resource it names — a forwarded one's after the
   *  sentence saying where it is forwarded. */
  const stepFindings = async (name: string, text: string): Promise<string[]> => {
    const loaded = await loadGenerated(name, text);
    return new StaticAnalyzer()
      .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments })
      .filter((d) => /^steps[.[]/.test(String((d.data as { path?: unknown }).path)))
      .map((d) => {
        const data = d.data as { path?: unknown; configurations?: unknown };
        const message = d.message.replace(/^[^:]+: (?:'[^']*' is forwarded into .*?, which checks it as its own field — )?/, "");
        return JSON.stringify([d.code, data.path, data.configurations ?? null, message]);
      })
      .sort();
  };

  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    it(`carries the condition it holds under as written in place, ${n} flags`, async () => {
      const forwarded = await stepFindings(`forwarded-sequence-${n}.yaml`, forwardedSequence(n));
      expect(forwarded).toEqual(await stepFindings(`flag-sequence-${n}.yaml`, flagSequence(n)));
    }, 120_000);
  }

  /** The findings under a consumer's `steps`, each path read from the
   *  consumer, its message without the consumer's own label. */
  const consumerStepFindings = (found: readonly AnalysisDiagnostic[], prefix: string): string[] =>
    found
      .filter((d) => String((d.data as { path?: unknown }).path).startsWith(`${prefix}steps`))
      .map((d) => {
        const data = d.data as { path?: unknown; configurations?: unknown };
        return JSON.stringify([d.code, String(data.path).slice(prefix.length), data.configurations ?? null, d.message.replace(/^[^:]+: /, "")]);
      })
      .sort();

  for (let n = 1; n <= SWEPT_CHOICES; n++) {
    it(`is the same written beneath a declaration as at the top level, ${n} flags`, async () => {
      const analyzed = async (name: string, text: string) => {
        const loaded = await loadGenerated(name, text);
        return new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments });
      };
      const top = consumerStepFindings(await analyzed(`forwarded-sequence-${n}.yaml`, forwardedSequence(n)), "");
      // One flag decides no step's type: nothing is found there.
      if (n > 1) expect(top.length).toBeGreaterThan(0);
      for (const form of NESTED_FORMS) {
        const nested = await analyzed(`forwarded-sequence-${form}-${n}.yaml`, forwardedSequenceNested(n, form));
        expect(consumerStepFindings(nested, NESTED_PREFIX[form]), form).toEqual(top);
      }
    }, 120_000);
  }
});

describe("an analysis narrowed by 'within'", () => {
  it("labels a finding among the configurations it keeps, and drops one holding only outside them", async () => {
    const loaded = await loadGenerated("flag-sequence-3.yaml", flagSequence(3));
    const found = new StaticAnalyzer().analyze(loaded.manifests, {
      moduleDocuments: loaded.moduleDocuments,
      within: { "variables.flag1": false },
    });
    expect(found.map((d) => [d.code, (d.data as { path?: string }).path, d.message])).toEqual([
      [
        "CEL_TYPE_ERROR",
        "steps[2].value.then",
        `Run.Sequence/sequence: !cel: no "+" is declared over string, int (when variables.flag2 is false and variables.flag3 is true)`,
      ],
      [
        "CEL_TYPE_ERROR",
        "steps[1].value.then",
        `Run.Sequence/sequence: !cel: no "+" is declared over string, int (when variables.flag2 is true)`,
      ],
    ]);
    const narrowed = new StaticAnalyzer().analyze(loaded.manifests, {
      moduleDocuments: loaded.moduleDocuments,
      within: { "variables.flag1": true, "variables.flag2": true },
    });
    expect(narrowed.map((d) => d.message)).toEqual([]);
  });

  it("reports a branch no configuration takes inside an option it does not keep", async () => {
    const loaded = await loadGenerated("nested-dead-branch.yaml", nestedDeadBranch());
    const nowhere = (within?: Record<string, unknown>) =>
      new StaticAnalyzer()
        .analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, ...(within ? { within } : {}) })
        .filter((d) => (d.data as { configurations?: unknown[] }).configurations?.length === 0)
        .map((d) => [d.code, (d.data as { path?: string }).path]);
    const expected = [
      ["SCHEMA_VIOLATION", "steps[1].else.else.when"],
      ["CEL_TYPE_ERROR", "steps[1].else.else.inputs.b"],
      ["CEL_TYPE_ERROR", "steps[1].else.else.inputs.a"],
    ];
    expect(nowhere()).toEqual(expected);
    expect(nowhere({ "variables.flag2": true })).toEqual(expected);
  });

  it("refuses a key naming no dimension and a value outside its domain", async () => {
    const loaded = await loadGenerated("flag-sequence-1.yaml", flagSequence(1));
    const analyze = (within: Record<string, unknown>) =>
      new StaticAnalyzer().analyze(loaded.manifests, { moduleDocuments: loaded.moduleDocuments, within });
    expect(() => analyze({ "variables.flag9": true })).toThrow(
      `'within' names 'variables.flag9', which is no dimension of this analysis (its dimensions: 'variables.flag1').`,
    );
    expect(() => analyze({ "variables.flag1": "yes" })).toThrow(
      `'within' gives 'variables.flag1' the value "yes", which is outside its domain (false, true).`,
    );
  });
});

/** A union element by element, each condition written as its cover and each
 *  written document and choice by its place: comparable across analyses. */
function unionText(union: ConditionedExpansion, manifests: readonly unknown[]): unknown {
  const sentinels = new Map<object, number>();
  const sentinel = (value: object) => {
    if (!sentinels.has(value)) sentinels.set(value, sentinels.size);
    return sentinels.get(value);
  };
  const condition = (c: Condition) => union.space.cover(c).map((block) => [...block]);
  const step = (s: ChoiceStep) => [sentinel(s.sentinel as object), s.branch ?? null, condition(s.taken)];
  const value = (v: unknown): unknown => {
    if (isAlternatives(v)) {
      return {
        $alternatives: v.options.map((o) => ({
          condition: condition(o.condition),
          taken: condition(o.taken),
          path: o.path.map(step),
          present: o.present,
          value: value(o.value),
          at: o.at,
          moved: o.moved,
          exact: !!o.exact,
          unreachable: !!o.unreachable,
          baseline: o.baseline ?? null,
        })),
      };
    }
    if (typeof v === "bigint") return `${v}n`;
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(value);
    return Object.fromEntries(Object.entries(v).map(([key, field]) => [key, value(field)]));
  };
  const all = [...union.declarations, ...union.views];
  const declaration = (d: (typeof all)[number]) => ({
    condition: condition(d.condition),
    holder: manifests.indexOf(d.holder),
    at: d.at,
    path: d.path.map(step),
    unreachable: !!d.unreachable,
    manifest: value(d.manifest),
  });
  return {
    dimensions: union.space.dimensions,
    declarations: union.declarations.map(declaration),
    views: union.views.map((view: ConditionedView) => ({
      ...declaration(view),
      consumer: all.indexOf(view.consumer),
      upstream: all.indexOf(view.upstream),
      entry: [view.entryKind, view.entryName],
      crossed: view.crossed.map((c) => [all.indexOf(c.holder), c.at, c.rest]),
    })),
    elements: union.elements.map((e) => ({
      holder: manifests.indexOf(e.holder),
      keys: e.keys,
      condition: condition(e.condition),
      present: e.present,
      standIn: e.standIn,
      unreachable: e.unreachable,
    })),
  };
}

describe("the union an analysis narrowed by 'within' reads", () => {
  const fixtures: Array<[string, string]> = [
    ["flag-sequence-3.yaml", flagSequence(3)],
    ["flag-targets-2.yaml", flagTargets(2)],
    ["forwarded-sequence-2.yaml", forwardedSequence(2)],
    ["nested-dead-branch.yaml", nestedDeadBranch()],
    ["merged-place-views.yaml", mergedPlaceViews()],
  ];
  for (const [name, text] of fixtures) {
    it(`is the whole space's, the one 'configurationsOf' returns: ${name}`, async () => {
      const loaded = await loadGenerated(name, text);
      const options = { moduleDocuments: loaded.moduleDocuments };
      const all = new StaticAnalyzer().configurationsOf(loaded.manifests, options);
      const first = all.dimensions[0]!;
      const withins: Assignment[] = [...all.configurations, { [first.key]: first.values[0] }];
      for (const within of withins) {
        const kept = new StaticAnalyzer().configurationsOf(loaded.manifests, { ...options, within });
        expect(kept.dimensions, assignmentKey(within)).toEqual(all.dimensions);
        expect(kept.configurations, assignmentKey(within)).toEqual(all.configurations.filter((c) => agreesWith(within, c)));
        let read: ConditionedExpansion | undefined;
        const stop = observeAnalysisReadings((reading) => (read = reading.union));
        try {
          new StaticAnalyzer().analyze(loaded.manifests, { ...options, within });
        } finally {
          stop();
        }
        expect(unionText(read!, loaded.manifests), assignmentKey(within)).toEqual(unionText(kept.union, loaded.manifests));
      }
    }, 120_000);
  }
});

describe("branches no configuration takes, reading outside the configurations kept", () => {
  const nowhere = (found: readonly AnalysisDiagnostic[]) =>
    found
      .filter((d) => (d.data as { configurations?: unknown[] }).configurations?.length === 0)
      .map((d) => identityOf(d, d.message))
      .sort();

  it("judge each site they read there once, however many of them read it, whole and narrowed", async () => {
    const producers = 4;
    const liveProducers = new Set<number>();
    for (const k of [1, 4, 16]) {
      const loaded = await loadGenerated(`dead-readers-${k}.yaml`, deadReaders(k, producers));
      const options = { moduleDocuments: loaded.moduleDocuments };
      const whole = keysJudged(() => new StaticAnalyzer().analyze(loaded.manifests, options));
      const narrowed = keysJudged(() =>
        new StaticAnalyzer().analyze(loaded.manifests, { ...options, within: { "variables.flag1": true } }),
      );
      // The first producer's `flag1=false` expression and every forward after
      // it, each read by every branch at their one shared baseline.
      for (const [label, judged] of [["whole", whole], ["within flag1=true", narrowed]] as const) {
        expect(judged.keys.wholeCare.map((key) => JSON.parse(key.slice("cel ".length))[3]).sort(), `${label}, k=${k}`).toEqual([
          "steps[0].value.else",
          "steps[1].value",
          "steps[2].value",
          "steps[3].value",
        ]);
      }
      // The producers' keys a kept configuration holds do not grow with k.
      liveProducers.add(
        [...whole.keys.live]
          .filter(([at]) => /^steps\[[0-3]\]/.test(String(JSON.parse(JSON.parse(at)[1])[3])))
          .reduce((n, [, keys]) => n + keys, 0),
      );
      expect(nowhere(narrowed.result), `k=${k}`).toEqual(nowhere(whole.result));
    }
    expect(liveProducers.size, "live producer keys across k").toBe(1);
  }, 120_000);

  it("never read a key judged for the configurations kept: a shape one configuration declares", async () => {
    const loaded = await loadGenerated("care-identity.yaml", careIdentity());
    const options = { moduleDocuments: loaded.moduleDocuments };
    const whole = nowhere(new StaticAnalyzer().analyze(loaded.manifests, options));
    expect(whole.map((d) => JSON.parse(d)[0])).toEqual(["CEL_UNKNOWN_FIELD"]);
    for (const value of [true, false]) {
      const narrowed = new StaticAnalyzer().analyze(loaded.manifests, { ...options, within: { "variables.flag2": value } });
      expect(nowhere(narrowed), `within flag2=${value}`).toEqual(whole);
    }
  }, 120_000);
});
