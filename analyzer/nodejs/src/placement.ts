/**
 * THE placement of findings: how a finding computed in one world — a
 * configuration run, a key's carve, a part of the union — moves to where its
 * author wrote it. Every world constructs one {@link Placement} over its own
 * coordinates; none places a finding any other way.
 *
 * In order: a finding about a forward view built over the world's own
 * declarations moves to its consumer, or — at a place the body wrote — is
 * reported at the consumer as a body-entry finding; a scope member's moves into
 * its holder; an extraction's moves to the root of its origin chain, labelled
 * by it, its quoted places re-rooted there; a template body's and an
 * expansion's paths move to where they are written, each quote re-rendered
 * from where it now stands; and a view the world holds as a region of the
 * union, whose place map already lands where its consumer wrote it, moves last.
 *
 * A world hands the scope-member and origin stages an index of its own — a
 * run its members' tokens and its extractions' origins, the union the call
 * graph's nodes — and a world whose coordinates hold choices hands `place` the
 * reader deciding them.
 *
 * It never filters. It drops a finding only where it has no written place in
 * the world: at a place a view's no-place set holds. Every other judgement of a
 * finding against a refusal or another finding is the finishing pipeline's,
 * which reads the PROVENANCE placement records on each finding it places.
 *
 * Browser-safe.
 */
import { writtenAt, type WrittenAt } from "./diagnostic-identity.js";
import { relocatePath } from "./choice-expansion.js";
import type { ChoiceDecider, PlaceMap, PlaceMapping, ViewBody } from "./conditioned-expansion.js";
import type { TemplateVariantOf } from "./key-parts.js";
import { quotedPlacesOf, relocatedRendering, reportedAtHolder, rerootedQuotes, type QuotedPlace } from "./quoted-place.js";
import { syntheticOrigins } from "./rewrite-synthetic-origins.js";
import { isScopeMemberDeclaration } from "./scope-members.js";
import { formatPath, forwardPointOf, type ForwardedEntry, type TemplateForwardViews } from "./template-forward.js";
import type { FormPlace } from "./validate-reference-forms.js";
import type { AnalysisDiagnostic } from "./types.js";
import type { ViewBinding } from "./view-binding.js";

type Segment = string | number;

/** Where provenance rides on a placed finding: invisible to every serialization,
 *  kept by every spread, and stripped by the finishing pipeline before merging. */
export const PROVENANCE: unique symbol = Symbol("telo.analyzer.provenance");

/** A place a view's body wrote, a finding at which is reported at the consumer. */
export interface BodyEntryPlace {
  /** The definition whose body holds the entry, as written. */
  readonly writtenBy: ViewBody["writtenBy"];
  readonly entry: string;
  /** The finding's place in the entry. */
  readonly path: string;
  /** The consumer's expansion refused a choice or a repeat of the body. */
  readonly incomplete: boolean;
  /** What the view's consumer gives the definition's own dimensions. */
  readonly binding?: ViewBinding;
}

/** A refusal a finding carries: what it covers holds only where it does not. */
export interface CarriedCover {
  /** The written places it covers; absent, the refusal's own declaration. */
  readonly keys?: readonly string[];
  covers(diagnostic: AnalysisDiagnostic, provenance: Provenance | undefined): boolean;
}

/** What placement knew of a finding before it moved it. */
export interface Provenance {
  /** About a forward view, moved to its consumer. */
  readonly moved?: true;
  /** At a place a view's body wrote. */
  readonly bodyEntry?: BodyEntryPlace;
  /** Its file, once views and scope members are placed and before origins are. */
  readonly file?: unknown;
  /** Where its declaration's extraction chain stands for the form refusals. */
  readonly form?: FormPlace;
  /** The refusals it is. */
  readonly refuses?: readonly CarriedCover[];
}

/** Where a raw finding names the declaration it is about, for an index that
 *  finds declarations by a key of its own. Stripped by placement. */
const ABOUT: unique symbol = Symbol("telo.analyzer.about");

/** `d`, about the declaration a world's index finds by `key`. */
export function aboutDeclaration(d: AnalysisDiagnostic, key: string): AnalysisDiagnostic {
  return { ...d, [ABOUT]: key } as AnalysisDiagnostic;
}

