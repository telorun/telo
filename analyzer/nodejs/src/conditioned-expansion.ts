/**
 * Every configuration's documents at once: each `!if` / `!switch` outside a
 * template body replaced by ALL its branches, each carrying the presence
 * condition it is taken under — the condition of the branch, AND the
 * conditions of every branch enclosing it.
 *
 * A declaration carries the condition it is declared under; a field value or
 * a list item a choice decides is an {@link Alternatives} node in its place,
 * one option per branch (absent, a stand-in, or the branch's value). The
 * options of one node never hold together, and together they hold wherever
 * the node is reached. Its projection at one configuration ({@link
 * ConditionedExpansion.at}) is that configuration's expansion, exactly as
 * {@link expandChoices} writes it — the one expansion read twice, never a
 * second one.
 *
 * A branch no configuration takes stays in the union as an UNREACHABLE option
 * (condition FALSE), carrying its local condition and, for a branch the choice
 * reading names, the configuration reaching its choice. A projection under a
 * FORCING (choice → branch) takes a forced choice's named branch and every
 * other choice's branch by its local condition, so a dead branch's own choices
 * are decided too.
 *
 * Browser-safe.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  expansionTagLabel,
  isExpansionSentinel,
  isTaggedSentinel,
  makeTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import { branchKeys, branchValue, STAND_IN, type Decisions } from "./choice-reading.js";
import { declaredMetadata, isChoice, relocatePath, STAND_IN_MARK, STAND_IN_SOURCE } from "./choice-expansion.js";
import type { Assignment } from "./configuration-dimensions.js";
import { isModuleKind } from "./module-kinds.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import type { AnalysisDiagnostic } from "./types.js";

type Keys = readonly (string | number)[];

/** The condition each branch of a choice is taken under: a branch id, `null`
 *  for none, or {@link STAND_IN}. */
export type BranchConditions = ReadonlyMap<ExpansionSentinel, ReadonlyMap<string | null, Condition>>;

/** A branch of a choice no configuration takes, and a configuration reaching
 *  its choice. */
export interface UnreachableOption {
  readonly site: { readonly sentinel: ExpansionSentinel };
  readonly branch: string;
  readonly baseline: Assignment;
}

/** One choice decided on the way to an option or a declaration: the branch it
 *  takes and the condition it takes it under, regardless of what encloses it. */
export interface ChoiceStep {
  readonly sentinel: ExpansionSentinel;
  /** A branch id, `null` for none, {@link STAND_IN}; undefined for a choice
   *  nothing reads, left as written. */
  readonly branch: string | null | undefined;
  readonly taken: Condition;
}

/** Where a lifted value holds: the configurations, and the choices taken to
 *  reach it — how a forced witness decides it. */
export interface Holding {
  readonly condition: Condition;
  readonly path: readonly ChoiceStep[];
}

/** What holds in every configuration, reached through no choice. */
export const EVERYWHERE: Holding = { condition: TRUE, path: [] };

/** Whether `holding` holds everywhere, through no choice. */
export function isEverywhere(holding: Holding): boolean {
  return holding.condition === TRUE && holding.path.length === 0;
}

/** Both holdings at once: their conditions met, their paths joined. */
export function meet(space: ConditionSpace | undefined, a: Holding, b: Holding): Holding {
  if (isEverywhere(a)) return b;
  if (isEverywhere(b)) return a;
  const path = [...a.path];
  for (const step of b.path) if (!path.includes(step)) path.push(step);
  return { condition: space ? space.and(a.condition, b.condition) : TRUE, path };
}

/** The holding of a choice's option, outside every choice enclosing it. */
export function holdingOf(option: AlternativeOption): Holding {
  return { condition: option.condition, path: option.path };
}

/** A node holding `value` only where `holding` holds, written at `at`. */
export function heldNode(value: unknown, holding: Holding, at: Keys, moved: boolean, exact = false): Alternatives {
  return new Alternatives([
    {
      condition: holding.condition,
      taken: holding.condition,
      path: holding.path,
      present: true,
      value,
      at,
      moved,
      ...(exact ? { exact: true as const } : {}),
    },
  ]);
}

