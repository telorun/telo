/**
 * THE ONE EXPANSION OF A TEMPLATE BODY: every `!if` / `!switch` a `Telo.Definition`'s
 * body holds replaced by the branch it takes, and every `!for-each` at a list
 * position or under a `...` splice by what it emits per element — for one set of
 * decisions and one set of elements. The definition's check expands it per
 * definition variant over representative elements, a consumer's check per
 * consumer, and the kernel at an instance's `init()`, so the three cannot
 * disagree about what a body expands to.
 *
 * A construct the position reader (`expansion-sites.ts`) refused is left as
 * written. In a list the chosen branch is one item or none and a repeat's
 * element contributes each item of its `emit:`; as a field's value the chosen
 * branch is the value or the key is gone; at a declaration position the chosen
 * branch's `kind` and fields stand under the outermost tag's `metadata`; under a
 * splice each element contributes one entry, keyed by its `key:`, at the place
 * the `...` is written. A FAMILY (a `!for-each` at a declaration position)
 * declares one member per element, named by the family's name and the index
 * path of its own loops (`crons['nightlyReport']`); an indexed `!ref` an
 * emitted item holds becomes the resolved reference to the member its bindings
 * name. A repeat in a list of steps emits steps carrying `__emitted` in place
 * of a `name:` — `{ repeat, key }` for a named repeat, `{ site, keys }` for an
 * unnamed one.
 *
 * What the expansion records: where each expanded position was written (so a
 * diagnostic moves back to `emit.handler`, `then.access`), and the loop instance
 * every emitted item stands in (so its expressions are typed, or closed, over
 * the bindings in scope there).
 *
 * Browser-safe; re-imported by the kernel.
 */
import type { IndexKey, ResourceManifest } from "@telorun/sdk";
import {
  EMITTED_STEP_MEMBER,
  indexLiteral as sdkIndexLiteral,
  isCompiledValue,
  renderIndexPath,
} from "@telorun/sdk";
import {
  expansionTagOf,
  isExpansionSentinel,
  isRefSentinel,
  isTaggedSentinel,
  SPLICE_KEY,
  type ExpansionSentinel,
} from "@telorun/templating";
import { branchKeys, branchValue } from "./choice-reading.js";
import {
  Alternatives,
  heldNode,
  isEverywhere,
  meet,
  EVERYWHERE,
  type AlternativeOption,
  type DeadBranchWorld,
  type Forcing,
  type Holding,
} from "./conditioned-expansion.js";
import type { Assignment } from "./configuration-dimensions.js";
import type { ConditionSpace } from "./presence-condition.js";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import { isResolvedReference, resolvedReference, type ResolvedReference } from "./resolved-reference.js";
import type { ExpansionPosition } from "./expansion-sites.js";

type Key = string | number;
type Keys = readonly Key[];

/** A value a forward carries into the expanded body: what the consumer wrote at
 *  `keys` of `holder`, handed through untouched. */
export interface ConsumerForward {
  readonly __templateForward: {
    readonly holder: ResourceManifest;
    readonly keys: readonly (string | number)[];
    /** LIFTED: every value the place holds, each where it holds and where it
     *  is written in its holder's document. */
    readonly outcomes?: readonly {
      readonly holder: ResourceManifest;
      readonly value: unknown;
      readonly written: readonly (string | number)[];
      readonly holding: Holding;
    }[];
  };
}

export function isConsumerForward(value: unknown): value is ConsumerForward {
  return !!value && typeof value === "object" && "__templateForward" in value;
}

/** A `Telo.Definition`'s fields that make up its template body. */
export const TEMPLATE_BODY_FIELDS: readonly string[] = [
  "resources",
  "targets",
  "invoke",
  "run",
  "provide",
  "mount",
  "inputs",
  "result",
];

/** One loop's binding: the name it binds, and what it iterates. */
export interface LoopBinding {
  /** `each`, or the name `as:` gives. */
  readonly name: string;
  /** The tag, as loaded. */
  readonly sentinel: ExpansionSentinel;
  /** Where the tag is written in its definition. */
  readonly site: Keys;
  /** True for a map source: its elements carry a `key`. */
  readonly keyed: boolean;
  /** The source's element schema, when the source resolved. */
  readonly element: Record<string, any> | undefined;
}

/** One element a loop iterates. */
export interface LoopElement {
  /** A map source's key. */
  readonly key?: string;
  readonly index: number;
  readonly value: unknown;
  /** `value` as an expression reads it (`declaredCelViewAt`, after the step
   *  engine's literal rule); absent, the value itself. */
  readonly view?: unknown;
  /** The one element a definition checked with no consumer stands each loop
   *  in for: its index text is `[⟨key⟩]` / `[⟨index⟩]`, which no real element's
   *  identity can equal. */
  readonly representative?: true;
  /** A LIFTED expansion's element: where it is an element at this index. */
  readonly holding?: Holding;
}

export interface LoopFrame {
  readonly binding: LoopBinding;
  readonly element: LoopElement;
}

/** The loops an emitted item stands in, outermost first. */
export type LoopInstance = readonly LoopFrame[];