/** The key `d` names its declaration by, when it names one. */
export function declarationKeyOf(d: AnalysisDiagnostic): string | undefined {
  return (d as { [ABOUT]?: string })[ABOUT];
}

/** Where a declaration written inside another stands: the declaration of the
 *  world holding it, its file, and a finding's place in it. */
export interface WrittenInside {
  readonly resource: { readonly kind?: string; readonly name?: string };
  readonly filePath: string | undefined;
  readonly path: string;
}

/** A world's scope members: where a finding about one stands in its holder. */
export interface ScopeMemberIndex {
  memberPlace(d: AnalysisDiagnostic, read: ChoiceDecider | undefined): WrittenInside | undefined;
}

/** What a world's extraction drew out of its declarations: where a finding
 *  about one stands in the declaration it was written in — `rerouted` when
 *  that is another declaration, whose label the finding then takes. */
export interface OriginIndex {
  extractionPlace(d: AnalysisDiagnostic, read: ChoiceDecider | undefined): (WrittenInside & { readonly rerouted: boolean }) | undefined;
}

export function provenanceOf(d: AnalysisDiagnostic): Provenance | undefined {
  return (d as { [PROVENANCE]?: Provenance })[PROVENANCE];
}

export function withoutProvenance(d: AnalysisDiagnostic): AnalysisDiagnostic {
  if (!(PROVENANCE in d)) return d;
  const out = { ...d } as AnalysisDiagnostic & { [PROVENANCE]?: Provenance };
  delete out[PROVENANCE];
  return out;
}

/** What the view stages ask of the views a world holds. */
export interface ViewPlacing {
  readonly holdsViews: TemplateForwardViews["holdsViews"];
  readonly analyzed: TemplateForwardViews["analyzed"];
  entryAbout(d: AnalysisDiagnostic, read?: ChoiceDecider): ForwardedEntry | undefined;
}

/** What one world places its findings through, each stage optional. */
export interface PlacementWorld {
  /** Forward views built over the world's own declarations. */
  readonly views?: ViewPlacing;
  readonly scopeMembers?: ScopeMemberIndex;
  /** What extraction drew out of the world's declarations, scope members
   *  aside: absent, no origin is rewritten. */
  readonly origins?: OriginIndex;
  /** How a finding stands for the form refusals among `origins`. */
  readonly forms?: (d: AnalysisDiagnostic) => FormPlace;
  /** The refusals a finding is, read once views and scope members are placed. */
  readonly refusals?: (d: AnalysisDiagnostic, file: unknown) => readonly CarriedCover[] | undefined;
  /** Template bodies decided otherwise than written, each moved to where it is
   *  written — but `written`, already about the body as written. */
  readonly bodies?: { readonly variants: Iterable<TemplateVariantOf>; readonly written?: ReadonlySet<AnalysisDiagnostic> };
  /** Each projected declaration's paths moved to where they are written. */
  readonly expansion?: (found: AnalysisDiagnostic[], read: ChoiceDecider | undefined) => AnalysisDiagnostic[];
  /** Views held as regions of the union, placed once everything else is. */
  readonly writtenViews?: ViewPlacing;
}

type Tracked = { diagnostic: AnalysisDiagnostic; provenance: Provenance };

export class Placement {
  constructor(private readonly world: PlacementWorld) {}