/** One branch of a choice in place. */
export interface AlternativeOption {
  /** Every configuration it is taken in — FALSE for an unreachable one. */
  readonly condition: Condition;
  /** The choices taken to reach it, innermost last: the conjunction of their
   *  local conditions, regardless of the branches enclosing the node. */
  readonly taken: Condition;
  readonly path: readonly ChoiceStep[];
  readonly present: boolean;
  readonly value?: unknown;
  /** Where the option's value is written in its holder. */
  readonly at: Keys;
  /** For a branch declaring a scope member: where its tag's `metadata` is. */
  readonly metadataAt?: Keys;
  /** Whether its value moves from where the node stands to {@link at} — false
   *  for a choice nothing reads, left as written. */
  readonly moved: boolean;
  /** Every place inside its value is reported at {@link at} itself: a value a
   *  forward view takes across a reference, written in another declaration. */
  readonly exact?: true;
  /** Taken in no configuration. */
  readonly unreachable?: true;
  /** For a branch the choice reading names unreachable: a configuration
   *  reaching its choice. */
  readonly baseline?: Assignment;
}

/** A value or list item a choice decides: its options, in branch order. */
export class Alternatives {
  constructor(readonly options: readonly AlternativeOption[]) {}
}

export function isAlternatives(value: unknown): value is Alternatives {
  return value instanceof Alternatives;
}

/** A declaration of the union with the condition it is declared under. */
export interface ConditionedDeclaration {
  /** FALSE for one only an unreachable branch declares. */
  readonly condition: Condition;
  /** As expanded, every choice inside it an {@link Alternatives} node. */
  readonly manifest: ResourceManifest;
  /** The document it is written in, and where in it — a whole document's
   *  branch, or the document itself. */
  readonly holder: ResourceManifest;
  readonly at: Keys;
  /** The whole-document choices taken to declare it — for a nested one, those
   *  and the options on the way to it. */
  readonly path: readonly ChoiceStep[];
  readonly unreachable?: true;
  /** For a declaration written inside another — inline, or a scope member —
   *  the declaration of the union holding it; it is no declaration of the
   *  union itself, and is reported where it is written there, which is its
   *  identity. */
  readonly declaredIn?: ConditionedDeclaration;
}

/** How a projected position moves back to where it is written: `from` the
 *  projected root, `to` the holder document's root — {@link expandChoices}'s
 *  relocation, entry for entry. */
export interface PlaceMapping {
  readonly from: Keys;
  readonly to: Keys;
  /** For a chosen declaration: where its `metadata` is written (the tag's). */
  readonly metadataAt?: Keys;
  /** Every position beneath {@link from} is written at {@link to} itself. */
  readonly exact?: true;
}

/** Where a projection's positions are written: the mappings, and for a whole
 *  document behind a tag the identity it is reported under. */
export interface PlaceMap {
  readonly mappings: readonly PlaceMapping[];
  readonly resource?: { readonly kind: string; readonly name: string };
}

/** A value of the union in one configuration: whether it is there, what it
 *  is, the condition of every option taken inside it — the configurations
 *  holding it as it is here — and where its positions are written. */
export interface Projected {
  readonly present: boolean;
  readonly value?: unknown;
  readonly taken: Condition;
  readonly places: PlaceMap;
}

/** One element a choice decides: a branch, where it is written, and every
 *  configuration it is in. */
export interface ConditionedElement {
  /** The document the choice is written in (a whole document's own tag). */
  readonly holder: ResourceManifest;
  /** Where the branch is written in its holder (`steps[2].value.then`). */
  readonly keys: Keys;
  readonly condition: Condition;
  /** False for a branch that leaves the place empty. */
  readonly present: boolean;
  /** True for a choice nothing decides there. */
  readonly standIn: boolean;
  /** True for a branch no configuration takes. */
  readonly unreachable: boolean;
}