/** What decides an expansion. Each answer may be `undefined`: the construct
 *  is then left as written. */
export interface TemplateExpander {
  /** The position the reader found a construct at, or undefined when it
   *  refused it. */
  positionOf(sentinel: ExpansionSentinel): ExpansionPosition | undefined;
  /** The branch a choice takes in `instance` — a branch id (`then`, `else`,
   *  `case:<key>`, `default`), or `null` for none. */
  decide(sentinel: ExpansionSentinel, instance: LoopInstance): string | null | undefined;
  /** What a repeat iterates in `instance`. */
  elements(
    sentinel: ExpansionSentinel,
    instance: LoopInstance,
  ): { readonly binding: LoopBinding; readonly elements: readonly LoopElement[] } | undefined;
  /** The key a splice's element emits; undefined leaves the element out. */
  key(sentinel: ExpansionSentinel, instance: LoopInstance): string | undefined;
  /** An expression inside an emitted item, as it stands in `instance` — the
   *  consumer's check forwards a binding's value, the kernel closes it over the
   *  bindings. Absent: left as written. */
  emitted?(value: unknown, instance: LoopInstance, at: Keys): unknown;
  /** LIFTED, over every configuration at once: how holdings meet. With it, a
   *  choice taking several branches is an {@link Alternatives} node, one option
   *  per branch, and an item emitted for an element holding somewhere stands
   *  behind a one-option node. */
  readonly space?: ConditionSpace;
  /** LIFTED: every branch a choice takes, each with where — read in place of
   *  {@link decide}; undefined leaves the choice to `decide`. */
  branches?(sentinel: ExpansionSentinel, instance: LoopInstance): readonly BranchOutcome[] | undefined;
  /** LIFTED: every key a splice's element emits, each with where — read in
   *  place of {@link key}. */
  keys?(sentinel: ExpansionSentinel, instance: LoopInstance): readonly { readonly key: string; readonly holding: Holding }[];
}

/** One branch a lifted choice takes, and where: `undefined` leaves the choice
 *  as written there. A branch taken nowhere is UNREACHABLE, with a witness
 *  reaching its choice and the choices forced to take it there. */
export interface BranchOutcome {
  readonly branch: string | null | undefined;
  readonly holding: Holding;
  readonly unreachable?: true;
  readonly baseline?: Assignment;
  readonly forcing?: Forcing;
  readonly world?: DeadBranchWorld;
}

/** What marks an option no assignment takes. */
type DeadMarks = Pick<AlternativeOption, "unreachable" | "baseline" | "forcing" | "world">;

function deadMarks(outcome: BranchOutcome): DeadMarks {
  return {
    ...(outcome.unreachable ? { unreachable: true as const } : {}),
    ...(outcome.baseline ? { baseline: outcome.baseline } : {}),
    ...(outcome.forcing ? { forcing: outcome.forcing } : {}),
    ...(outcome.world ? { world: outcome.world } : {}),
  };
}

/** Where an expanded position was written. */
export interface TemplateMapping {
  readonly from: Keys;
  readonly to: Keys;
  /** For a chosen declaration: where its `metadata` is written (the tag's). */
  readonly metadataAt?: Keys;
}

/** An emitted item, by its expanded position, and the loops it stands in. */
export interface EmittedItem {
  readonly at: Keys;
  /** Where the item is written in the definition (inside the tag's `emit:`). */
  readonly written: Keys;
  readonly instance: LoopInstance;
}

/** A key a splice emitted, for the duplicate and numeric-key refusals. */
export interface SplicedKey {
  /** The mapping holding the splice, expanded. */
  readonly container: Keys;
  readonly key: string;
  readonly sentinel: ExpansionSentinel;
  readonly instance: LoopInstance;
}

/** One member a family declared for one element. */
export interface FamilyMember {
  /** The member's identity: the family's name and its own loops' index path. */
  readonly name: string;
  /** The keys of the family's own loops, outermost first. */
  readonly keys: readonly IndexKey[];
  readonly kind: unknown;
  /** Where the member stands in the expanded body. */
  readonly at: Keys;
}

/** A family as one expansion declared it: the ONE record of its members, keyed
 *  by element — what a reference to a member and every reader of the family's
 *  members read. */
export interface FamilyExpansion {
  readonly name: string;
  /** Where the family's `metadata` is written. */
  readonly metadataAt: Keys;
  readonly members: readonly FamilyMember[];
}

export interface TemplateBodyExpansion {
  /** The definition, its body expanded. */
  readonly definition: ResourceManifest;
  /** Every family the body declared, by where its `metadata` is written. */
  readonly families: ReadonlyMap<string, FamilyExpansion>;
  readonly mappings: readonly TemplateMapping[];
  readonly emitted: readonly EmittedItem[];
  readonly splicedKeys: readonly SplicedKey[];
  /** Every literal key of a mapping holding a splice, by the mapping. */
  readonly literalKeys: ReadonlyMap<string, readonly string[]>;
  /** A path in the expanded definition, at its written place. */
  relocate(path: string): string;
  /** The loops the expression at `path` (expanded) stands in. */
  instanceAt(path: string): LoopInstance;
}