  /** Each of `found` in written coordinates, carrying its provenance — `read`
   *  deciding each choice the world's coordinates hold. */
  place(found: AnalysisDiagnostic[], read?: ChoiceDecider): AnalysisDiagnostic[] {
    const { world } = this;
    let tracked: Tracked[] = found.map((diagnostic) => ({ diagnostic, provenance: {} }));
    if (world.views) tracked = throughViews(world.views, tracked, read);
    const members = world.scopeMembers;
    if (members) tracked = mapped(tracked, (list) => intoHolders(list, members, read));
    tracked = tracked.map(({ diagnostic, provenance }) => {
      const file = (diagnostic.data as { filePath?: unknown } | undefined)?.filePath;
      const form = world.forms?.(diagnostic);
      const refuses = [
        ...(provenance.refuses ?? []),
        ...(world.refusals?.(diagnostic, file) ?? []),
        ...(form?.refuses !== undefined ? [formCover(form.refuses)] : []),
      ];
      return {
        diagnostic,
        provenance: {
          ...provenance,
          file,
          ...(form ? { form } : {}),
          ...(refuses.length > 0 ? { refuses } : {}),
        },
      };
    });
    const origins = world.origins;
    tracked = mapped(tracked, (list) => rerootedQuotes(origins ? throughOrigins(list, origins, read) : list));
    const bodies = world.bodies;
    if (bodies) {
      const variants = [...bodies.variants];
      if (variants.length > 0) tracked = mapped(tracked, (list) => relocatedRendering(list, (each) => each.map((d) => inWrittenBody(d, variants, bodies.written))));
    }
    if (world.expansion) tracked = mapped(tracked, (list) => relocatedRendering(list, (each) => world.expansion!(each, read)));
    if (world.writtenViews) tracked = throughViews(world.writtenViews, tracked, read);
    return tracked.map(({ diagnostic, provenance }) => {
      const out = { ...diagnostic, [PROVENANCE]: provenance } as AnalysisDiagnostic & { [ABOUT]?: string };
      if (ABOUT in out) delete out[ABOUT];
      return out;
    });
  }
}

/** Each finding about a scope member moved into its holder, at the member's
 *  place there. */
function intoHolders(list: AnalysisDiagnostic[], index: ScopeMemberIndex, read: ChoiceDecider | undefined): AnalysisDiagnostic[] {
  return list.map((d) => {
    const placed = withWrittenAtPlaced(d, (about) => index.memberPlace(about, read));
    const at = index.memberPlace(placed, read);
    if (!at) return placed;
    return { ...placed, data: { ...(placed.data as Record<string, unknown>), resource: at.resource, filePath: at.filePath, path: at.path } };
  });
}

/** `d` with the place its `data.writtenAt` names moved as `place` moves a
 *  finding written there: a dependency's defect re-reported at an import is
 *  written where the dependency's own finding is placed. */
function withWrittenAtPlaced(
  d: AnalysisDiagnostic,
  place: (about: AnalysisDiagnostic) => WrittenInside | undefined,
): AnalysisDiagnostic {
  const written = (d.data as { writtenAt?: WrittenAt } | undefined)?.writtenAt;
  if (!written) return d;
  const at = place({ ...d, data: written });
  if (!at) return d;
  return {
    ...d,
    data: {
      ...(d.data as Record<string, unknown>),
      writtenAt: writtenAt({ resource: at.resource, ...(at.filePath !== undefined ? { filePath: at.filePath } : {}), path: at.path }),
    },
  };
}

/** Each finding about an extraction moved to where it was written, labelled
 *  by the declaration it was written in. */
function throughOrigins(list: AnalysisDiagnostic[], index: OriginIndex, read: ChoiceDecider | undefined): AnalysisDiagnostic[] {
  return list.map((each) => {
    const d = withWrittenAtPlaced(each, (about) => index.extractionPlace(about, read));
    const at = index.extractionPlace(d, read);
    if (!at) return d;
    const data = d.data as { resource?: { kind?: string; name?: string } };
    const moved = { ...d, data: { ...data, resource: at.resource, filePath: at.filePath, path: at.path } };
    return at.rerouted ? reportedAtHolder(moved, at.path, data.resource ?? {}, at.resource) : moved;
  });
}

/** A one-for-one stage over the tracked findings. */
function mapped(tracked: Tracked[], stage: (list: AnalysisDiagnostic[]) => AnalysisDiagnostic[]): Tracked[] {
  const out = stage(tracked.map((each) => each.diagnostic));
  if (out.length !== tracked.length) throw new Error("internal: a placement stage added or dropped a finding.");
  return out.map((diagnostic, i) => ({ diagnostic, provenance: tracked[i]!.provenance }));
}