/** A forward view held beside the union's declarations: a resource of a
 *  template body entry's kind holding what a consumer forwards into it, under
 *  the consumer's condition AND the body options it is built through. */
export interface ConditionedView extends ConditionedDeclaration {
  /** The declaration of the union whose values the view holds — the root
   *  consumer of a view built from a view. */
  readonly consumer: ConditionedDeclaration;
  /** The declaration it was built from: its consumer, or the view one template
   *  further out. */
  readonly upstream: ConditionedDeclaration;
  /** The body entry's kind as written and its name, for messages. */
  readonly entryKind: string;
  readonly entryName: string;
  /** Every reference its forwards read across: the declaration holding it —
   *  its consumer, a declaration another crossing named, a view further out,
   *  or, for one a scope member holds, the declaration of the union holding
   *  that member — where it stands there (a choice node transparent), and the
   *  path read on in what it names. */
  readonly crossed: readonly ViewCrossing[];
  /** What the view holds of the body itself. */
  readonly body?: ViewBody;
}

/** What a view holds of its body entry as written: a finding there is the
 *  definition's when its own check makes the same one, else its consumer's. */
export interface ViewBody {
  /** The kind of the declaration whose body holds the entry, as written. */
  readonly holderKind: string;
  /** Each `<code>\0<path>` the definition's own check reports in the entry. */
  readonly ownFindings: ReadonlySet<string>;
  /** True when the consumer's expansion refused a choice or a repeat of the
   *  body: the refusal is the one report, and nothing at a body place is. */
  readonly incomplete: boolean;
  /** The view's places holding a body expression, by union keys — the
   *  definition's check types each. */
  readonly expressions: readonly string[];
  /** The view's places holding a body reference to anything but a sibling,
   *  as written — the definition's check resolves each in its own module. */
  readonly references: readonly string[];
  /** The view's places holding a reference aimed at a sibling's view. */
  readonly siblings: readonly string[];
}

/** One reference a view's forwards read across. */
export interface ViewCrossing {
  readonly holder: ConditionedDeclaration;
  readonly at: Keys;
  readonly rest: Keys;
}

/** Which branch each forced choice takes. */
export type Forcing = Decisions;

/** Where a key is read: a configuration, and — for a branch no configuration
 *  takes — the choices forced to reach it. */
export interface Witness {
  readonly assignment: Assignment;
  readonly forcing?: Forcing;
}

/** Whether an option or a declaration of the union is taken in `assignment`:
 *  unforced, by its condition; forced, each step of `path` by its forced branch
 *  or else by its local condition. */
export function takenAt(
  space: ConditionSpace,
  condition: Condition,
  path: readonly ChoiceStep[],
  assignment: Assignment,
  forcing?: Forcing,
): boolean {
  if (!forcing) return space.holds(condition, assignment);
  return path.every((step) =>
    forcing.has(step.sentinel) ? forcing.get(step.sentinel) === step.branch : space.holds(step.taken, assignment),
  );
}

/** How diagnostics about projected declarations move to where each is written:
 *  {@link expandChoices}' relocation, built from the projections' place maps. */
export function relocatorOf(
  projections: readonly { readonly value?: unknown; readonly places: PlaceMap }[],
): (diagnostics: readonly AnalysisDiagnostic[]) => AnalysisDiagnostic[] {
  const byIdentity = new Map<string, PlaceMap>();
  for (const { value, places } of projections) {
    if (places.mappings.length === 0) continue;
    const meta = (value as { metadata?: { name?: unknown; source?: unknown } } | undefined)?.metadata;
    byIdentity.set(JSON.stringify([(value as { kind?: unknown }).kind, meta?.name, meta?.source]), places);
  }
  return (diagnostics) => {
    if (byIdentity.size === 0) return [...diagnostics];
    return diagnostics.map((d) => {
      const data = d.data as
        | { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown }
        | undefined;
      if (!data?.resource) return d;
      const places = byIdentity.get(JSON.stringify([data.resource.kind, data.resource.name, data.filePath]));
      if (!places) return d;
      const path = typeof data.path === "string" ? relocatePath(data.path, places.mappings) : data.path;
      return {
        ...d,
        data: {
          ...(d.data as Record<string, unknown>),
          ...(places.resource ? { resource: places.resource } : {}),
          ...(path !== undefined ? { path } : {}),
        },
      };
    });
  };
}