/** A record of one walk of a body, with where it holds: what the walk stood
 *  under when it made it — everywhere, unless the walk is lifted. */
export interface HeldRecord<T> {
  readonly item: T;
  readonly holding: Holding;
}

/** A mapping a walk made; a CONDITIONAL one is dropped where it moves nothing,
 *  as only a list item's or a construct left in place can. */
export interface RawMapping extends HeldRecord<TemplateMapping> {
  readonly conditional: boolean;
}

/** One member a family declared, with the family it is filed under. */
export interface FamilyMemberRecord {
  readonly family: string;
  readonly metadataAt: Keys;
  readonly member: FamilyMember;
}

/** An indexed `!ref` an emitted item holds, resolved to a member by name; its
 *  kind is the member's, known once every member is. */
export interface MemberReference {
  readonly ref: ResolvedReference;
  readonly name: string;
}

/**
 * What one walk of a body records, before its member references take their
 * members' kinds and its inline targets are hoisted ({@link assembleTemplateBody}).
 * Decided, each record holds everywhere; LIFTED, the body holds an
 * {@link Alternatives} node at every place a choice decides and each record
 * holds where the walk stood when it made it — the positions of both are the
 * lifted body's, every item of a list kept, so a projection moves them.
 */
export interface RawTemplateBody {
  /** The definition as written. */
  readonly definition: ResourceManifest;
  /** Its fields, each body field expanded — absent where nothing is left. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Whether a body field differs from the one written. */
  readonly changed: boolean;
  readonly mappings: readonly RawMapping[];
  readonly emitted: readonly HeldRecord<EmittedItem>[];
  readonly splicedKeys: readonly HeldRecord<SplicedKey>[];
  /** Every literal key of a mapping holding a splice, by the mapping. */
  readonly literalKeys: readonly HeldRecord<{ readonly container: Keys; readonly keys: readonly string[] }>[];
  readonly members: readonly HeldRecord<FamilyMemberRecord>[];
  readonly memberRefs: readonly MemberReference[];
  /** Every container the walk built, with the written one it stands for — an
   *  absent entry for one with none, a declaration a branch makes. */
  readonly built: WeakMap<object, unknown>;
}

/** Expand `definition`'s body by `expander`. A definition holding no
 *  construct is returned as is. */
export function expandTemplateBody(
  definition: ResourceManifest,
  expander: TemplateExpander,
): TemplateBodyExpansion {
  return assembleTemplateBody(walkTemplateBody(definition, expander));
}