/** A refused author-written `__ref` key's cover: what its point holds. */
function formCover(point: string): CarriedCover {
  return {
    covers: (diagnostic, provenance) => {
      const form = provenance?.form;
      return !!form && !form.refusal && form.points().includes(point);
    },
  };
}

/** `d`, about a template definition whose body a variant decides, at the
 *  place the body is written. */
function inWrittenBody(
  d: AnalysisDiagnostic,
  variants: readonly TemplateVariantOf[],
  written: ReadonlySet<AnalysisDiagnostic> | undefined,
): AnalysisDiagnostic {
  if (written?.has(d)) return d;
  const data = d.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
  if (data?.resource?.kind !== "Telo.Definition" || typeof data.path !== "string") return d;
  for (const { variant: chosen, written: definition } of variants) {
    const meta = definition.metadata as { name?: unknown; source?: unknown } | undefined;
    if (meta?.name !== data.resource.name || meta?.source !== data.filePath) continue;
    const path = chosen.expansion.relocate(data.path);
    if (path === data.path) return d;
    return { ...d, data: { ...(d.data as Record<string, unknown>), path } };
  }
  return d;
}

/**
 * Each finding about a view placed by the view's place map: moved to where its
 * consumer wrote the forward, or — at a place the body wrote — reported at the
 * consumer, naming the entry and field; dropped only at a place of the view's
 * no-place set. One about a view's extraction is first moved onto the view.
 * The consumer's own findings come first, then the moved ones, then those at
 * body places.
 */
function throughViews(views: ViewPlacing, tracked: Tracked[], read: ChoiceDecider | undefined): Tracked[] {
  if (!views.holdsViews) return tracked;
  const origins = syntheticOrigins(views.analyzed);
  const unfolded = mapped(tracked, (list) => rerootedQuotes(throughOrigins(list, origins, read)));
  const own: Tracked[] = [];
  const found: Tracked[] = [];
  const links: { entry: ForwardedEntry; link: PlaceMapping }[] = [];
  const atBody: Tracked[] = [];
  for (const each of unfolded) {
    const d = each.diagnostic;
    const entry = views.entryAbout(d, read);
    if (!entry) {
      own.push(each);
      continue;
    }
    const path = pathOf(d);
    const link = forwardPointOf(entry.places, path);
    if (link) {
      found.push(each);
      links.push({ entry, link });
      continue;
    }
    if (entry.body.noPlace.has(path)) continue;
    atBody.push({
      diagnostic: bodyFinding(d, entry),
      provenance: {
        ...each.provenance,
        moved: true,
        bodyEntry: {
          writtenBy: entry.body.writtenBy,
          entry: entry.entryName,
          path,
          incomplete: entry.body.incomplete,
          ...(entry.body.binding ? { binding: entry.body.binding } : {}),
        },
      },
    });
  }
  const relocated = relocatedRendering(
    found.map((each) => each.diagnostic),
    (list) =>
      list.map((d) => {
        const entry = views.entryAbout(d, read);
        if (!entry) return d;
        const data = d.data as { path?: unknown; filePath?: string };
        const root = entry.root;
        return {
          ...d,
          data: {
            ...data,
            resource: entry.reportedAs ?? { kind: root.kind, name: root.metadata?.name as string },
            filePath: (root.metadata as { source?: string } | undefined)?.source ?? data.filePath,
            ...(typeof data.path === "string" ? { path: relocatePath(data.path, entry.places.mappings) } : {}),
          },
        } as AnalysisDiagnostic;
      }),
  );
  const moved = relocated.map((d, i): Tracked => {
    const { entry, link } = links[i]!;
    return {
      diagnostic: forwardedMessage(d, entry, entry.rootPlaces ? { ...link, to: projectedPlace(link.to, entry.rootPlaces) } : link),
      provenance: { ...found[i]!.provenance, moved: true },
    };
  });
  return [...own, ...moved, ...atBody];
}