export interface ConditionedExpansion {
  readonly space: ConditionSpace;
  readonly declarations: readonly ConditionedDeclaration[];
  /** The forward views, beside the declarations: named by nothing, so no name
   *  index holds one. Filled once by the forward-view builder. */
  readonly views: readonly ConditionedView[];
  addView(view: ConditionedView): void;
  /** Registers a container the union did not build so a projection rebuilds
   *  it: `written`, where it is written in its holder, or undefined for one
   *  written nowhere (a forward view's own skeleton), whose positions move
   *  nowhere. */
  hold(container: object, written?: Keys): void;
  /** Where a declaration of the union is written in its holder, and the
   *  identity it is reported under when a tag declares it whole. */
  placeOf(declaration: ResourceManifest): { readonly at: Keys; readonly resource?: { readonly kind: string; readonly name: string } };
  readonly elements: readonly ConditionedElement[];
  /** The expansion in one configuration: every declaration and option whose
   *  condition holds in it — under `forcing`, every one its forced choices and
   *  the local conditions of the rest select. */
  at(assignment: Assignment, forcing?: Forcing): ResourceManifest[];
  /** One value of the union (a declaration, or anything beneath one) in one
   *  configuration. Under `forcing`, `taken` is the conjunction of the local
   *  conditions of the choices it did not force. */
  project(value: unknown, assignment: Assignment, forcing?: Forcing): Projected;
  /** `value` with each place at `paths` beneath it — union keys, a choice
   *  transparent — replaced by `standIn`, whatever any configuration takes
   *  there: a copy a projection reads as it reads the union. */
  carve(value: unknown, paths: readonly Keys[], standIn: unknown): unknown;
}

/**
 * The union of `manifests` — in written order, whole documents behind a tag
 * among them — over `conditions`. `skip` and `mark` are {@link expandChoices}';
 * `unreachable` names the branches the choice reading finds no configuration
 * takes.
 */