/** Walk `definition`'s body by `expander`, recording what it finds. */
export function walkTemplateBody(definition: ResourceManifest, expander: TemplateExpander): RawTemplateBody {
  const mappings: RawMapping[] = [];
  const emitted: HeldRecord<EmittedItem>[] = [];
  const splicedKeys: HeldRecord<SplicedKey>[] = [];
  const literalKeys: HeldRecord<{ container: Keys; keys: string[] }>[] = [];
  const members: HeldRecord<FamilyMemberRecord>[] = [];
  const memberRefs: MemberReference[] = [];
  const built = new WeakMap<object, unknown>();

  type Result = { present: boolean; value?: unknown };

  // A lifted expansion's holding where it stands now: every option taken on
  // the way met.
  let within: Holding = EVERYWHERE;
  const map = (mapping: TemplateMapping, conditional = false, holding: Holding = within) =>
    mappings.push({ item: mapping, holding, conditional });
  const under = <T>(holding: Holding, body: () => T): T => {
    const saved = within;
    within = holding;
    try {
      return body();
    } finally {
      within = saved;
    }
  };
  /** What a choice takes: one branch, or — lifted — several, each where it
   *  holds. */
  const decision = (
    sentinel: ExpansionSentinel,
    instance: LoopInstance,
  ):
    | { readonly branch: string | null | undefined; readonly outcomes?: undefined }
    | { readonly outcomes: readonly BranchOutcome[] } => {
    const outcomes = expander.branches?.(sentinel, instance);
    if (!outcomes) return { branch: expander.decide(sentinel, instance) };
    if (outcomes.length === 1 && isEverywhere(outcomes[0]!.holding)) return { branch: outcomes[0]!.branch };
    return { outcomes };
  };
  /** Each item pushed onto `out` from `start` on, held where `holding` holds. */
  const holdItems = (out: unknown[], start: number, holding: Holding, marks: DeadMarks = {}): void => {
    if (holding === within) return;
    for (let k = start; k < out.length; k++) {
      out[k] = new Alternatives([{ ...heldNode(out[k], holding, [], false).options[0]!, ...marks }]);
    }
  };
  const optionOf = (holding: Holding, r: Result, at: Keys, marks: DeadMarks): AlternativeOption => ({
    condition: holding.condition,
    taken: holding.condition,
    path: holding.path,
    present: r.present,
    ...(r.present ? { value: r.value } : {}),
    at,
    moved: false,
    ...marks,
  });
  /** `holding` met with where the expansion stands. */
  const met = (holding: Holding | undefined): Holding =>
    holding === undefined || isEverywhere(holding) ? within : meet(expander.space, within, holding);

  const expandChoice = (
    sentinel: ExpansionSentinel,
    from: Keys,
    to: Keys,
    instance: LoopInstance,
    position: ExpansionPosition,
    metadata: { value: unknown; at: Keys } | undefined,
  ): Result => {
    const decided = decision(sentinel, instance);
    if (decided.outcomes) {
      const options = decided.outcomes.map((outcome) => {
        const { branch } = outcome;
        const h = met(outcome.holding);
        const r = under(h, () => expandBranch(sentinel, branch, from, to, instance, position, metadata));
        return optionOf(h, r, branch === null || branch === undefined ? from : [...from, ...branchKeys(branch)], deadMarks(outcome));
      });
      return { present: true, value: new Alternatives(options) };
    }
    return expandBranch(sentinel, decided.branch, from, to, instance, position, metadata);
  };

  const expandBranch = (
    sentinel: ExpansionSentinel,
    branch: string | null | undefined,
    from: Keys,
    to: Keys,
    instance: LoopInstance,
    position: ExpansionPosition,
    metadata: { value: unknown; at: Keys } | undefined,
  ): Result => {
    if (branch === undefined) return { present: true, value: sentinel };
    if (branch === null) return { present: false };
    const chosen = branchValue(sentinel, branch);
    if (!chosen.written) return { present: false };
    const at = [...from, ...branchKeys(branch)];
    const own = (sentinel as Record<string, unknown>).metadata;
    const named = own !== undefined ? { value: own, at: from } : metadata;
    const inner = chosen.value;
    if (isChoice(inner) && expander.positionOf(inner as ExpansionSentinel) !== undefined) {
      return expandChoice(inner as ExpansionSentinel, at, to, instance, position, named);
    }
    if (named && isDeclarationPosition(position)) {
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) return { present: false };
      map({ from: to, to: at, metadataAt: named.at });
      const { kind, ...fields } = inner as Record<string, unknown>;
      const declared: Record<string, unknown> = { kind, metadata: named.value };
      built.set(declared, undefined);
      for (const [key, field] of Object.entries(fields)) {
        if (key === "metadata") continue;
        const r = expandValue(field, [...at, key], [...to, key], instance);
        if (r.present) declared[key] = r.value;
      }
      return { present: true, value: declared };
    }
    map({ from: to, to: at });
    return expandValue(inner, at, to, instance);
  };

  /** Push what `item` (written at `from`) contributes to the list `out`
   *  (expanded at `list`). */
  const expandListItem = (
    item: unknown,
    from: Keys,
    list: Keys,
    out: unknown[],
    instance: LoopInstance,
    metadata?: { value: unknown; at: Keys },
  ): void => {
    if (isExpansionSentinel(item)) {
      const position = expander.positionOf(item);
      const tag = expansionTagOf(item);
      if (position !== undefined && (tag === "if" || tag === "switch")) {
        const decided = decision(item, instance);
        if (decided.outcomes) {
          for (const outcome of decided.outcomes) {
            const h = met(outcome.holding);
            const start = out.length;
            under(h, () => listBranch(item, outcome.branch, from, list, out, instance, position, metadata));
            holdItems(out, start, h, deadMarks(outcome));
          }
          return;
        }
        listBranch(item, decided.branch, from, list, out, instance, position, metadata);
        return;
      }
      if (tag === "for-each" && position !== undefined && isDeclarationPosition(position)) {
        const own = (item as Record<string, unknown>).metadata;
        const named = own !== undefined ? { value: own, at: from } : metadata;
        if (!named) {
          pushAs(item, from, list, out);
          return;
        }
        expandFamily(item, from, list, out, instance, named, []);
        return;
      }
      if (position === "step" && tag === "for-each") {
        expandStepRepeat(item, from, list, out, instance);
        return;
      }
      if (position === "list-item" && tag === "for-each") {
        const iterated = expander.elements(item, instance);
        if (!iterated) {
          pushAs(item, from, list, out);
          return;
        }
        const emit = (item as Record<string, unknown>).emit;
        for (const element of iterated.elements) {
          const frame: LoopFrame = { binding: iterated.binding, element };
          const inner = [...instance, frame];
          const items: [unknown, Keys][] = Array.isArray(emit)
            ? emit.map((e, j) => [e, [...from, "emit", j]])
            : [[emit, [...from, "emit"]]];
          const h = met(element.holding);
          const elementStart = out.length;
          under(h, () => {
            for (const [emitItem, written] of items) {
              const start = out.length;
              expandListItem(emitItem, written, list, out, inner);
              for (let k = start; k < out.length; k++) {
                emitted.push({ item: { at: [...list, k], written, instance: inner }, holding: within });
              }
            }
          });
          holdItems(out, elementStart, h);
        }
        return;
      }
      pushAs(item, from, list, out);
      return;
    }
    const to = [...list, out.length];
    map({ from: to, to: from }, true);
    const r = expandValue(item, from, to, instance);
    if (r.present) out.push(r.value);
  };

  /** What one branch of a choice at a list position contributes to `out`. */
  const listBranch = (
    item: ExpansionSentinel,
    branch: string | null | undefined,
    from: Keys,
    list: Keys,
    out: unknown[],
    instance: LoopInstance,
    position: ExpansionPosition,
    metadata: { value: unknown; at: Keys } | undefined,
  ): void => {
    if (branch === undefined) {
      pushAs(item, from, list, out);
      return;
    }
    if (branch === null) return;
    const chosen = branchValue(item, branch);
    if (!chosen.written) return;
    const own = (item as Record<string, unknown>).metadata;
    const named = own !== undefined ? { value: own, at: from } : metadata;
    const at = [...from, ...branchKeys(branch)];
    if (isExpansionSentinel(chosen.value)) {
      expandListItem(chosen.value, at, list, out, instance, named);
      return;
    }
    if (named && isDeclarationPosition(position)) {
      const r = expandChoiceDeclaration(chosen.value, at, [...list, out.length], instance, named);
      if (r.present) out.push(r.value);
      return;
    }
    const to = [...list, out.length];
    map({ from: to, to: at });
    const r = expandValue(chosen.value, at, to, instance);
    if (r.present) out.push(r.value);
  };

  /** The members a family declares, one per element of each of its loops. */
  const expandFamily = (
    sentinel: ExpansionSentinel,
    from: Keys,
    list: Keys,
    out: unknown[],
    instance: LoopInstance,
    named: { value: unknown; at: Keys },
    depth: readonly LoopFrame[],
  ): void => {
    const iterated = expander.elements(sentinel, instance);
    if (!iterated) {
      if (depth.length === 0) pushAs(sentinel, from, list, out);
      return;
    }
    for (const element of iterated.elements) {
      const frame: LoopFrame = { binding: iterated.binding, element };
      const h = met(element.holding);
      const start = out.length;
      under(h, () =>
        expandFamilyEmit(
          (sentinel as Record<string, unknown>).emit,
          [...from, "emit"],
          list,
          out,
          [...instance, frame],
          named,
          [...depth, frame],
        ),
      );
      holdItems(out, start, h);
    }
  };

  const expandFamilyEmit = (
    value: unknown,
    at: Keys,
    list: Keys,
    out: unknown[],
    instance: LoopInstance,
    named: { value: unknown; at: Keys },
    depth: readonly LoopFrame[],
  ): void => {
    if (isExpansionSentinel(value)) {
      const tag = expansionTagOf(value);
      if (tag === "for-each" && expander.positionOf(value) !== undefined) {
        expandFamily(value, at, list, out, instance, named, depth);
        return;
      }
      if ((tag === "if" || tag === "switch") && expander.positionOf(value) !== undefined) {
        const emitBranch = (branch: string | null | undefined) => {
          if (branch === undefined || branch === null) return;
          const chosen = branchValue(value, branch);
          if (!chosen.written) return;
          expandFamilyEmit(chosen.value, [...at, ...branchKeys(branch)], list, out, instance, named, depth);
        };
        const decided = decision(value, instance);
        if (!decided.outcomes) {
          emitBranch(decided.branch);
          return;
        }
        for (const outcome of decided.outcomes) {
          const h = met(outcome.holding);
          const start = out.length;
          under(h, () => emitBranch(outcome.branch));
          holdItems(out, start, h, deadMarks(outcome));
        }
      }
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const metadata = (named.value ?? {}) as Record<string, unknown>;
    const family = String(metadata.name);
    const keys = depth.map((frame) => frameKey(frame.element));
    const name = `${family}${depth.map((frame) => elementIndexText(frame.element)).join("")}`;
    const to = [...list, out.length];
    const r = expandChoiceDeclaration(value, at, to, instance, {
      value: { ...metadata, name },
      at: named.at,
    });
    if (!r.present) return;
    out.push(r.value);
    emitted.push({ item: { at: to, written: at, instance }, holding: within });
    members.push({
      item: { family, metadataAt: named.at, member: { name, keys, kind: (value as { kind?: unknown }).kind, at: to } },
      holding: within,
    });
  };

  /** The steps a repeat in a list of steps emits, each carrying its identity in
   *  place of a `name:`. */
  const expandStepRepeat = (
    sentinel: ExpansionSentinel,
    from: Keys,
    list: Keys,
    out: unknown[],
    instance: LoopInstance,
  ): void => {
    const iterated = expander.elements(sentinel, instance);
    if (!iterated) {
      pushAs(sentinel, from, list, out);
      return;
    }
    const body = sentinel as Record<string, unknown>;
    const repeat = typeof body.name === "string" ? body.name : undefined;
    const emit = body.emit;
    for (const element of iterated.elements) {
      const frame: LoopFrame = { binding: iterated.binding, element };
      const inner = [...instance, frame];
      const items: [unknown, Keys][] = Array.isArray(emit)
        ? emit.map((e, j) => [e, [...from, "emit", j]])
        : [[emit, [...from, "emit"]]];
      const h = met(element.holding);
      const elementStart = out.length;
      const saved = within;
      within = h;
      for (const [emitItem, written] of items) {
        const start = out.length;
        expandListItem(emitItem, written, list, out, inner);
        const identity =
          repeat !== undefined
            ? { repeat, key: frameKey(element) }
            : { site: siteOf(written), keys: inner.map((f) => frameKey(f.element)) };
        const identified = (step: unknown): unknown => {
          // A lifted choice's node: each step it may be carries the identity.
          if (step instanceof Alternatives) {
            return new Alternatives(step.options.map((o) => (o.present ? { ...o, value: identified(o.value) } : o)));
          }
          if (!step || typeof step !== "object" || Array.isArray(step) || EMITTED_STEP_MEMBER in step) return step;
          const copy = { ...(step as Record<string, unknown>), [EMITTED_STEP_MEMBER]: identity };
          built.set(copy, undefined);
          return copy;
        };
        for (let k = start; k < out.length; k++) {
          out[k] = identified(out[k]);
          emitted.push({ item: { at: [...list, k], written, instance: inner }, holding: within });
        }
      }
      within = saved;
      holdItems(out, elementStart, h);
    }
  };

  const pushAs = (item: unknown, from: Keys, list: Keys, out: unknown[]) => {
    map({ from: [...list, out.length], to: from }, true);
    out.push(item);
  };

  const expandChoiceDeclaration = (
    branch: unknown,
    at: Keys,
    to: Keys,
    instance: LoopInstance,
    named: { value: unknown; at: Keys },
  ): Result => {
    if (!branch || typeof branch !== "object" || Array.isArray(branch)) return { present: false };
    map({ from: to, to: at, metadataAt: named.at });
    const { kind, ...fields } = branch as Record<string, unknown>;
    const declared: Record<string, unknown> = { kind, metadata: named.value };
    built.set(declared, undefined);
    for (const [key, field] of Object.entries(fields)) {
      if (key === "metadata") continue;
      const r = expandValue(field, [...at, key], [...to, key], instance);
      if (r.present) declared[key] = r.value;
    }
    return { present: true, value: declared };
  };

  const expandValue = (value: unknown, from: Keys, to: Keys, instance: LoopInstance): Result => {
    if (isExpansionSentinel(value)) {
      const position = expander.positionOf(value);
      const tag = expansionTagOf(value);
      if (position !== undefined && (tag === "if" || tag === "switch")) {
        return expandChoice(value, from, to, instance, position, undefined);
      }
      return { present: true, value };
    }
    if (value === null || typeof value !== "object") return { present: true, value };
    if (isRefSentinel(value)) {
      const member = memberReference(value, instance);
      if (member) return { present: true, value: member };
    }
    if (isTaggedSentinel(value) || isCompiledValue(value)) {
      return {
        present: true,
        value: instance.length > 0 && expander.emitted ? expander.emitted(value, instance, to) : value,
      };
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      value.forEach((item, i) => expandListItem(item, [...from, i], to, out, instance));
      if (out.length === value.length && out.every((v, i) => v === value[i])) return { present: true, value };
      built.set(out, value);
      return { present: true, value: out };
    }
    const record: Record<string, unknown> = {};
    let changed = false;
    let spliced = false;
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (key === SPLICE_KEY) {
        const repeats = Array.isArray(field) ? field : [field];
        const expandable = repeats.every(
          (r) => expansionTagOf(r) === "for-each" && expander.positionOf(r as ExpansionSentinel) === "splice",
        );
        if (!expandable) {
          record[key] = field;
          continue;
        }
        spliced = true;
        changed = true;
        repeats.forEach((repeat, r) => {
          const sentinel = repeat as ExpansionSentinel;
          const written = Array.isArray(field) ? [...from, key, r] : [...from, key];
          const iterated = expander.elements(sentinel, instance);
          if (!iterated) return;
          for (const element of iterated.elements) {
            const inner = [...instance, { binding: iterated.binding, element }];
            const keyed = expander.keys
              ? expander.keys(sentinel, inner)
              : [{ key: expander.key(sentinel, inner), holding: EVERYWHERE }];
            for (const { key: emittedKey, holding } of keyed) {
              if (emittedKey === undefined) continue;
              const outer = within;
              const h = meet(expander.space, met(element.holding), holding);
              splicedKeys.push({ item: { container: to, key: emittedKey, sentinel, instance: inner }, holding: h });
              const at = [...to, emittedKey];
              const emitAt = [...written, "emit"];
              map({ from: at, to: emitAt }, false, h);
              const result = under(h, () => expandValue((sentinel as Record<string, unknown>).emit, emitAt, at, inner));
              if (!result.present) continue;
              record[emittedKey] = h === outer ? result.value : heldAlongside(record[emittedKey], result.value, h);
              emitted.push({ item: { at, written: emitAt, instance: inner }, holding: h });
            }
          }
        });
        continue;
      }
      const r = expandValue(field, [...from, key], [...to, key], instance);
      if (!r.present) {
        changed = true;
        continue;
      }
      if (r.value !== field) changed = true;
      record[key] = r.value;
    }
    if (spliced) {
      literalKeys.push({
        item: { container: to, keys: Object.keys(value as Record<string, unknown>).filter((k) => k !== SPLICE_KEY) },
        holding: within,
      });
    }
    if (!changed) return { present: true, value };
    built.set(record, value);
    return { present: true, value: record };
  };

  /** `value` held where `holding` holds, beside what an earlier element
   *  already emitted under the same key. */
  const heldAlongside = (earlier: unknown, value: unknown, holding: Holding): Alternatives => {
    const node = heldNode(value, holding, [], false);
    return earlier instanceof Alternatives ? new Alternatives([...earlier.options, ...node.options]) : node;
  };

  /** The resolved reference an indexed `!ref` in an emitted item names: the
   *  member of the family its head names, keyed by the elements its bindings
   *  stand at — or undefined when a binding is not in scope here, which the
   *  definition's check refuses. */
  const memberReference = (value: unknown, instance: LoopInstance): ResolvedReference | undefined => {
    const target = refSentinelTarget(value);
    if (!target || target.indexes.length === 0) return undefined;
    if (target.alias !== undefined && target.alias !== "Self") return undefined;
    let text = target.name;
    for (const index of target.indexes) {
      const frame = [...instance].reverse().find((f) => f.binding.name === index.binding);
      if (!frame) return undefined;
      const element = frame.element;
      if (index.member === "key") {
        if (element.key === undefined) return undefined;
        text += element.representative ? "[⟨key⟩]" : sdkIndexLiteral(element.key);
      } else {
        text += element.representative ? "[⟨index⟩]" : sdkIndexLiteral(element.index);
      }
    }
    const ref = resolvedReference("", text);
    memberRefs.push({ ref, name: text });
    return ref;
  };

  const fields: Record<string, unknown> = {};
  let changed = false;
  for (const [key, field] of Object.entries(definition)) {
    if (!TEMPLATE_BODY_FIELDS.includes(key)) {
      fields[key] = field;
      continue;
    }
    const r = expandValue(field, [key], [key], []);
    if (!r.present) {
      changed = true;
      continue;
    }
    if (r.value !== field) changed = true;
    fields[key] = r.value;
  }
  return { definition, fields, changed, mappings, emitted, splicedKeys, literalKeys, members, memberRefs, built };
}

