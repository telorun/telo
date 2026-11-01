/**
 * ONE CONSUMER'S EXPANSION OF A TEMPLATE BODY — the single function the
 * analyzer's consumer check and the kernel's `init()` both call.
 *
 * It owns every structural decision and refusal: each choice decided by the
 * consumer's literal values (read through any chain of bare `self.` /
 * `<binding>.value.` forwards, across a reference into a declaration of the
 * consumer's own module — as written, its kind's defaults filled by one filler
 * over the effective schema — or by a dimension a value is chained to); each
 * repeat iterating the consumer's literal collection in declaration order; each
 * splice keyed per element; and what is refused where the consumer wrote it
 * (`REPEAT_COMPUTED`, `BRANCH_UNDECIDABLE`, `REPEAT_NUMERIC_KEY`,
 * `REPEAT_KEY_DUPLICATE`, and a `targets:` list the expansion leaves naming no
 * entry or starting what is never run).
 *
 * Three seams, nothing else, are the caller's: `declarationAt` — the
 * declaration a reference names and the module it belongs to (the analyzer
 * resolves a name, the kernel a reference in the scope that wrote it or a live
 * instance's declaration); `readDeclaration` — that declaration as a read past
 * the reference sees it (`namedShapeReading`, over each half's declarations);
 * and `emitted`, what an
 * emitted item receives for a value that reads a loop's binding (the analyzer
 * gives the forward marker, the kernel the live value or the expression closed
 * over its bindings). `decidedValue` reads a value chained to a dimension from
 * the configuration in force.
 *
 * Browser-safe.
 */