export function expandUnion(
  manifests: readonly ResourceManifest[],
  space: ConditionSpace,
  conditions: BranchConditions,
  skip?: (sentinel: ExpansionSentinel) => boolean,
  mark = false,
  unreachable: readonly UnreachableOption[] = [],
): ConditionedExpansion {
  const declarations: ConditionedDeclaration[] = [];
  const elements: ConditionedElement[] = [];
  /** Containers the union built — the only ones a projection rebuilds — and
   *  where each is written in its holder. */
  const built = new WeakMap<object, Keys>();
  /** Containers held for a projection that are written nowhere. */
  const unwritten = new WeakSet<object>();
  const views: ConditionedView[] = [];
  /** A whole document's declaration: what moves its root, and its identity. */
  const roots = new WeakMap<object, { mapping: PlaceMapping; resource?: { kind: string; name: string } }>();
  const deadBranches = new Map<ExpansionSentinel, Map<string, Assignment>>();
  for (const entry of unreachable) {
    let byBranch = deadBranches.get(entry.site.sentinel);
    if (!byBranch) deadBranches.set(entry.site.sentinel, (byBranch = new Map()));
    byBranch.set(entry.branch, entry.baseline);
  }

  const unionTag = (
    holder: ResourceManifest,
    sentinel: ExpansionSentinel,
    from: Keys,
    within: Condition,
    withinTaken: Condition,
    path: readonly ChoiceStep[],
    metadata: { value: unknown; at: Keys } | undefined,
  ): AlternativeOption[] => {
    const branches = conditions.get(sentinel);
    if (branches === undefined) {
      return [
        {
          condition: within,
          taken: withinTaken,
          path: [...path, { sentinel, branch: undefined, taken: TRUE }],
          present: true,
          value: sentinel,
          at: from,
          moved: false,
        },
      ];
    }
    const ownMetadata = (sentinel as Record<string, unknown>).metadata;
    const named = ownMetadata !== undefined ? { value: ownMetadata, at: from } : metadata;
    const all: [string | null, Condition, Assignment | undefined][] = [...branches].map(([b, c]) => [b, c, undefined]);
    for (const [branch, baseline] of deadBranches.get(sentinel) ?? []) {
      if (!branches.has(branch)) all.push([branch, FALSE, baseline]);
    }
    const out: AlternativeOption[] = [];
    for (const [branch, local, baseline] of all) {
      const condition = space.and(within, local);
      const taken = space.and(withinTaken, local);
      const steps = [...path, { sentinel, branch, taken: local }];
      const dead = condition === FALSE;
      const marks = { ...(dead ? { unreachable: true as const } : {}), ...(baseline ? { baseline } : {}) };
      const at = branch === null || branch === STAND_IN ? from : [...from, ...branchKeys(branch)];
      const element = (present: boolean) =>
        elements.push({ holder, keys: at, condition, present, standIn: branch === STAND_IN, unreachable: dead });
      const option = (present: boolean, value?: unknown, metadataAt?: Keys): AlternativeOption => ({
        condition,
        taken,
        path: steps,
        present,
        ...(present ? { value } : {}),
        at,
        ...(metadataAt ? { metadataAt } : {}),
        moved: present,
        ...marks,
      });
      if (branch === null) {
        element(false);
        out.push(option(false));
        continue;
      }
      if (branch === STAND_IN) {
        element(true);
        out.push(
          option(
            true,
            named
              ? { metadata: { ...declaredMetadata(named.value, true), [STAND_IN_MARK]: true } }
              : makeTaggedSentinel(CEL_ENGINE, STAND_IN_SOURCE),
            named?.at,
          ),
        );
        continue;
      }
      const chosen = branchValue(sentinel, branch);
      if (!chosen.written) {
        element(false);
        out.push(option(false));
        continue;
      }
      if (isChoice(chosen.value) && !skip?.(chosen.value as ExpansionSentinel)) {
        out.push(...unionTag(holder, chosen.value as ExpansionSentinel, at, condition, taken, steps, named));
        continue;
      }
      if (named) {
        // A branch that is no declaration declares nothing.
        if (!chosen.value || typeof chosen.value !== "object" || Array.isArray(chosen.value)) {
          element(false);
          out.push(option(false));
          continue;
        }
        element(true);
        const { kind, ...fields } = chosen.value as Record<string, unknown>;
        const declared: Record<string, unknown> = { kind, metadata: declaredMetadata(named.value, mark) };
        for (const [key, field] of Object.entries(fields)) {
          if (key === "metadata") continue;
          declared[key] = unionValue(holder, field, [...at, key], condition, taken, steps).value;
        }
        built.set(declared, at);
        out.push(option(true, declared, named.at));
        continue;
      }
      element(true);
      out.push(option(true, unionValue(holder, chosen.value, at, condition, taken, steps).value));
    }
    return out;
  };

  const unionValue = (
    holder: ResourceManifest,
    value: unknown,
    from: Keys,
    within: Condition,
    withinTaken: Condition,
    path: readonly ChoiceStep[],
  ): { value: unknown; changed: boolean } => {
    if (isChoice(value) && !skip?.(value as ExpansionSentinel)) {
      return {
        value: new Alternatives(unionTag(holder, value as ExpansionSentinel, from, within, withinTaken, path, undefined)),
        changed: true,
      };
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) {
      return { value, changed: false };
    }
    if (isExpansionSentinel(value)) return { value, changed: false };
    if (Array.isArray(value)) {
      let changed = false;
      const items = value.map((item, i) => {
        const r = unionValue(holder, item, [...from, i], within, withinTaken, path);
        changed ||= r.changed;
        return r.value;
      });
      if (!changed) return { value, changed: false };
      built.set(items, from);
      return { value: items, changed: true };
    }
    let changed = false;
    const record: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const r = unionValue(holder, field, [...from, key], within, withinTaken, path);
      changed ||= r.changed;
      record[key] = r.value;
    }
    if (!changed) return { value, changed: false };
    built.set(record, from);
    return { value: record, changed: true };
  };

  for (const doc of manifests) {
    if (isExpansionSentinel(doc)) {
      if (skip?.(doc as unknown as ExpansionSentinel) || !isChoice(doc)) continue;
      const label = expansionTagLabel(doc);
      for (const option of unionTag(doc, doc as unknown as ExpansionSentinel, [], TRUE, TRUE, [], undefined)) {
        if (!option.present || option.value === doc) continue;
        const name = (option.value as { metadata?: { name?: unknown } }).metadata?.name;
        roots.set(option.value as object, {
          mapping: { from: [], to: option.at, metadataAt: option.metadataAt ?? [] },
          ...(label && typeof name === "string" ? { resource: { kind: label, name } } : {}),
        });
        declarations.push({
          condition: option.condition,
          manifest: option.value as ResourceManifest,
          holder: doc,
          at: option.at,
          path: option.path,
          ...(option.unreachable ? { unreachable: true as const } : {}),
        });
      }
      continue;
    }
    if (isKindDocumentOrImport(doc)) {
      declarations.push({ condition: TRUE, manifest: doc, holder: doc, at: [], path: [] });
      continue;
    }
    if (isModuleKind(doc.kind)) {
      const targets = (doc as Record<string, unknown>).targets;
      const r = Array.isArray(targets) ? unionValue(doc, targets, ["targets"], TRUE, TRUE, []) : undefined;
      if (!r?.changed) {
        declarations.push({ condition: TRUE, manifest: doc, holder: doc, at: [], path: [] });
        continue;
      }
      const manifest = { ...doc, targets: r.value } as ResourceManifest;
      built.set(manifest, []);
      declarations.push({ condition: TRUE, manifest, holder: doc, at: [], path: [] });
      continue;
    }
    let changed = false;
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(doc)) {
      if (key === "kind" || key === "metadata") {
        fields[key] = field;
        continue;
      }
      const r = unionValue(doc, field, [key], TRUE, TRUE, []);
      changed ||= r.changed;
      fields[key] = r.value;
    }
    if (changed) built.set(fields, []);
    declarations.push({ condition: TRUE, manifest: (changed ? fields : doc) as ResourceManifest, holder: doc, at: [], path: [] });
  }

  /** Whether `path` is taken: unforced, by the conjunction its option carries;
   *  forced, each step by its forced branch or else by its local condition. */
  const selects = (
    condition: Condition,
    path: readonly ChoiceStep[],
    assignment: Assignment,
    forcing: Forcing | undefined,
  ): boolean => takenAt(space, condition, path, assignment, forcing);
  /** The condition a forced projection holds a taken option under: its local
   *  conditions, the forced choices aside. */
  const unforcedTaken = (path: readonly ChoiceStep[], forcing: Forcing): Condition =>
    space.every(path.filter((step) => !forcing.has(step.sentinel)).map((step) => step.taken));

  const walk = (
    value: unknown,
    assignment: Assignment,
    forcing: Forcing | undefined,
    to: Keys,
    from: Keys,
    mappings: PlaceMapping[],
  ): { present: boolean; value?: unknown; taken: Condition } => {
    if (isAlternatives(value)) {
      const option = value.options.find((o) => selects(o.condition, o.path, assignment, forcing));
      // The options of a node hold wherever the node is reached; none holding
      // means the node is not reached here.
      if (!option) return { present: false, taken: FALSE };
      const own = forcing ? unforcedTaken(option.path, forcing) : option.condition;
      if (!option.present) return { present: false, taken: own };
      if (option.moved) {
        mappings.push({
          from: to,
          to: option.at,
          ...(option.metadataAt ? { metadataAt: option.metadataAt } : {}),
          ...(option.exact ? { exact: true as const } : {}),
        });
      }
      // Beneath an exact option every place is reported at the option itself.
      const inner = walk(option.value, assignment, forcing, to, option.at, option.exact ? [] : mappings);
      return { ...inner, taken: space.and(own, inner.taken) };
    }
    if (value === null || typeof value !== "object") return { present: true, value, taken: TRUE };
    const isUnwritten = unwritten.has(value);
    if (!isUnwritten && !built.has(value)) return { present: true, value, taken: TRUE };
    // A container's positions are where IT is written, whatever led here.
    const own = isUnwritten ? undefined : built.get(value)!;
    let taken = TRUE;
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      value.forEach((item, i) => {
        const r = walk(item, assignment, forcing, [...to, items.length], own ? [...own, i] : [], mappings);
        taken = space.and(taken, r.taken);
        if (!r.present) return;
        if (own && items.length !== i) mappings.push({ from: [...to, items.length], to: [...own, i] });
        items.push(r.value);
      });
      return { present: true, value: items, taken };
    }
    const record: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const r = walk(field, assignment, forcing, [...to, key], own ? [...own, key] : [], mappings);
      taken = space.and(taken, r.taken);
      if (r.present) record[key] = r.value;
    }
    return { present: true, value: record, taken };
  };

  const project = (value: unknown, assignment: Assignment, forcing?: Forcing): Projected => {
    const mappings: PlaceMapping[] = [];
    const root = value && typeof value === "object" ? roots.get(value) : undefined;
    if (root) mappings.push(root.mapping);
    const writtenAt = value && typeof value === "object" ? (built.get(value) ?? []) : [];
    const r = walk(value, assignment, forcing, [], writtenAt, mappings);
    return { ...r, places: { mappings, ...(root?.resource ? { resource: root.resource } : {}) } };
  };

  const at = (assignment: Assignment, forcing?: Forcing): ResourceManifest[] =>
    declarations
      .filter((d) => selects(d.condition, d.path, assignment, forcing))
      .map((d) => project(d.manifest, assignment, forcing).value as ResourceManifest);

  const carve = (value: unknown, paths: readonly Keys[], standIn: unknown): unknown => {
    if (paths.length === 0) return value;
    if (paths.some((path) => path.length === 0)) return standIn;
    if (isAlternatives(value)) {
      return new Alternatives(
        value.options.map((option) => (option.present ? { ...option, value: carve(option.value, paths, standIn) } : option)),
      );
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) return value;
    const beneath = (key: string | number) =>
      paths.filter((path) => String(path[0]) === String(key)).map((path) => path.slice(1));
    const copy = (Array.isArray(value) ? [] : {}) as Record<string | number, unknown>;
    for (const [key, field] of Object.entries(value)) copy[Array.isArray(value) ? Number(key) : key] = carve(field, beneath(key), standIn);
    const written = built.get(value);
    if (written) built.set(copy, written);
    else if (unwritten.has(value)) unwritten.add(copy);
    return copy;
  };

  const hold = (container: object, written?: Keys): void => {
    if (written) built.set(container, written);
    else unwritten.add(container);
  };

  const placeOf = (declaration: ResourceManifest) => {
    const root = roots.get(declaration);
    if (root) return { at: root.mapping.to, ...(root.resource ? { resource: root.resource } : {}) };
    return { at: built.get(declaration) ?? [] };
  };

  return {
    space,
    declarations,
    views,
    addView: (view) => views.push(view),
    hold,
    placeOf,
    elements,
    at,
    project,
    carve,
  };
}

/** What a view is known by beside its consumer: the body entries from its
 *  consumer to it, as its name spells them past its consumer's — the same
 *  wherever a builder made it. */
export function viewChainOf(view: ResourceManifest, root: ResourceManifest): string {
  const name = String(view.metadata?.name);
  const prefix = `${String(root.metadata?.name)}→`;
  if (!name.startsWith(prefix)) {
    throw new Error(`internal: the forward view '${name}' is not named for its consumer '${String(root.metadata?.name)}'.`);
  }
  return name.slice(prefix.length);
}