/** The expansion a walk's records make: each member reference given its
 *  member's kind, every inline target hoisted, the records in expanded
 *  positions. */
export function assembleTemplateBody(raw: RawTemplateBody): TemplateBodyExpansion {
  const { definition } = raw;
  const mappings = raw.mappings.flatMap(({ item, conditional }) =>
    conditional && sameKeys(item.from, item.to) ? [] : [item],
  );
  const emitted = raw.emitted.map((e) => e.item);
  const splicedKeys = raw.splicedKeys.map((s) => s.item);
  const literalKeys = new Map<string, readonly string[]>();
  for (const { item } of raw.literalKeys) literalKeys.set(pathText(item.container), item.keys);
  const families = new Map<string, { name: string; metadataAt: Keys; members: FamilyMember[] }>();
  for (const { item } of raw.members) {
    const key = pathText(item.metadataAt);
    const record = families.get(key) ?? { name: item.family, metadataAt: item.metadataAt, members: [] };
    families.set(key, record);
    record.members.push(item.member);
  }
  const fields: Record<string, unknown> = { ...raw.fields };
  const instanceAt = (path: string): LoopInstance => {
    const keys = parseKeys(path);
    let best: EmittedItem | undefined;
    for (const item of emitted) {
      if (startsWith(keys, item.at) && (!best || item.at.length > best.at.length)) best = item;
    }
    return best?.instance ?? [];
  };
  const memberKinds = new Map<string, unknown>();
  for (const family of families.values()) for (const member of family.members) memberKinds.set(member.name, member.kind);
  for (const { ref, name } of raw.memberRefs) {
    const kind = memberKinds.get(name);
    if (typeof kind === "string") ref.kind = kind;
  }
  const hoisted = hoistInlineTargets(fields, mappings, emitted, instanceAt);
  if (hoisted) Object.assign(fields, hoisted);
  const expanded = raw.changed || hoisted ? (fields as ResourceManifest) : definition;

  const relocate = (path: string): string => relocateTemplatePath(path, mappings);
  return {
    definition: expanded,
    families,
    mappings,
    emitted,
    splicedKeys,
    literalKeys,
    relocate,
    instanceAt,
  };
}