import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { isCompiledValue, literalStepValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  expansionBody,
  isRefSentinel,
  isTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import type { AliasResolver } from "./alias-resolver.js";
import { branchForValue, evaluate } from "./choice-reading.js";
import {
  EVERYWHERE,
  holdingOf,
  isAlternatives,
  isEverywhere,
  meet,
  type ChoiceStep,
  type Holding,
} from "./conditioned-expansion.js";
import { FALSE, type ConditionSpace } from "./presence-condition.js";
import { readDecisionExpression } from "./decision-reads.js";
import { declaredCelViewAt, declaredViewPaths } from "./declared-cel-view.js";
import type { DeclaredScalarPath } from "./invocation-contract.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ExpansionSite } from "./expansion-sites.js";
import { definitionInScope } from "./module-alias-scope.js";
import { isResolvedReference } from "./resolved-reference.js";
import { gatherPropertySchemas, resolveLocalRef } from "./schema-walk.js";
import { templateTargetProblems } from "./template-targets.js";
import {
  expandTemplateBody,
  parseKeys,
  pathText,
  type ConsumerForward,
  type LoopBinding,
  type LoopElement,
  type LoopInstance,
  type TemplateBodyExpansion,
} from "./template-expansion.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** A kind's scalar paths, by its effective schema. */
const scalarPathsBySchema = new WeakMap<object, readonly DeclaredScalarPath[]>();

/** Where a consumer wrote a value. */
export interface Location {
  readonly holder: ResourceManifest;
  readonly keys: readonly (string | number)[];
  /** LIFTED: where it is written in its holder's document, where that differs
   *  from {@link keys} (a choice's branch on the way), and the value itself. */
  readonly written?: readonly (string | number)[];
}

/** LIFTED: a value a forward reads, where it holds and where it is written. */
export interface LiftedForward {
  readonly holder: ResourceManifest;
  readonly value: unknown;
  readonly written: readonly (string | number)[];
  readonly holding: Holding;
}

/** One consumer's expansion of the body its kind runs. */
export interface ConsumerExpansion {
  readonly consumer: ResourceManifest;
  readonly runner: ResourceDefinition;
  readonly expansion: TemplateBodyExpansion;
  /** True when a choice or repeat was refused, leaving the body incomplete:
   *  the refusal is the one report about it. */
  readonly refused: boolean;
  /** The place a consumer wrote the element an instance stands in. */
  readonly locate: (instance: LoopInstance) => Location | undefined;
}

export interface ConsumerExpansionEnvironment {
  readonly registry: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  /** SEAM. The declaration `value` names, when it is a reference: undefined when
   *  it is none; `declaration` undefined when it names nothing; `module` the
   *  module the declaration belongs to. */
  declarationAt(
    value: unknown,
    at: Location,
    consumer: ResourceManifest,
  ): { declaration: ResourceManifest | undefined; module: string | undefined } | undefined;
  /** SEAM. A declaration a reference names, as it is read past the reference:
   *  a named shape with its `extends` parents folded. */
  readDeclaration(declaration: ResourceManifest): ResourceManifest;
  /** SEAM. What an emitted item receives for a CEL value that reads a loop's
   *  binding; `forward` is where the consumer wrote the value when the
   *  expression is a bare `<binding>.value.<path>`. */
  emitted(value: unknown, instance: LoopInstance, forward: Location | undefined): unknown;
  /** The value `source`, written in `holder` (`node` its value), has in the
   *  configuration in force — undefined when it does not decide it. */
  decidedValue(holder: ResourceManifest, source: string, node?: unknown): { value: unknown } | undefined;
  /** True when the `targets:` of a consumer's expansion are judged. */
  judgesTargets(runner: ResourceDefinition): boolean;
  /** LIFTED: the consumer expanded over every configuration at once — its
   *  values the union's, every choice inside them an option node. Read in
   *  place of `declarationAt`, `decidedValue` and `emitted`. */
  readonly lift?: ConsumerLift;
}

/** What a consumer expansion over every configuration at once reads. */
export interface ConsumerLift {
  readonly space: ConditionSpace;
  /** Every declaration `value` names, when it is a reference, each with where
   *  it names it; undefined when it is none. */
  declarationsAt(
    value: unknown,
    at: Location,
    consumer: ResourceManifest,
  ): readonly { readonly declaration: ResourceManifest | undefined; readonly module: string | undefined; readonly holding: Holding }[] | undefined;
  /** Every value `source`, written in `holder`, takes, each where it holds;
   *  undefined when no configuration decides it. */
  valueOutcomes(holder: ResourceManifest, source: string): readonly { readonly value: unknown; readonly holding: Holding }[] | undefined;
  /** What an emitted item receives for a value reading a loop's binding:
   *  `forwards` every place it reads, each where it holds. */
  emitted(value: unknown, instance: LoopInstance, forwards: readonly LiftedForward[] | undefined): unknown;
  /** Where a consumer's root is written in its holder's document. */
  writtenAt(consumer: ResourceManifest): readonly (string | number)[];
}

export interface ConsumerExpansionRecords {
  readonly diagnostics: AnalysisDiagnostic[];
  /** Every expression a decision reads in a consumer's own values. */
  readonly reads: { holder: ResourceManifest; source: string }[];
  /** Each value refused as computed or undecided. */
  readonly refused: { holder: ResourceManifest; path: string }[];
  /** The refusals whose value is chained to an input no configuration
   *  decides: the configuration reading reports that binding, once. */
  readonly open: Set<AnalysisDiagnostic>;
}

type Resolved =
  | { readonly kind: "value"; readonly value: unknown; readonly at?: Location }
  | { readonly kind: "open"; readonly at: Location; readonly reason: string; readonly undecided?: true };

/** A resolution and where it holds — one, holding everywhere, unless lifted. */
interface Outcome {
  readonly resolved: Resolved;
  readonly holding: Holding;
}

/** Expand consumers' runner bodies, accumulating what is refused. */
export function createConsumerExpander(env: ConsumerExpansionEnvironment): {
  readonly records: ConsumerExpansionRecords;
  expand(
    consumer: ResourceManifest,
    runner: ResourceDefinition,
    sites: ReadonlyMap<unknown, ExpansionSite>,
  ): ConsumerExpansion;
} {
  const { registry, aliases, aliasesByModule } = env;
  const records: ConsumerExpansionRecords = { diagnostics: [], reads: [], refused: [], open: new Set() };
  const reported = new Set<string>();

  const report = (code: string, at: Location, message: string, open = false) => {
    const meta = at.holder.metadata as { name?: unknown; source?: unknown } | undefined;
    const path = pathText(at.keys);
    const key = `${code}\0${String(meta?.name)}\0${String(meta?.source)}\0${path}`;
    if (reported.has(key)) return;
    reported.add(key);
    if (code === "REPEAT_COMPUTED" || code === "BRANCH_UNDECIDABLE") records.refused.push({ holder: at.holder, path });
    const diagnostic: AnalysisDiagnostic = {
      severity: DiagnosticSeverity.Error,
      code,
      source: SOURCE,
      message: `${at.holder.kind}/${String(meta?.name)}: ${message}`,
      data: {
        resource: { kind: at.holder.kind, name: meta?.name },
        ...(typeof meta?.source === "string" ? { filePath: meta.source } : {}),
        path,
      },
    };
    records.diagnostics.push(diagnostic);
    if (open) records.open.add(diagnostic);
  };

  const expand = (
    consumer: ResourceManifest,
    runner: ResourceDefinition,
    sites: ReadonlyMap<unknown, ExpansionSite>,
  ): ConsumerExpansion => {
    const runnerDoc = runner as unknown as ResourceManifest;
    const consumerModule = moduleOf(consumer);
    const located = new WeakMap<LoopElement, Location>();
    const bindings = new Map<ExpansionSite, LoopBinding>();
    let refusals = 0;
    const refuse = (code: string, at: Location, message: string, open = false) => {
      refusals++;
      report(code, at, message, open);
    };
    const bindingOf = (site: ExpansionSite): LoopBinding => {
      const known = bindings.get(site);
      if (known) return known;
      const body = expansionBody(site.value as ExpansionSentinel);
      const binding: LoopBinding = {
        name: typeof body.as === "string" ? body.as : "each",
        sentinel: site.value as ExpansionSentinel,
        site: parseKeys(site.path),
        keyed: false,
        element: undefined,
      };
      bindings.set(site, binding);
      return binding;
    };

    /** The schema default of a field `holder`'s kind declares at `keys`. */
    const defaultAt = (holder: ResourceManifest, keys: readonly (string | number)[]): unknown => {
      const kind = definitionInScope<ResourceDefinition>(registry, holder.kind, holder.metadata, aliases, aliasesByModule);
      const schema = kind ? (registry.effectiveSchemaOf(kind) as Record<string, any> | undefined) : undefined;
      let node: Record<string, any> | undefined = schema;
      for (const key of keys) {
        if (!node) return undefined;
        node = resolveLocalRef(node, schema!);
        if (!node) return undefined;
        if (typeof key === "number") node = node.items;
        else {
          const property = gatherPropertySchemas(node, schema).find(([name]) => name === key)?.[1];
          node = property ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
        }
      }
      return node && Object.hasOwn(node, "default") ? node.default : undefined;
    };

    /** A value written at `at`, as an expression reads it: the step engine's
     *  literal rule, then the representation its kind declares there. */
    const celView = (value: unknown, at: Location | undefined): unknown => {
      const literal = literalStepValue(value);
      return at ? declaredCelViewAt(literal, at.keys, scalarsOf(at.holder)) : literal;
    };
    const scalarsOf = (holder: ResourceManifest): readonly DeclaredScalarPath[] => {
      const kind = definitionInScope<ResourceDefinition>(registry, holder.kind, holder.metadata, aliases, aliasesByModule);
      const schema = kind ? (registry.effectiveSchemaOf(kind) as Record<string, any> | undefined) : undefined;
      if (!schema) return [];
      let paths = scalarPathsBySchema.get(schema);
      if (!paths) {
        paths = declaredViewPaths(schema, registry.shapeLookup);
        scalarPathsBySchema.set(schema, paths);
      }
      return paths;
    };

    const lift = env.lift;
    const space = lift?.space;
    const both = (a: Holding, b: Holding): Holding => meet(space, a, b);
    const holds = (h: Holding): boolean => h.condition !== FALSE;

    /** `segments` read down from `start`, which `at` locates — every outcome,
     *  each where it holds (one, everywhere, unless lifted). */
    const navigate = (start: unknown, at: Location, segments: readonly string[], within: Holding = EVERYWHERE): Outcome[] => {
      type State = {
        node: unknown;
        holder: ResourceManifest;
        keys: (string | number)[];
        written: (string | number)[] | undefined;
        holding: Holding;
      };
      const out: Outcome[] = [];
      const step = (state: State, i: number): void => {
        let { node, holder, keys, written, holding } = state;
        // A lifted value a choice decides: each of its options in turn.
        if (isAlternatives(node)) {
          for (const option of node.options) {
            const h = both(holding, holdingOf(option));
            if (!holds(h)) continue;
            const value = option.present ? option.value : i > 0 ? defaultAt(holder, keys) : undefined;
            step({ node: value, holder, keys, written: option.present && option.moved ? [...option.at] : written, holding: h }, i);
          }
          return;
        }
        if (i === segments.length) {
          finish({ node, holder, keys, written, holding });
          return;
        }
        const segment = segments[i]!;
        if (!isTaggedSentinel(node) && !isCompiledValue(node)) {
          const location = { holder, keys, ...(written ? { written } : {}) };
          const crossings = lift
            ? lift.declarationsAt(node, location, consumer)
            : (() => {
                const crossed = env.declarationAt(node, location, consumer);
                return crossed && [{ ...crossed, holding: EVERYWHERE }];
              })();
          if (crossings) {
            for (const crossed of crossings) {
              const h = both(holding, crossed.holding);
              if (!holds(h)) continue;
              if (!crossed.declaration) {
                out.push({ resolved: { kind: "open", at: { holder, keys }, reason: `the reference names nothing` }, holding: h });
                continue;
              }
              if (crossed.module !== consumerModule) {
                out.push({
                  resolved: {
                    kind: "open",
                    at: { holder, keys },
                    reason: `it crosses into a declaration of module '${crossed.module ?? "<entry>"}', whose configuration is not this one's to decide`,
                  },
                  holding: h,
                });
                continue;
              }
              descend(
                { node: env.readDeclaration(crossed.declaration), holder: crossed.declaration, keys: [], written: lift ? [] : undefined, holding: h },
                i,
                segment,
              );
            }
            return;
          }
        }
        descend({ node, holder, keys, written, holding }, i, segment);
      };
      const descend = (state: State, i: number, segment: string): void => {
        const { node, holder, keys, written, holding } = state;
        if (isTaggedSentinel(node) || isCompiledValue(node)) {
          out.push({ resolved: { kind: "open", at: { holder, keys }, reason: `it is computed` }, holding });
          return;
        }
        if (!node || typeof node !== "object") {
          out.push({ resolved: { kind: "value", value: undefined }, holding });
          return;
        }
        const key = Array.isArray(node) ? Number(segment) : segment;
        const next = Array.isArray(node) ? node[key as number] : (node as Record<string, unknown>)[segment];
        const nextKeys = [...keys, key];
        const value = next === undefined && holder !== undefined ? defaultAt(holder, nextKeys) : next;
        step({ node: value, holder, keys: nextKeys, written: written && [...written, key], holding }, i + 1);
      };
      const finish = (state: State): void => {
        const { node, holder, keys, written, holding } = state;
        const location = { holder, keys, ...(written ? { written } : {}) };
        // A reference is data the consumer wrote: the value, not a computation.
        if (isRefSentinel(node)) {
          out.push({ resolved: { kind: "value", value: node, at: location }, holding });
          return;
        }
        if (isTaggedSentinel(node) || isCompiledValue(node)) {
          const source = celSource(node);
          if (source !== undefined) {
            records.reads.push({ holder, source });
            if (lift) {
              const outcomes = lift.valueOutcomes(holder, source);
              if (outcomes) {
                for (const outcome of outcomes) {
                  const h = both(holding, outcome.holding);
                  if (holds(h)) out.push({ resolved: { kind: "value", value: outcome.value, at: location }, holding: h });
                }
                return;
              }
            } else {
              const decided = env.decidedValue(holder, source, node);
              if (decided) {
                out.push({ resolved: { kind: "value", value: decided.value, at: location }, holding });
                return;
              }
            }
          }
          out.push({
            resolved: { kind: "open", at: { holder, keys }, reason: `it is computed, and no configuration decides it`, undecided: true },
            holding,
          });
          return;
        }
        out.push({ resolved: { kind: "value", value: node, at: location }, holding });
      };
      const written = lift ? (at.written ? [...at.written] : [...at.keys]) : undefined;
      step({ node: start, holder: at.holder, keys: [...at.keys], written, holding: within }, 0);
      return out;
    };

    /** What a chain an expression reads resolves to, in `instance`. */
    const resolveChain = (chain: readonly string[], instance: LoopInstance): Outcome[] | undefined => {
      const [root, ...rest] = chain;
      if (root === "self") {
        return navigate(consumer, { holder: consumer, keys: [], ...(lift ? { written: lift.writtenAt(consumer) } : {}) }, rest);
      }
      for (let i = instance.length - 1; i >= 0; i--) {
        const frame = instance[i]!;
        if (frame.binding.name !== root) continue;
        if (rest[0] === "key") return [{ resolved: { kind: "value", value: frame.element.key }, holding: EVERYWHERE }];
        if (rest[0] === "index") return [{ resolved: { kind: "value", value: BigInt(frame.element.index) }, holding: EVERYWHERE }];
        if (rest[0] === "value") {
          const at = located.get(frame.element);
          return at
            ? navigate(frame.element.value, at, rest.slice(1))
            : [{ resolved: { kind: "value", value: undefined }, holding: EVERYWHERE }];
        }
        return [{ resolved: { kind: "value", value: undefined }, holding: EVERYWHERE }];
      }
      return undefined;
    };

    /** `source`'s value in `instance` — every outcome, each where it holds —
     *  or the place no configuration decides. */
    const valueIn = (source: string, instance: LoopInstance): Outcome[] => {
      const expression = readDecisionExpression(source);
      // Each read's outcomes, combined: one activation per combination, and
      // each combination a read leaves open, open.
      let activations: { activation: Record<string, unknown>; holding: Holding }[] = [{ activation: {}, holding: EVERYWHERE }];
      const opens: Outcome[] = [];
      const combine = (chain: readonly string[], outcomes: readonly { value?: unknown; open?: Resolved; holding: Holding }[]) => {
        const next: typeof activations = [];
        for (const { activation, holding } of activations) {
          for (const outcome of outcomes) {
            const h = both(holding, outcome.holding);
            if (!holds(h)) continue;
            if (outcome.open) {
              opens.push({ resolved: outcome.open, holding: h });
              continue;
            }
            const copy = copyActivation(activation);
            setPath(copy, chain, outcome.value);
            next.push({ activation: copy, holding: h });
          }
        }
        activations = next;
      };
      for (const read of expression.reads) {
        if (read.class === "open") {
          const chain = read.chain.split(".");
          if (chain.some((c) => c.includes("[") || c.includes("?"))) continue;
          const resolved = resolveChain(chain, instance);
          if (!resolved) continue;
          combine(
            chain,
            resolved.map((o) =>
              o.resolved.kind === "open"
                ? { open: o.resolved, holding: o.holding }
                : { value: celView(o.resolved.value, o.resolved.at), holding: o.holding },
            ),
          );
          continue;
        }
        if (read.class === "input" || read.class === "module") {
          const chain = read.class === "input" ? read.read.chain : read.chain;
          if (lift) {
            const outcomes = lift.valueOutcomes(runnerDoc, chain);
            if (outcomes) combine(chain.split("."), outcomes);
            continue;
          }
          const decided = env.decidedValue(runnerDoc, chain);
          if (decided) for (const a of activations) setPath(a.activation, chain.split("."), decided.value);
          continue;
        }
      }
      return [
        ...opens,
        ...activations.map(({ activation, holding }): Outcome => {
          try {
            return { resolved: { kind: "value", value: evaluate(source, activation) }, holding };
          } catch (error) {
            return {
              resolved: {
                kind: "open",
                at: { holder: consumer, keys: [] },
                reason: `it does not evaluate: ${error instanceof Error ? error.message : String(error)}`,
              },
              holding,
            };
          }
        }),
      ];
    };

    /** The key a splice's element emits in `instance` — every outcome, each
     *  where it holds; undefined leaves the element out there. */
    const keysOf = (sentinel: ExpansionSentinel, instance: LoopInstance): { key: string | undefined; holding: Holding }[] => {
      const written = (sentinel as Record<string, unknown>).key;
      if (typeof written === "string") return [{ key: written, holding: EVERYWHERE }];
      const source = celSource(written);
      if (source === undefined) return [{ key: undefined, holding: EVERYWHERE }];
      const element = instance[instance.length - 1]?.element;
      const elementAt = element ? located.get(element) : undefined;
      return valueIn(source, instance).map(({ resolved, holding }) => {
        if (resolved.kind === "open") {
          refuse("REPEAT_COMPUTED", resolved.at,
            `the key ${runnerLabel(runner)} splices this element under reads a value that ${resolved.reason}. ` +
              `A splice's key reads only the element's literal parts and its binding.`,
            resolved.undecided === true);
          return { key: undefined, holding };
        }
        if (typeof resolved.value !== "string") return { key: undefined, holding };
        if (isIntegerLike(resolved.value) && elementAt) {
          refuse("REPEAT_NUMERIC_KEY", elementAt,
            `this element is spliced under the integer-like key '${resolved.value}', which a map orders ` +
              `numerically rather than as written. Choose a key that is not an integer.`);
        }
        return { key: resolved.value, holding };
      });
    };

    /** The branch of each outcome of the choice `sentinel` in `instance`. */
    const branchesOf = (
      sentinel: ExpansionSentinel,
      instance: LoopInstance,
    ): { branch: string | null; holding: Holding }[] | undefined => {
      const site = sites.get(sentinel);
      if (!site) return undefined;
      const tag = site.construct === "if" ? "if" : "switch";
      const written = (sentinel as Record<string, unknown>)[tag];
      if (!isTaggedSentinel(written) && !isCompiledValue(written)) {
        const branch = branchForValue(sentinel, tag, written);
        return branch === undefined ? undefined : [{ branch, holding: EVERYWHERE }];
      }
      const source = celSource(written);
      if (source === undefined) return undefined;
      const out: { branch: string | null; holding: Holding }[] = [];
      for (const value of valueIn(source, instance)) {
        if (value.resolved.kind === "open") {
          refuse("BRANCH_UNDECIDABLE", value.resolved.at,
            `a choice of ${runnerLabel(runner)} is decided by this value when the instance is created, but ` +
              `${value.resolved.reason}. Write a literal here, or a '!cel' reading only inputs whose values are decided ` +
              `before boot (an 'enum', 'const' or boolean variable, a member an 'enum' argument binds, a presence test).`,
            value.resolved.undecided === true);
          // Undecided, the choice contributes nothing: its refusal is the one report.
          out.push({ branch: null, holding: value.holding });
          continue;
        }
        const branch = branchForValue(sentinel, tag, value.resolved.value);
        if (branch === undefined) return undefined;
        out.push({ branch, holding: value.holding });
      }
      return out;
    };

    const locate = (instance: LoopInstance): Location | undefined => {
      const element = instance[instance.length - 1]?.element;
      return element ? located.get(element) : undefined;
    };

    /** The elements one resolved collection holds — lifted, each where it is an
     *  element at its index. */
    const elementsOf = (
      collection: unknown,
      at: Location,
      holding: Holding,
      out: LoopElement[],
      keyed: { value: boolean },
    ): void => {
      const written = (key: string | number, option?: { at: readonly (string | number)[]; moved: boolean }) =>
        lift ? { written: option?.moved ? [...option.at] : [...(at.written ?? at.keys), key] } : {};
      const entries: [string | number, unknown][] = Array.isArray(collection)
        ? collection.map((value, i) => [i, value])
        : Object.keys(collection as Record<string, unknown>).map((key) => [key, (collection as Record<string, unknown>)[key]]);
      keyed.value = !Array.isArray(collection);
      // Where each element stands: an item a choice may leave out moves every
      // later one, so each index is held where the items before it leave it.
      let states: { index: number; holding: Holding }[] = [{ index: 0, holding }];
      for (const [key, value] of entries) {
        const elementAt = { holder: at.holder, keys: [...at.keys, key] };
        const options = isAlternatives(value)
          ? value.options.map((option) => ({ option, holding: holdingOf(option) }))
          : [{ option: undefined, holding: EVERYWHERE }];
        const next: { index: number; holding: Holding }[] = [];
        for (const state of states) {
          for (const { option, holding: own } of options) {
            const h = both(state.holding, own);
            if (!holds(h)) continue;
            if (option && !option.present) {
              next.push({ index: state.index, holding: h });
              continue;
            }
            const item = option ? option.value : value;
            const location = { ...elementAt, ...written(key, option) };
            if (typeof key === "string" && isIntegerLike(key)) {
              refuse("REPEAT_NUMERIC_KEY", elementAt,
                `'${key}' is an integer-like key of a map ${runnerLabel(runner)} repeats over. Such keys are ` +
                  `ordered numerically, not as written, so the order the repeat emits in would not be the ` +
                  `one written here. Give it a key that is not an integer.`);
            }
            const element: LoopElement = {
              ...(typeof key === "string" ? { key } : {}),
              index: state.index,
              value: item,
              view: celView(item, elementAt),
              ...(lift && !isEverywhere(h) ? { holding: h } : {}),
            };
            located.set(element, location);
            out.push(element);
            next.push({ index: state.index + 1, holding: h });
          }
        }
        states = mergeStates(next);
      }
    };
    /** States at one index, one: where any of them holds. */
    const mergeStates = (states: { index: number; holding: Holding }[]) => {
      const byIndex = new Map<number, Holding>();
      for (const { index, holding } of states) {
        const known = byIndex.get(index);
        byIndex.set(
          index,
          !known
            ? holding
            : {
                condition: space ? space.or(known.condition, holding.condition) : known.condition,
                path: known.path.filter((step: ChoiceStep) => holding.path.includes(step)),
              },
        );
      }
      return [...byIndex].map(([index, holding]) => ({ index, holding }));
    };

    const expansion = expandTemplateBody(runnerDoc, {
      positionOf: (sentinel) => sites.get(sentinel)?.position,
      ...(lift ? { space: lift.space, branches: branchesOf } : {}),
      decide: (sentinel, instance) => {
        const outcomes = branchesOf(sentinel, instance);
        return outcomes?.[0]?.branch;
      },
      elements: (sentinel, instance) => {
        const site = sites.get(sentinel);
        if (!site) return undefined;
        const binding = bindingOf(site);
        const source = celSource((sentinel as Record<string, unknown>).in);
        const chain = source?.trim().split(".");
        if (!chain) return undefined;
        const resolved = resolveChain(chain, instance);
        if (!resolved) return undefined;
        const elements: LoopElement[] = [];
        const keyed = { value: false };
        for (const outcome of resolved) {
          const r = outcome.resolved;
          if (r.kind === "open") {
            refuse("REPEAT_COMPUTED", r.at,
              `${runnerLabel(runner)} repeats over this value, but ${r.reason}. A repeat's source is a ` +
                `collection written literally, so the analysis knows every element before boot; write the ` +
                `elements out here.`,
              r.undecided === true);
            if (!lift) return { binding, elements: [] };
            continue;
          }
          if (r.at && r.value !== undefined && !isLiteralCollection(r.value)) {
            refuse("REPEAT_COMPUTED", r.at,
              `${runnerLabel(runner)} repeats over this value, but it is not a collection written literally.`);
            if (!lift) return { binding, elements: [] };
            continue;
          }
          if (r.value === undefined || r.value === null || !r.at) continue;
          elementsOf(r.value, r.at, outcome.holding, elements, keyed);
        }
        return { binding: { ...binding, keyed: keyed.value }, elements };
      },
      ...(lift
        ? {
            keys: (sentinel: ExpansionSentinel, instance: LoopInstance) =>
              keysOf(sentinel, instance).flatMap((k) => (k.key === undefined ? [] : [{ key: k.key, holding: k.holding }])),
          }
        : {}),
      key: (sentinel, instance) => keysOf(sentinel, instance)[0]?.key,
      emitted: (value, instance) => {
        const source = celSource(value);
        const match = source ? /^([A-Za-z_][A-Za-z0-9_]*)\.value((?:\.[A-Za-z_$][\w$]*)*)$/.exec(source.trim()) : null;
        const frame = match ? [...instance].reverse().find((f) => f.binding.name === match[1]) : undefined;
        const at = frame ? located.get(frame.element) : undefined;
        const rest = match?.[2] ? match[2].slice(1).split(".") : [];
        if (lift) {
          const forwards = at
            ? navigate(frame!.element.value, at, rest).flatMap((o) =>
                o.resolved.kind === "value" && o.resolved.at
                  ? [{
                      holder: o.resolved.at.holder,
                      value: o.resolved.value,
                      written: o.resolved.at.written ?? o.resolved.at.keys,
                      holding: o.holding,
                    }]
                  : [],
              )
            : undefined;
          return lift.emitted(value, instance, forwards);
        }
        const forward = at ? { holder: at.holder, keys: [...at.keys, ...rest] } : undefined;
        return env.emitted(value, instance, forward);
      },
    });

    for (const d of duplicateSplicedKeys(expansion, locate)) {
      refusals++;
      records.diagnostics.push(d);
    }
    // A body the expansion left undecided has no `targets:` to judge: its
    // refusal is the one report.
    if (refusals === 0 && env.judgesTargets(runner)) {
      const problems = templateTargetProblems(
        expansion.definition as unknown as Record<string, unknown>,
        (runner as { capability?: string }).capability,
        undefined,
        (kind) =>
          definitionInScope<ResourceDefinition>(registry, kind, runner.metadata, aliases, aliasesByModule)
            ?.capability as string | undefined,
      ).filter((p) => p.code === "TEMPLATE_TARGET_UNKNOWN" || p.code === "TEMPLATE_TARGETS_CAPABILITY");
      for (const problem of problems) {
        report(problem.code, { holder: consumer, keys: [] },
          `${runnerLabel(runner)}, expanded for this instance: ${problem.message}`);
      }
    }
    return { consumer, runner, expansion, refused: refusals > 0, locate };
  };

  return { records, expand };
}

/** Each spliced key emitted twice in one mapping, or beside a literal key of
 *  it, as `REPEAT_KEY_DUPLICATE` at the consumer's element. */
function duplicateSplicedKeys(
  expansion: TemplateBodyExpansion,
  locate: (instance: LoopInstance) => Location | undefined,
): AnalysisDiagnostic[] {
  const out: AnalysisDiagnostic[] = [];
  const seen = new Map<string, Set<string>>();
  for (const spliced of expansion.splicedKeys) {
    const container = pathText(spliced.container);
    const keys = seen.get(container) ?? new Set(expansion.literalKeys.get(container) ?? []);
    seen.set(container, keys);
    if (!keys.has(spliced.key)) {
      keys.add(spliced.key);
      continue;
    }
    const at = locate(spliced.instance);
    if (!at) continue;
    const meta = at.holder.metadata as { name?: unknown; source?: unknown } | undefined;
    out.push({
      severity: DiagnosticSeverity.Error,
      code: "REPEAT_KEY_DUPLICATE",
      source: SOURCE,
      message:
        `${at.holder.kind}/${String(meta?.name)}: this element is spliced under the key '${spliced.key}', ` +
        `which another entry of the same mapping already holds. Each element's key must be unique, and ` +
        `differ from every key written beside the splice.`,
      data: {
        resource: { kind: at.holder.kind, name: meta?.name },
        ...(typeof meta?.source === "string" ? { filePath: meta.source } : {}),
        path: pathText(at.keys),
      },
    });
  }
  return out;
}

/** The marker the analyzer's consumer check hands an emitted item for a value it
 *  forwards. */
export function forwardMarker(at: Location): ConsumerForward {
  return { __templateForward: { holder: at.holder, keys: at.keys } };
}

export function runnerLabel(runner: ResourceDefinition): string {
  const { name, module } = runner.metadata;
  return `the template of ${module ? `${module}.${name}` : name}`;
}

export function moduleOf(m: ResourceManifest): string | undefined {
  const module = (m.metadata as { module?: unknown } | undefined)?.module;
  return typeof module === "string" ? module : undefined;
}

function celSource(value: unknown): string | undefined {
  if (isTaggedSentinel(value)) return value.engine === CEL_ENGINE ? value.source : undefined;
  if (isCompiledValue(value)) return typeof value.source === "string" ? value.source : undefined;
  return undefined;
}

function isLiteralCollection(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !isTaggedSentinel(value) &&
    !isCompiledValue(value) &&
    !isResolvedReference(value)
  );
}

function isIntegerLike(key: string): boolean {
  return /^-?(0|[1-9][0-9]*)$/.test(key);
}

/** An activation copied along its own maps, so a combination writes its own. */
function copyActivation(activation: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(activation)) {
    out[key] =
      value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
        ? copyActivation(value as Record<string, unknown>)
        : value;
  }
  return out;
}

function setPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let at = target;
  segments.forEach((segment, i) => {
    if (i === segments.length - 1) {
      at[segment] = value;
      return;
    }
    const next = at[segment];
    if (!next || typeof next !== "object") at[segment] = {};
    at = at[segment] as Record<string, unknown>;
  });
}