function pathOf(d: AnalysisDiagnostic): string {
  const path = (d.data as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : "";
}

/** Where the written place `written` stands in the projection `places` maps
 *  back: through the mapping writing the longest part of it. */
function projectedPlace(written: readonly Segment[], places: PlaceMap): readonly Segment[] {
  let best: PlaceMapping | undefined;
  for (const mapping of places.mappings) {
    if (mapping.to.length > written.length || !mapping.to.every((key, i) => String(key) === String(written[i]))) continue;
    if (!best || mapping.to.length > best.to.length) best = mapping;
  }
  return best ? [...best.from, ...written.slice(best.to.length)] : written;
}

/** A finding about a view, as its consumer reads it: what the consumer wrote,
 *  where it is forwarded, and what the entry's check found there. */
function forwardedMessage(d: AnalysisDiagnostic, entry: ForwardedEntry, link: PlaceMapping): AnalysisDiagnostic {
  const viewLabel = `${entry.view.kind}/${entry.view.metadata!.name as string}`;
  const entryLabel = `the ${entry.entryKind} entry '${entry.entryName}'`;
  // A consumer written inline is named by the declaration holding it; a scope
  // member is a declaration its author named.
  const reported =
    (isScopeMemberDeclaration(entry.root) ? undefined : entry.reportedAs) ?? { kind: entry.root.kind, name: entry.root.metadata?.name as string };
  const prefix =
    `${reported.kind}/${reported.name}: '${formatPath(link.to)}' is forwarded into ${entryLabel} as ` +
    `'${formatPath(link.from)}', which checks it as its own field — `;
  const relabel = (text: string, first: boolean) => {
    const inner = first && text.startsWith(`${viewLabel}: `) ? text.slice(viewLabel.length + 2) : text;
    return `${first ? prefix : ""}${withoutViewNames(inner.split(viewLabel).join(entryLabel), entry)}`;
  };
  const quotes = quotedPlacesOf(d);
  const quotedPlace: QuotedPlace[] | undefined = quotes?.map((q, i) => ({
    ...q,
    before: relabel(q.before, i === 0),
    after: q.after.split(viewLabel).join(entryLabel),
  }));
  return {
    ...d,
    message: relabel(d.message, true),
    ...(quotedPlace ? { data: { ...(d.data as Record<string, unknown>), quotedPlace } } : {}),
  } as AnalysisDiagnostic;
}

/** `text` naming each sibling view of `entry`'s by the entry name the body
 *  wrote: a view's name is generated, never the author's. */
function withoutViewNames(text: string, entry: ForwardedEntry): string {
  const name = entry.view.metadata!.name as string;
  const suffix = `→${entry.entryName}`;
  if (!name.endsWith(suffix)) return text;
  return text.split(`${name.slice(0, -suffix.length)}→`).join("");
}

/** A finding at a place the body wrote, as its consumer reads it: at the
 *  consumer, naming the body entry and the field it is about. */
function bodyFinding(d: AnalysisDiagnostic, entry: ForwardedEntry): AnalysisDiagnostic {
  const viewLabel = `${entry.view.kind}/${entry.view.metadata!.name as string}`;
  const entryLabel = `the ${entry.entryKind} entry '${entry.entryName}'`;
  const root = entry.root;
  const reported =
    (isScopeMemberDeclaration(root) ? undefined : entry.reportedAs) ?? { kind: root.kind, name: root.metadata?.name as string };
  const path = pathOf(d);
  const text = d.message.startsWith(`${viewLabel}: `) ? d.message.slice(viewLabel.length + 2) : d.message;
  // A quoted place names the view's own position, which is no place of the consumer's.
  const data = { ...((d.data ?? {}) as Record<string, unknown>) };
  delete data.quotedPlace;
  return {
    ...d,
    message:
      `${reported.kind}/${reported.name}: \`${entry.body.holderKind}\` body entry \`${entry.entryName}\`` +
      `${path ? `, field \`${path}\`` : ""}: ${withoutViewNames(text.split(viewLabel).join(entryLabel), entry)}`,
    data: {
      ...data,
      resource: entry.reportedAs ?? { kind: root.kind, name: root.metadata?.name as string },
      filePath: (root.metadata as { source?: string } | undefined)?.source ?? (data.filePath as string | undefined),
      path: relocatePath("", entry.rootPlaces?.mappings ?? []),
    },
  } as AnalysisDiagnostic;
}