/**
 * An inline declaration an expanded `targets:` holds becomes a `resources:`
 * entry of its own, under its generated identity, and its item the reference to
 * it — so it is created, checked and started as every entry is. Returns the two
 * fields it rewrote, or undefined when there is nothing to hoist.
 */
function hoistInlineTargets(
  body: Record<string, unknown>,
  mappings: TemplateMapping[],
  emitted: EmittedItem[],
  instanceAt: (path: string) => LoopInstance,
): { targets: unknown[]; resources: unknown[] } | undefined {
  const targets = body.targets;
  if (!Array.isArray(targets)) return undefined;
  const inline = targets.some(isInlineDeclaration);
  if (!inline) return undefined;
  const resources = Array.isArray(body.resources) ? [...body.resources] : [];
  const parentName = (body.metadata as { name?: unknown } | undefined)?.name;
  const items = targets.map((item, i) => {
    if (!isInlineDeclaration(item)) return item;
    const written = parseKeys(relocateTemplatePath(`targets[${i}]`, mappings));
    const instance = instanceAt(`targets[${i}]`);
    const name = emittedIdentity(written, instance);
    const at = resources.length;
    const fields: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    delete fields.metadata;
    resources.push({
      ...fields,
      metadata: {
        name,
        xTeloOrigin: {
          parentKind: "Telo.Definition",
          parentName,
          pathFromParent: pathText(written),
          keysFromParent: written,
        },
      },
    });
    mappings.push({ from: ["resources", at], to: written });
    if (instance.length > 0) emitted.push({ at: ["resources", at], written, instance });
    return resolvedReference((item as { kind: string }).kind, name);
  });
  return { targets: items, resources };
}

function isInlineDeclaration(item: unknown): boolean {
  return (
    !!item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    typeof (item as { kind?: unknown }).kind === "string" &&
    !isTaggedSentinel(item) &&
    !isResolvedReference(item) &&
    !isExpansionSentinel(item)
  );
}

function isChoice(value: unknown): boolean {
  const tag = expansionTagOf(value);
  return tag === "if" || tag === "switch";
}

function isDeclarationPosition(position: ExpansionPosition): boolean {
  return position === "template-resource" || position === "scope-member" || position === "document";
}

function sameKeys(a: Keys, b: Keys): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function startsWith(keys: Keys, prefix: Keys): boolean {
  return prefix.length <= keys.length && prefix.every((key, i) => keys[i] === key);
}

/** `["routes", 0, "handler"]` → `routes[0].handler`. A key that is no
 *  identifier is written as `['…']`, so a spliced key holding a dot stays one. */
export function pathText(keys: Keys): string {
  let out = "";
  for (const key of keys) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out.length === 0 ? key : `.${key}`;
  }
  return out;
}

/** `a.b[0].c` → `["a", "b", 0, "c"]`. */
export function parseKeys(path: string): Key[] {
  const keys: Key[] = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (match[2] !== undefined) keys.push(Number(match[2]));
    else keys.push(match[1]!);
  }
  return keys;
}

/** A path inside an expanded body at its written place: the longest expanded
 *  prefix a mapping covers says where the rest was written. */
export function relocateTemplatePath(path: string, mappings: readonly TemplateMapping[]): string {
  const keys = parseKeys(path);
  let match: TemplateMapping | undefined;
  for (const mapping of mappings) {
    if (startsWith(keys, mapping.from) && (!match || mapping.from.length > match.from.length)) match = mapping;
  }
  if (!match) return path;
  const rest = keys.slice(match.from.length);
  return pathText(
    match.metadataAt && rest[0] === "metadata" ? [...match.metadataAt, ...rest] : [...match.to, ...rest],
  );
}

/** The key an element stands at in an index path: a map element's key, a list
 *  element's index. */
export function frameKey(element: LoopElement): IndexKey {
  return element.key ?? element.index;
}

/** The index text of one element — the SDK's one renderer, or the
 *  representative's `[⟨key⟩]` / `[⟨index⟩]`. */
export function elementIndexText(element: LoopElement): string {
  if (element.representative) return element.key !== undefined ? "[⟨key⟩]" : "[⟨index⟩]";
  return renderIndexPath([frameKey(element)]);
}

/** The head of an emitted item's identity: the place it is written. */
function siteOf(written: Keys): string {
  return written.map(String).join("_").replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * The identity of an inline declaration an emitted item holds: the place the
 * declaration is written in the definition (its holder site is the first key), and the index path of the
 * element it was emitted for — never its position in the expanded list, which
 * moves when a literal sibling is added. One builder for the analysis and the
 * kernel.
 */
export function emittedIdentity(written: Keys, instance: LoopInstance): string {
  return `${siteOf(written)}${instance.map((frame) => elementIndexText(frame.element)).join("")}`;
}

/** How an emitted item is named in a message: `the Acme.Job emitted for
 *  jobs.nightlyReport`. */
export function describeEmitted(kind: string, sourcePath: string, instance: LoopInstance): string {
  const last = instance[instance.length - 1]?.element;
  const at = last ? (last.key !== undefined ? `${sourcePath}.${last.key}` : `${sourcePath}[${last.index}]`) : sourcePath;
  return `the ${kind} emitted for ${at}`;
}

/**
 * The name of the inline declaration at `path` of an expanded body, when an
 * emitted item holds it: `emittedIdentity` of the place it is written and the
 * loops it stands in. The one call the analysis and the kernel both name an
 * extracted emitted declaration by; undefined when no emitted item holds `path`.
 */
export function emittedInlineName(expansion: TemplateBodyExpansion, path: Keys): string | undefined {
  const text = pathText(path);
  const instance = expansion.instanceAt(text);
  return instance.length === 0 ? undefined : emittedIdentity(parseKeys(expansion.relocate(text)), instance);
}
