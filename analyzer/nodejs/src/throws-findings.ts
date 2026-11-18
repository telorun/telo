/**
 * Throws over every configuration at once: the throws pass
 * (`validate-throws-coverage.ts`) — each declaration's throw union, the catch
 * ladder each dispatch site climbs, rules 1, 4 and 7, the unbounded-union rule
 * and the retry-policy checks — run once over the conditioned call graph, every
 * code of a union, rung of a ladder and finding carrying where it holds.
 *
 * A declaration is read once per chain of the options inside it, as the graph
 * reads it: a site (a step list, a reference slot, a catch list) is found in
 * the reading whose chain is the options enclosing it, and its value is read
 * from the union with every choice beneath it flattened into its options, so a
 * choice is read once whatever choices stand beside it. A reference's targets
 * are the graph's edges at its place. A memo is kept per declaration and
 * where it has been computed, so each configuration's union is the one its run
 * computes in the order it computes it, a cycle short-circuiting as there.
 *
 * Each finding is rendered in the raw form a run's own finding takes, read
 * where it holds; a branch no configuration takes is projected once, at its
 * baseline with its forcing.
 *
 * Browser-safe.
 */
import type { CelEnvironment } from "@telorun/cel";
import { isAmbientContractErrorCode, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import { isRefSentinel, isTaggedSentinel } from "@telorun/templating";
import { scopeResolverForModule, type AliasResolver } from "./alias-resolver.js";
import type { ResourceGraphNode } from "./call-graph.js";
import { answerFor, collectOutcomeLists, extractCoveredCodes, type CatchEntryReading } from "./catch-scope.js";
import { readCatchesFor } from "./catches-for-slot.js";
import { caughtCodeChains, catchListContext, intersectDataSchemas } from "./caught-member.js";
import { reportKeyCost } from "./cel-site-judgements.js";
import {
  choicesOnTheWay,
  compareRanks,
  viewOf,
  type ConditionedCallGraph,
  type GraphWorld,
  type HeldGraphEdge,
  type HeldGraphNode,
} from "./conditioned-call-graph.js";
import {
  isAlternatives,
  takenAt,
  type AlternativeOption,
  type Alternatives,
  type ConditionedExpansion,
  type ConditionedView,
  type World,
} from "./conditioned-expansion.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import { TRUE, type Condition } from "./presence-condition.js";
import { transfersControl, type RefSlot } from "./ref-slot.js";
import {
  codesFromDefinition,
  createResolveCtx,
  handsFailureBack,
  PLAIN_ERROR_CODE,
  readCodeExpression,
  receivedConfiguration,
  resolveThrowsUnion,
  throwsBlockOf,
  throwsUses,
  type ResolveCtx,
  type ThrowsCodeMeta,
  type ThrowsUnion,
} from "./resolve-throws-union.js";
import { resolveSlotUseAt } from "./call-graph.js";
import { isInjectedDeclaration } from "./resource-input.js";
import { retryForSites, retryForTargetField } from "./retry-for-slot.js";
import { forEachDrivenSlot } from "./schema-walk.js";
import { manifestNames } from "./scoped-name-resolver.js";
import type { StepSlot } from "./step-slot.js";
import { parseKeys, pathText } from "./template-expansion.js";
import { aboutDeclaration } from "./placement.js";
import { kindThrowsDeclarer } from "./throws-ceiling.js";
import type { AnalysisDiagnostic } from "./types.js";
import { readDeadBranches, type DeadFinding, type PassTable, type ReadFinding } from "./union-passes.js";
import {
  catchAllNotLastDiagnostic,
  checkCelChainAgainstDataSchema,
  collectCelStrings,
  denominatorText,
  handlerText,
  nonRetryableNotThrownDiagnostic,
  unboundedUnionDiagnostic,
  uncoveredCodesDiagnostic,
  undeclaredCodeDiagnostic,
  validateThrowsDeclarations,
  type ThrowsPlacement,
} from "./validate-throws-coverage.js";
import type { DeadBranchRun, WorldReader } from "./world-reader.js";

type Key = string | number;
type Keys = readonly Key[];

export interface ThrowsInputs {
  readonly graph: ConditionedCallGraph;
  readonly union: ConditionedExpansion;
  readonly defs: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
  readonly rootModules: ReadonlySet<string>;
  readonly env: CelEnvironment;
  /** Each imported library's full documents. */
  readonly libraries: Map<string, ResourceManifest[]>;
  /** The branches no configuration takes, each projected once. */
  readonly deadBranches: readonly DeadBranchRun[];
}

/** The graph and the options of the union, in the connectives `T` computes in. */
interface ThrowsWorld<T> extends GraphWorld<T> {
  option(option: AlternativeOption): T;
}

/** One way a value is written, and where. */
interface Held<T, V = unknown> {
  readonly value: V;
  readonly held: T;
}

/** A code of a union: where it is in it, and its metadata where each
 *  contributor is the first to add it. */
interface Code<T> {
  held: T;
  readonly metas: { readonly meta: ThrowsCodeMeta; held: T }[];
}

interface Union<T> {
  readonly codes: Map<string, Code<T>>;
  unbounded: T;
  plain: T;
}

/** A finding, where it holds, and its raw form where `read` reads. */
interface Found<T> {
  readonly held: T;
  render(read: WorldReader<T>): AnalysisDiagnostic[];
}

/** A place a declaration drives another through. */
interface DrivenSite<T> {
  readonly kind: "step" | "ref";
  /** From the declaration's root. */
  readonly keys: Keys;
  readonly held: T;
  readonly stepSlots: readonly StepSlot[];
  readonly refSlots: readonly RefSlot[];
  /** Whether, read at this site, a slot hands a failure back. */
  readonly handsBack: boolean;
  /** For a mapping-built step list: the list as the mapping builds it. */
  readonly built?: unknown[];
}

/** What one entry proves, and whether rule 7 reads it as a catch-all — which
 *  it does for an entry holding nothing too. */
interface EntryReading extends CatchEntryReading {
  readonly unguarded: boolean;
}

/** One way a catch list is written. */
interface ListPart<T> {
  readonly held: T;
  /** Each entry, by where it is written, each way it reads. */
  readonly entries: { readonly index: number; readonly readings: Held<T, EntryReading>[] }[];
}

interface CatchListSite<T> {
  readonly node: string;
  readonly keys: Keys;
  readonly handlerKeys?: Keys;
  readonly isScope: boolean;
  readonly codeChains: string[][];
  readonly raises: ReadonlyMap<string, ThrowsCodeMeta>;
  readonly parts: ListPart<T>[];
  readonly rank: number[];
}

interface ReturnsSite<T> {
  readonly node: string;
  readonly keys: Keys;
  readonly held: T;
  readonly rank: number[];
}

const moduleOf = (manifest: ResourceManifest | undefined): string | undefined =>
  (manifest?.metadata as { module?: string } | undefined)?.module;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const STEP_BRANCHES = ["try", "catch", "finally", "then", "else", "do", "default"] as const;

export function throwsFindings(inputs: ThrowsInputs): PassTable {
  const { graph, union, defs, aliases, aliasesByModule, rootModules, env, libraries } = inputs;
  const { space } = union;
  const ctx: ResolveCtx = createResolveCtx([], defs, aliases, aliasesByModule, new Set(rootModules), libraries);
  const plainUnions = new Map<ResourceManifest, ThrowsUnion>();

  // What every run reports first: the declarations of the kinds, which never vary.
  const declarations = validateThrowsDeclarations(
    union.declarations.map((d) => d.manifest).filter((m) => m.kind === "Telo.Definition" || m.kind === "Telo.Abstract"),
  );

  const views = new Set<object>(union.views);
  /** The places of a forward view a consumer's forward moves a value to. */
  const forwarded = new Map<object, Keys[]>();
  const forwardedOf = (view: ConditionedView): Keys[] => {
    let known = forwarded.get(view);
    if (!known) {
      known = [];
      const walk = (value: unknown, keys: Key[], seen: Set<object>): void => {
        if (isAlternatives(value)) {
          if (value.options.some((o) => o.moved)) known!.push([...keys]);
          for (const option of value.options) if (option.present) walk(option.value, keys, seen);
          return;
        }
        if (value === null || typeof value !== "object" || isRefSentinel(value) || isTaggedSentinel(value) || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...keys, i], seen));
        else for (const [key, member] of Object.entries(value)) walk(member, [...keys, key], seen);
        seen.delete(value);
      };
      walk(view.manifest, [], new Set());
      forwarded.set(view, known);
    }
    return known;
  };
  /** Whether a template body wrote the value a view holds at `keys` whole. */
  const bodyWroteWhole = (node: HeldGraphNode, keys: Keys): boolean => {
    const declaration = node.declaration;
    if (!views.has(declaration) || !(declaration as ConditionedView).body) return false;
    return !forwardedOf(declaration as ConditionedView).some((at) => {
      const shared = Math.min(at.length, keys.length);
      for (let i = 0; i < shared; i++) if (String(at[i]) !== String(keys[i])) return false;
      return true;
    });
  };

  // Every resource, in the order a run's set lists it: module scope, then the
  // scope members by holder and where each is written.
  const scoped = graph.nodes
    .filter((n) => n.node.type === "resource" && n.site)
    .map((n) => {
      let top: HeldGraphNode | undefined = n;
      let depth = 0;
      while (top?.site && top.owner !== undefined) {
        top = graph.node(top.owner);
        depth++;
      }
      const at = top ? graph.resourceNodes().findIndex((r) => r.id === top!.id) : -1;
      return { node: n, order: [at, depth, ...n.place] };
    })
    .sort((a, b) => compareRanks(a.order, b.order))
    .map((entry) => entry.node);
  const readings = [...graph.resourceNodes().flatMap((n) => graph.readingsOf(n.id).filter((r) => !r.site)), ...scoped];
  const order = new Map<string, number>();
  for (const r of readings) if (!order.has(r.id)) order.set(r.id, order.size);

  const edgesAt = new Map<string, HeldGraphEdge[]>();
  for (const edge of graph.edges) {
    const key = `${edge.owner}\0${JSON.stringify(edge.keys)}`;
    const list = edgesAt.get(key) ?? [];
    list.push(edge);
    edgesAt.set(key, list);
  }

  const resourceOf = (id: string): ResourceGraphNode => graph.node(id)!.node as ResourceGraphNode;
  const definitionCache = new Map<string, ResourceDefinition | undefined>();
  const definitionFor = (kind: string, module: string | undefined): ResourceDefinition | undefined => {
    const key = `${kind}\0${module ?? ""}`;
    if (!definitionCache.has(key)) {
      const resolved = scopeResolverForModule(module, new Set(rootModules), aliasesByModule)?.resolveKind(kind) ?? aliases.resolveKind(kind);
      definitionCache.set(key, defs.resolve(kind) ?? (resolved ? defs.resolve(resolved) : undefined));
    }
    return definitionCache.get(key);
  };
  /** The module a node's names are read in: a scope member's holder's. */
  const nodeModule = (id: string): string | undefined => {
    const held = graph.node(id)!;
    return moduleOf(resourceOf(id).manifest) ?? moduleOf(held.declaration.manifest);
  };
  const definitionOf = (id: string): ResourceDefinition | undefined => {
    const node = resourceOf(id);
    return typeof node.kind === "string" ? definitionFor(node.kind, nodeModule(id)) : undefined;
  };

  /** The value at `keys` of a reading's declaration, its own options taken. */
  const contentOf = (reading: HeldGraphNode): unknown => {
    let value: unknown = reading.declaration.manifest;
    const settle = (): boolean => {
      while (isAlternatives(value)) {
        const option = value.options[reading.taken.get(value) ?? -1];
        if (!option?.present) return false;
        value = option.value;
      }
      return true;
    };
    for (const key of reading.keys) {
      if (!settle() || value === null || typeof value !== "object") return undefined;
      value = (value as Record<Key, unknown>)[key];
    }
    return settle() ? value : undefined;
  };

  /** A schema-ordered rank of `keys` under `schema`, as the plain walks visit it. */
  const schemaRank = (schema: Record<string, any> | undefined, keys: Keys): number[] => {
    const out: number[] = [];
    let node = schema;
    for (const key of keys) {
      if (typeof key === "number") {
        out.push(key);
        node = node?.items;
      } else {
        const props = node?.properties as Record<string, any> | undefined;
        out.push(props ? Object.keys(props).indexOf(key) : -1);
        node = props?.[key];
      }
    }
    return out;
  };

  function project<T>(world: ThrowsWorld<T>): { found: Found<T>[] } {
    const L = world.logic;
    const orOf = (items: readonly { held: T }[]): T => items.reduce((all, i) => L.or(all, i.held), L.FALSE);

    /** Each way `value` reads where `held` holds, its choices' options taken. */
    const flat = (value: unknown, held: T): Held<T>[] => {
      if (L.isFalse(held)) return [];
      if (!isAlternatives(value)) return [{ value, held }];
      return value.options.flatMap((option) => {
        const at = L.and(held, world.option(option));
        if (L.isFalse(at)) return [];
        return option.present ? flat(option.value, at) : [{ value: undefined, held: at }];
      });
    };
    /** Each way the value at `keys` of `root` reads. */
    const readAt = (root: unknown, keys: Keys, held: T): Held<T>[] => {
      let values = flat(root, held);
      for (const key of keys) {
        values = values.flatMap((v) =>
          v.value !== null && typeof v.value === "object" ? flat((v.value as Record<Key, unknown>)[key], v.held) : [{ value: undefined, held: v.held }],
        );
      }
      return values;
    };

    // --- Unions ---------------------------------------------------------------
    const empty = (): Union<T> => ({ codes: new Map(), unbounded: L.FALSE, plain: L.FALSE });
    const unbounded = (held: T): Union<T> => ({ codes: new Map(), unbounded: held, plain: L.FALSE });
    const addCode = (u: Union<T>, code: string, meta: ThrowsCodeMeta, held: T): void => {
      if (L.isFalse(held)) return;
      let entry = u.codes.get(code);
      if (!entry) u.codes.set(code, (entry = { held: L.FALSE, metas: [] }));
      const fresh = L.and(held, L.not(entry.held));
      if (!L.isFalse(fresh)) {
        const same = entry.metas.find((m) => m.meta.data === meta.data);
        if (same) same.held = L.or(same.held, fresh);
        else entry.metas.push({ meta, held: fresh });
      }
      entry.held = L.or(entry.held, held);
    };
    const into = (target: Union<T>, src: Union<T>): void => {
      for (const [code, entry] of src.codes) for (const m of entry.metas) addCode(target, code, m.meta, m.held);
      target.unbounded = L.or(target.unbounded, src.unbounded);
      target.plain = L.or(target.plain, src.plain);
    };
    const restrict = (u: Union<T>, held: T): Union<T> => {
      const out = empty();
      for (const [code, entry] of u.codes) for (const m of entry.metas) addCode(out, code, m.meta, L.and(m.held, held));
      out.unbounded = L.and(u.unbounded, held);
      out.plain = L.and(u.plain, held);
      return out;
    };
    const fromPlain = (plain: ThrowsUnion, held: T): Union<T> => {
      const out = empty();
      for (const [code, meta] of plain.codes) addCode(out, code, meta, held);
      if (plain.unbounded) out.unbounded = held;
      if (plain.canThrowPlain) out.plain = held;
      return out;
    };
    const has = (u: Union<T>, code: string): T => u.codes.get(code)?.held ?? L.FALSE;

    const report = (id: string): void => {
      reportKeyCost({ kind: "pass-reading", pass: "throwsCoverage", declaration: graph.node(id)!.declaration });
    };

    // --- What each declaration holds, read once per chain of its options -------
    const drivenOf = new Map<string, DrivenSite<T>[]>();
    const listsOf = new Map<string, CatchListSite<T>[]>();
    const returnsOf = new Map<string, ReturnsSite<T>[]>();
    /** Each node's contents and where each holds, per reading. */
    const contents = new Map<string, Held<T>[]>();

    for (const reading of readings) {
      const id = reading.id;
      const node = reading.node as ResourceGraphNode;
      const content = contentOf(reading);
      if (!isObject(content) || typeof node.kind !== "string") continue;
      const base = world.at(reading);
      if (L.isFalse(base)) continue;
      (contents.get(id) ?? contents.set(id, []).get(id)!).push({ value: content, held: base });
      const definition = definitionOf(id);
      if (!definition) continue;
      const schema = defs.effectiveSchemaOf(definition);
      // Every chain of options inside the content, the empty one first.
      const chains: { taken: Map<Alternatives, number>; held: T; choices: Alternatives[] }[] = [
        { taken: new Map(), held: base, choices: [] },
      ];
      const visit = (value: unknown, chain: (typeof chains)[number], seen: Set<object>): void => {
        if (isAlternatives(value)) {
          value.options.forEach((option, index) => {
            if (!option.present) return;
            const held = L.and(chain.held, world.option(option));
            const next = { taken: new Map([...chain.taken, [value, index]]), held, choices: [...chain.choices, value] };
            chains.push(next);
            visit(option.value, next, seen);
          });
          return;
        }
        if (value === null || typeof value !== "object" || isRefSentinel(value) || isTaggedSentinel(value) || seen.has(value)) return;
        seen.add(value);
        for (const member of Array.isArray(value) ? value : Object.values(value)) visit(member, chain, seen);
        seen.delete(value);
      };
      visit(content, chains[0]!, new Set());
      const absolute = (keys: Keys): Keys => [...reading.keys, ...keys];
      for (const chain of chains) {
        if (L.isFalse(chain.held)) continue;
        report(id);
        const home = (keys: Keys): boolean => {
          const on = choicesOnTheWay(content, keys, chain.taken);
          return !!on && on.length === chain.choices.length && on.every((c, i) => c === chain.choices[i]);
        };
        const view = viewOf(content, chain.taken) as ResourceManifest;
        const objectKeys = new Map<object, Keys>();
        const index = (value: unknown, keys: Keys): void => {
          if (value === null || typeof value !== "object" || objectKeys.has(value)) return;
          objectKeys.set(value, keys);
          if (Array.isArray(value)) value.forEach((item, i) => index(item, [...keys, i]));
          else for (const [key, member] of Object.entries(value)) index(member, [...keys, key]);
        };
        index(view, []);
        const configured = receivedConfiguration(view, definition, ctx);
        const mapped = configured.data !== view;
        const sites = drivenOf.get(id) ?? drivenOf.set(id, []).get(id)!;
        if (configured.computedAboveSlot && chain.choices.length === 0) {
          sites.push({ kind: "ref", keys: [], held: chain.held, stepSlots: [], refSlots: [], handsBack: false, built: [] });
        }
        forEachDrivenSlot(configured.schema, configured.data, (driven) => {
          const own = mapped
            ? driven.data && typeof driven.data === "object"
              ? objectKeys.get(driven.data as object)
              : undefined
            : parseKeys(driven.path);
          if (own === undefined) {
            if (chain.choices.length > 0 || driven.kind !== "step") return;
            sites.push({ kind: "step", keys: [], held: chain.held, stepSlots: driven.slots, refSlots: [], handsBack: false, built: driven.data });
            return;
          }
          if (!home(own)) return;
          if (driven.kind === "step") {
            sites.push({ kind: "step", keys: absolute(own), held: chain.held, stepSlots: driven.slots, refSlots: [], handsBack: false });
            return;
          }
          const handsBack = driven.slots.some(({ slot, ref }) =>
            throwsUses(slot, resolveSlotUseAt(slot, configured.data as ResourceManifest, ref, driven.path).use).some(handsFailureBack),
          );
          sites.push({ kind: "ref", keys: absolute(own), held: chain.held, stepSlots: [], refSlots: driven.slots.map((s) => s.slot), handsBack });
        });
        const declared = throwsBlockOf(definition, ctx)?.codes as Record<string, { data?: Record<string, any> } | undefined> | undefined;
        collectOutcomeLists(
          view,
          schema,
          (_entries, arrayPath) => {
            const keys = parseKeys(arrayPath);
            if (!home(keys.slice(0, -1))) return;
            for (const option of readAt(content, keys, chain.held)) {
              if (!Array.isArray(option.value)) continue;
              (returnsOf.get(id) ?? returnsOf.set(id, []).get(id)!).push({
                node: id,
                keys: absolute(keys),
                held: option.held,
                rank: schemaRank(schema, keys),
              });
            }
          },
          (_entries, arrayPath, _sibling, parentPath, catchesFor, listSchema) => {
            const keys = parseKeys(arrayPath);
            if (!home(keys.slice(0, -1))) return;
            const isScope = catchesFor === "";
            const codeChains = caughtCodeChains(catchListContext(listSchema));
            const raises = new Map<string, ThrowsCodeMeta>();
            for (const code of readCatchesFor(listSchema)?.raises ?? []) {
              const meta = (declared ?? {})[code];
              if (meta) raises.set(code, meta.data ? { data: meta.data } : {});
            }
            const parts: ListPart<T>[] = readAt(content, keys, chain.held).map((option) => ({
              held: option.held,
              entries: (Array.isArray(option.value) ? option.value : []).map((item, i) => ({
                index: i,
                readings: flat(item, option.held).flatMap((entry): Held<T, EntryReading>[] => {
                  if (entry.value === undefined) return [];
                  if (!entry.value) return [{ held: entry.held, value: { catchAll: false, proven: true, codes: new Set(), unguarded: true } }];
                  return flat((entry.value as { when?: unknown }).when, entry.held).map((when) => {
                    if (!when.value) return { held: when.held, value: { catchAll: true, proven: true, codes: new Set<string>(), unguarded: true } };
                    const { proven, codes } = extractCoveredCodes(when.value, env, codeChains);
                    return { held: when.held, value: { catchAll: false, proven, codes, unguarded: false } };
                  });
                }),
              })),
            }));
            const handlerPath = isScope ? undefined : parentPath ? `${parentPath}.${catchesFor}` : catchesFor;
            (listsOf.get(id) ?? listsOf.set(id, []).get(id)!).push({
              node: id,
              keys: absolute(keys),
              ...(handlerPath !== undefined ? { handlerKeys: absolute(parseKeys(handlerPath)) } : {}),
              isScope,
              codeChains,
              raises,
              parts,
              rank: schemaRank(schema, keys),
            });
          },
        );
      }
    }

    /** The node's own content root at the place `keys` is written in. */
    const rootOf = (id: string): unknown => graph.node(id)!.declaration.manifest;

    // --- References -------------------------------------------------------------
    /** What a reference at `keys` of node `owner` reaches, each with where. */
    const targetsAt = (owner: string, keys: Keys, held: T): { edge: HeldGraphEdge; to: string | undefined; held: T }[] => {
      const out: { edge: HeldGraphEdge; to: string | undefined; held: T }[] = [];
      for (const edge of edgesAt.get(`${owner}\0${JSON.stringify(keys)}`) ?? []) {
        if (edge.edge.coReferrer) continue;
        for (const target of world.targets(edge)) {
          const at = L.and(held, target.held);
          if (!L.isFalse(at)) out.push({ edge, to: target.to, held: at });
        }
      }
      return out;
    };
    /** A name no declaration of the set answers: a library's own internal one,
     *  read from its documents, or unknown. */
    const libraryTarget = (edge: HeldGraphEdge): ResourceManifest | undefined => {
      const request = edge.target;
      if (request.form !== "name" || request.module === undefined) return undefined;
      const own = libraries.get(request.module);
      return own ? manifestNames(own).resolve(request.name, request.module) : undefined;
    };
    const plainUnion = (manifest: ResourceManifest, held: T): Union<T> => {
      let known = plainUnions.get(manifest);
      if (!known) plainUnions.set(manifest, (known = resolveThrowsUnion(manifest, ctx)));
      return fromPlain(known, held);
    };

    /** What a dispatch through the reference at `keys` of `owner` can throw. */
    const refTargetThrows = (owner: string, keys: Keys, held: T, onPassthrough?: (held: T) => Union<T>): Union<T> => {
      const out = empty();
      const objects = orOf(readAt(rootOf(owner), keys, held).filter((v) => v.value !== null && typeof v.value === "object" && !Array.isArray(v.value)));
      if (L.isFalse(objects)) return out;
      const origin = nodeModule(owner);
      for (const { edge, to, held: at0 } of targetsAt(owner, keys, objects)) {
        if (to === undefined) {
          const internal = libraryTarget(edge);
          into(out, internal ? plainUnion(internal, at0) : unbounded(at0));
          continue;
        }
        const target = resourceOf(to);
        const definition = typeof target.kind === "string" ? definitionFor(target.kind, origin) : undefined;
        if (!definition) {
          into(out, unbounded(at0));
          continue;
        }
        if (throwsBlockOf(definition, ctx)?.passthrough) {
          into(out, onPassthrough ? onPassthrough(at0) : unbounded(at0));
          continue;
        }
        into(out, unionOf(to, at0));
      }
      return out;
    };

    // --- A declaration's own union ----------------------------------------------
    const memo = new Map<string, { held: T; u: Union<T> }[]>();
    const computed = new Map<string, T>();
    const inProgress = new Set<string>();

    function unionOf(id: string, held: T): Union<T> {
      const out = empty();
      for (const entry of memo.get(id) ?? []) into(out, restrict(entry.u, held));
      const fresh = L.and(held, L.not(computed.get(id) ?? L.FALSE));
      if (L.isFalse(fresh) || inProgress.has(id)) return out;
      inProgress.add(id);
      let u: Union<T>;
      try {
        u = computeUnion(id, fresh);
      } finally {
        inProgress.delete(id);
      }
      (memo.get(id) ?? memo.set(id, []).get(id)!).push({ held: fresh, u });
      computed.set(id, L.or(computed.get(id) ?? L.FALSE, fresh));
      into(out, u);
      return out;
    }

    function computeUnion(id: string, held: T): Union<T> {
      report(id);
      const definition = definitionOf(id);
      if (!definition) return unbounded(held);
      const manifest = resourceOf(id).manifest;
      if (isInjectedDeclaration(manifest)) {
        const declarer = kindThrowsDeclarer(definition, (kind, from) => definitionFor(kind, moduleOf(from as ResourceManifest | undefined)));
        return declarer ? fromPlain({ codes: codesFromDefinition(declarer, ctx), unbounded: false }, held) : unbounded(held);
      }
      const throws = throwsBlockOf(definition, ctx);
      if (!throws) return empty();
      const out = fromPlain({ codes: codesFromDefinition(definition, ctx), unbounded: false }, held);
      if (throws.passthrough) out.unbounded = held;
      if (throws.inherit) {
        for (const site of drivenOf.get(id) ?? []) {
          const at = L.and(held, site.held);
          if (L.isFalse(at)) continue;
          if (site.kind === "step") into(out, stepSiteThrows(id, site, at));
          else if (site.built) out.unbounded = L.or(out.unbounded, at);
          else if (site.handsBack) into(out, refTargetThrows(id, site.keys, at));
        }
      }
      return out;
    }

    /** What everything a scope list's resource drives can throw. */
    function scopeUnionOf(id: string, held: T, seen: Map<string, T>): Union<T> {
      const out = empty();
      const fresh = L.and(held, L.not(seen.get(id) ?? L.FALSE));
      if (L.isFalse(fresh)) return out;
      seen.set(id, L.or(seen.get(id) ?? L.FALSE, fresh));
      report(id);
      for (const site of drivenOf.get(id) ?? []) {
        const at = L.and(fresh, site.held);
        if (L.isFalse(at)) continue;
        if (site.kind === "step") {
          into(out, stepSiteThrows(id, site, at));
          continue;
        }
        if (site.built) {
          out.unbounded = L.or(out.unbounded, at);
          continue;
        }
        if (site.refSlots.some((slot) => !slot.throwsThrough && throwsUses(slot).some(transfersControl))) {
          into(out, refTargetThrows(id, site.keys, at));
        }
        if (site.refSlots.some((slot) => slot.throwsThrough)) {
          for (const target of throughTargets(id, site, at)) {
            if (target.to !== undefined && definitionOf(target.to)) into(out, scopeUnionOf(target.to, target.held, seen));
            else out.unbounded = L.or(out.unbounded, target.held);
          }
        }
      }
      return out;
    }

    /** The resources a `throwsThrough` site reaches; one it reaches nothing at is
     *  a target of none. */
    const throughTargets = (id: string, site: DrivenSite<T>, held: T): { to: string | undefined; held: T }[] => {
      const objects = orOf(readAt(rootOf(id), site.keys, held).filter((v) => v.value !== null && typeof v.value === "object" && !Array.isArray(v.value)));
      if (L.isFalse(objects)) return [];
      const found = targetsAt(id, site.keys, objects).map(({ to, held: at }) => ({ to: to === id ? undefined : to, held: at, self: to === id }));
      return found.filter((t) => !t.self).map(({ to, held: at }) => ({ to, held: at }));
    };

    // --- Step bodies ------------------------------------------------------------
    type TryCodes = Map<string, T> | undefined;

    function stepSiteThrows(owner: string, site: DrivenSite<T>, held: T): Union<T> {
      const out = empty();
      for (const invoke of new Set(site.stepSlots.map((slot) => slot.invoke))) {
        if (site.built) {
          into(out, stepArrayThrows(owner, site.built, undefined, invoke, undefined, held));
          continue;
        }
        for (const list of readAt(rootOf(owner), site.keys, held)) {
          if (Array.isArray(list.value)) into(out, stepArrayThrows(owner, list.value, site.keys, invoke, undefined, list.held));
        }
      }
      return out;
    }

    function stepArrayThrows(owner: string, steps: unknown[], keys: Keys | undefined, invoke: string, tryCodes: TryCodes, held: T): Union<T> {
      const out = empty();
      steps.forEach((item, i) => {
        for (const step of flat(item, held)) {
          if (isObject(step.value)) into(out, stepThrows(owner, step.value, keys ? [...keys, i] : undefined, invoke, tryCodes, step.held));
        }
      });
      return out;
    }

    const caughtCodes = (tryCodes: TryCodes, held: T): Union<T> => {
      if (!tryCodes) return unbounded(held);
      const out = empty();
      for (const [code, at] of tryCodes) addCode(out, code, {}, L.and(held, at));
      return out;
    };
    const codeExpression = (value: unknown, tryCodes: TryCodes, held: T): Union<T> => {
      const out = empty();
      for (const option of flat(value, held)) {
        const reading = readCodeExpression(option.value);
        if (reading.form === "code") addCode(out, reading.code, {}, option.held);
        else if (reading.form === "caught") into(out, caughtCodes(tryCodes, option.held));
        else out.unbounded = L.or(out.unbounded, option.held);
      }
      return out;
    };
    /** The arrays `value` reads as, and where it reads as none. */
    const arrays = (value: unknown, held: T): { lists: Held<T, unknown[]>[]; none: T } => {
      const lists: Held<T, unknown[]>[] = [];
      let none = L.FALSE;
      for (const option of flat(value, held)) {
        if (Array.isArray(option.value)) lists.push({ value: option.value, held: option.held });
        else none = L.or(none, option.held);
      }
      return { lists, none };
    };
    const under = (keys: Keys | undefined, ...more: Key[]): Keys | undefined => (keys ? [...keys, ...more] : undefined);

    /** One step, by shape, as the plain walk dispatches it. */
    function stepThrows(owner: string, step: Record<string, unknown>, keys: Keys | undefined, invoke: string, tryCodes: TryCodes, held: T): Union<T> {
      const out = empty();
      let rest = held;
      const shape = (value: unknown, test: (v: unknown) => boolean): Held<T>[] => {
        const hits = flat(value, rest).filter((v) => test(v.value));
        rest = L.and(rest, L.not(orOf(hits)));
        return hits;
      };
      const invoked = orOf(shape(step[invoke], (v) => !!v));
      if (!L.isFalse(invoked)) {
        const u = keys
          ? refTargetThrows(owner, [...keys, invoke], invoked, (at) => {
              const inputs = flat(step.inputs, at);
              const outInputs = empty();
              for (const option of inputs) {
                if (isObject(option.value)) into(outInputs, codeExpression(option.value.code, tryCodes, option.held));
                else outInputs.unbounded = L.or(outInputs.unbounded, option.held);
              }
              return outInputs;
            })
          : unbounded(invoked);
        u.plain = L.or(u.plain, invoked);
        into(out, u);
      }
      for (const thrown of shape(step.throw, (v) => !!v && typeof v === "object")) {
        into(out, codeExpression((thrown.value as Record<string, unknown>).code, tryCodes, thrown.held));
      }
      for (const rethrown of shape(step.rethrow, (v) => !!v && typeof v === "object")) into(out, caughtCodes(tryCodes, rethrown.held));
      for (const tried of shape(step.try, Array.isArray)) {
        const tryU = stepArrayThrows(owner, tried.value as unknown[], under(keys, "try"), invoke, tryCodes, tried.held);
        const caught = arrays(step.catch, tried.held);
        const propagated = restrict(tryU, caught.none);
        for (const list of caught.lists) {
          const codes = new Map<string, T>();
          for (const [code, entry] of tryU.codes) codes.set(code, entry.held);
          codes.set(PLAIN_ERROR_CODE, L.or(codes.get(PLAIN_ERROR_CODE) ?? L.FALSE, tryU.plain));
          const fromCatch = stepArrayThrows(owner, list.value, under(keys, "catch"), invoke, codes, list.held);
          fromCatch.unbounded = L.or(fromCatch.unbounded, L.and(tryU.unbounded, list.held));
          into(propagated, fromCatch);
        }
        for (const list of arrays(step.finally, tried.held).lists) {
          into(propagated, stepArrayThrows(owner, list.value, under(keys, "finally"), invoke, tryCodes, list.held));
        }
        into(out, propagated);
      }
      for (const branch of shape(step.then, Array.isArray)) {
        into(out, stepArrayThrows(owner, branch.value as unknown[], under(keys, "then"), invoke, tryCodes, branch.held));
        for (const list of arrays(step.else, branch.held).lists) into(out, stepArrayThrows(owner, list.value, under(keys, "else"), invoke, tryCodes, list.held));
        for (const list of arrays(step.elseif, branch.held).lists) {
          list.value.forEach((item, b) => {
            for (const elseif of flat(item, list.held)) {
              if (!isObject(elseif.value)) continue;
              for (const then of arrays(elseif.value.then, elseif.held).lists) {
                into(out, stepArrayThrows(owner, then.value, under(keys, "elseif", b, "then"), invoke, tryCodes, then.held));
              }
            }
          });
        }
      }
      for (const loop of shape(step.do, Array.isArray)) into(out, stepArrayThrows(owner, loop.value as unknown[], under(keys, "do"), invoke, tryCodes, loop.held));
      for (const cases of shape(step.cases, (v) => !!v && typeof v === "object")) {
        for (const [key, arr] of Object.entries(cases.value as Record<string, unknown>)) {
          for (const list of arrays(arr, cases.held).lists) into(out, stepArrayThrows(owner, list.value, under(keys, "cases", key), invoke, tryCodes, list.held));
        }
        for (const list of arrays(step.default, cases.held).lists) into(out, stepArrayThrows(owner, list.value, under(keys, "default"), invoke, tryCodes, list.held));
      }
      return out;
    }

    // --- The catch ladder -------------------------------------------------------
    const scopeListOf = (id: string): CatchListSite<T> | undefined => {
      const lists = (listsOf.get(id) ?? []).filter((l) => l.isScope);
      return lists[lists.length - 1];
    };
    /** Who encloses each resource through a `throwsThrough` slot, and where. */
    const enclosers = new Map<string, { by: string; held: T }[]>();
    const enclosed = new Map<string, { target: string; held: T }[]>();
    for (const id of order.keys()) {
      for (const site of drivenOf.get(id) ?? []) {
        if (site.kind !== "ref" || site.built || !site.refSlots.some((slot) => slot.throwsThrough)) continue;
        for (const target of throughTargets(id, site, site.held)) {
          if (target.to === undefined) continue;
          (enclosers.get(target.to) ?? enclosers.set(target.to, []).get(target.to)!).push({ by: id, held: target.held });
          (enclosed.get(id) ?? enclosed.set(id, []).get(id)!).push({ target: target.to, held: target.held });
        }
      }
    }

    /** Where a list's own entries render `code` — `null` for a code no `when:`
     *  can name. */
    const answers = (part: ListPart<T>, code: string | null): T =>
      part.entries.reduce(
        (all, entry) =>
          L.or(
            all,
            orOf(entry.readings.filter((r) => r.value.catchAll || (code !== null && r.value.proven && r.value.codes.has(code)))),
          ),
        L.FALSE,
      );

    const rungMemo = new Map<string, { held: T; covered: T }[]>();
    const rungDone = new Map<string, T>();
    /** Where, within `held`, every scope enclosing `id` covers `code`. */
    function rungCovers(id: string, code: string | null, held: T, walking: Set<string>): T {
      const key = `${code ?? "\0"}\0${id}`;
      let covered = L.FALSE;
      for (const entry of rungMemo.get(key) ?? []) covered = L.or(covered, L.and(entry.covered, held));
      const fresh = L.and(held, L.not(rungDone.get(key) ?? L.FALSE));
      if (L.isFalse(fresh)) return covered;
      const list = scopeListOf(id);
      const own = list ? orOf(list.parts.map((p) => ({ held: L.and(p.held, answers(p, code)) }))) : L.FALSE;
      walking.add(id);
      const around = enclosers.get(id) ?? [];
      let any = L.FALSE;
      let every = L.TRUE;
      for (const { by, held: through } of around) {
        const at = L.and(fresh, through);
        if (L.isFalse(at)) continue;
        any = L.or(any, at);
        const theirs = walking.has(by) ? L.FALSE : rungCovers(by, code, at, walking);
        every = L.and(every, L.or(L.not(at), theirs));
      }
      walking.delete(id);
      const result = L.and(fresh, L.or(own, L.and(any, every)));
      (rungMemo.get(key) ?? rungMemo.set(key, []).get(key)!).push({ held: fresh, covered: result });
      rungDone.set(key, L.or(rungDone.get(key) ?? L.FALSE, fresh));
      return L.or(covered, result);
    }

    /** The scope lists on a resource's ladder, each with where it is on it. */
    const ladderLists = (id: string, held: T): { list: CatchListSite<T>; held: T }[] => {
      const out: { list: CatchListSite<T>; held: T }[] = [];
      const seen = new Map<string, T>();
      const walk = (at: string, h: T): void => {
        const fresh = L.and(h, L.not(seen.get(at) ?? L.FALSE));
        if (L.isFalse(fresh)) return;
        seen.set(at, L.or(seen.get(at) ?? L.FALSE, fresh));
        const list = scopeListOf(at);
        if (list) out.push({ list, held: fresh });
        for (const { by, held: through } of enclosers.get(at) ?? []) walk(by, L.and(fresh, through));
      };
      walk(id, held);
      return out;
    };

    const scopeUnions = new Map<CatchListSite<T>, Union<T>>();
    /** What a list is checked against. */
    const checkedAgainst = (list: CatchListSite<T>, held: T): Union<T> => {
      if (list.isScope) {
        let u = scopeUnions.get(list);
        if (!u) scopeUnions.set(list, (u = scopeUnionOf(list.node, orOf(list.parts), new Map())));
        return restrict(u, held);
      }
      return handlerUnion(list, held);
    };
    /** What a list's entries may name: its union, and the codes raised into it. */
    const denominatorOf = (list: CatchListSite<T>, held: T): Union<T> => {
      const out = checkedAgainst(list, held);
      const raise = (from: CatchListSite<T>, at: T): void => {
        const present = L.and(at, orOf(from.parts));
        for (const [code, meta] of from.raises) addCode(out, code, meta, present);
      };
      raise(list, held);
      if (list.isScope) {
        const seen = new Map<string, T>();
        const walk = (id: string, at: T): void => {
          const fresh = L.and(at, L.not(seen.get(id) ?? L.FALSE));
          if (L.isFalse(fresh)) return;
          seen.set(id, L.or(seen.get(id) ?? L.FALSE, fresh));
          for (const other of listsOf.get(id) ?? []) raise(other, fresh);
          for (const { target, held: through } of enclosed.get(id) ?? []) walk(target, L.and(fresh, through));
        };
        walk(list.node, held);
      }
      return out;
    };

    /** A handler's union, as a list renders it. */
    function handlerUnion(list: CatchListSite<T>, held: T): Union<T> {
      const out = empty();
      if (!list.handlerKeys) return out;
      const owner = list.node;
      for (const value of readAt(rootOf(owner), list.handlerKeys, held)) {
        if (typeof value.value === "string") {
          const definition = definitionFor(value.value, nodeModule(owner));
          const block = definition ? throwsBlockOf(definition, ctx) : undefined;
          if (!block) continue;
          const codes = new Map<string, ThrowsCodeMeta>();
          for (const [code, meta] of Object.entries(block.codes ?? {})) codes.set(code, { data: (meta as { data?: Record<string, any> }).data });
          into(out, fromPlain({ codes, unbounded: block.passthrough === true || block.inherit === true }, value.held));
          continue;
        }
        if (value.value === null || typeof value.value !== "object") continue;
        for (const { edge, to, held: at } of targetsAt(owner, list.handlerKeys, value.held)) {
          if (to !== undefined) into(out, unionOf(to, at));
          else {
            const internal = libraryTarget(edge);
            if (internal) into(out, plainUnion(internal, at));
          }
        }
      }
      return out;
    }

    // --- Findings -----------------------------------------------------------------
    const found: { held: T; render: Found<T>["render"]; rank: number[] }[] = [];
    /** Where a run's own finding about node `id` stands, at `path` of it. */
    const ownPlace = (id: string, path: string, read: WorldReader<T>): ThrowsPlacement => {
      const { kind, name, manifest } = graph.identityBy(id, read);
      return { resource: { kind, name }, filePath: (manifest.metadata as { source?: string } | undefined)?.source, path };
    };
    const placed = (id: string, keys: Keys, read: WorldReader<T>, suffix = ""): ThrowsPlacement => {
      // A list a run judges absent is named where it would be written.
      const last = keys[keys.length - 1];
      const parent = typeof last === "string" ? graph.relativePathBy(id, keys.slice(0, -1), read) : undefined;
      const relative = parent === undefined ? graph.relativePathBy(id, keys, read) : parent === "" ? last : `${parent}.${last}`;
      return ownPlace(id, `${relative}${suffix}`, read);
    };
    /** `found`, about node `id`: placement moves it to where it is written. */
    const about = (id: string, found: AnalysisDiagnostic[]): AnalysisDiagnostic[] => found.map((d) => aboutDeclaration(d, id));
    /** Where an item stands in its list where `holds` reads. */
    const indexAt = (items: readonly { index: number; present: T }[], index: number, holds: (t: T) => boolean): number =>
      items.filter((item) => item.index < index && holds(item.present)).length;

    const sortedIds = [...order.keys()];
    // Returns lists: rule 7.
    for (const id of sortedIds) {
      const node = graph.node(id)!;
      for (const site of (returnsOf.get(id) ?? []).sort((a, b) => compareRanks(a.rank, b.rank))) {
        if (bodyWroteWhole(node, site.keys.slice(node.keys.length))) continue;
        for (const option of readAt(rootOf(id), site.keys, site.held)) {
          if (!Array.isArray(option.value)) continue;
          const entries = option.value.map((item, i) => ({ index: i, present: orOf(flat(item, option.held).filter((e) => e.value !== undefined)) }));
          option.value.forEach((item, i) => {
            const catchAll = orOf(
              flat(item, option.held).flatMap((e) => (e.value === undefined ? [] : flat(isObject(e.value) ? e.value.when : undefined, e.held).filter((w) => !w.value))),
            );
            const later = orOf(entries.filter((e) => e.index > i).map((e) => ({ held: e.present })));
            const held = L.and(catchAll, later);
            if (L.isFalse(held)) return;
            found.push({
              held,
              rank: [0, order.get(id)!, ...site.rank, i],
              render: (read) =>
                about(id, [catchAllNotLastDiagnostic("returns", indexAt(entries, i, read.holds), placed(id, [...site.keys, i], read))]),
            });
          });
        }
      }
    }

    // Catch lists: rules 7, 4, 1 and the unbounded union.
    for (const id of sortedIds) {
      const node = graph.node(id)!;
      const lists = [...(listsOf.get(id) ?? [])].sort((a, b) => compareRanks(a.rank, b.rank));
      lists.forEach((list, listIndex) => {
        const own = list.keys.slice(node.keys.length);
        const present = orOf(list.parts);
        const bodyList = (l: CatchListSite<T>): boolean => bodyWroteWhole(graph.node(l.node)!, l.keys.slice(graph.node(l.node)!.keys.length));
        const rank = (n: number) => [1, order.get(id)!, ...list.rank, listIndex, n];
        let judged = present;
        if (bodyList(list)) {
          if (list.isScope) return;
          const open = orOf(ladderLists(id, present).filter((l) => !bodyList(l.list)));
          judged = L.and(present, open);
        } else {
          list.parts.forEach((part) => {
            const entries = part.entries.map((e) => ({ index: e.index, present: orOf(e.readings) }));
            part.entries.forEach((entry) => {
              const catchAll = orOf(entry.readings.filter((r) => r.value.unguarded));
              const held = L.and(catchAll, orOf(entries.filter((e) => e.index > entry.index).map((e) => ({ held: e.present }))));
              if (L.isFalse(held)) return;
              found.push({
                held,
                rank: rank(0),
                render: (read) =>
                  about(id, [catchAllNotLastDiagnostic("catches", indexAt(entries, entry.index, read.holds), placed(id, [...list.keys, entry.index], read))]),
              });
            });
            const denominator = denominatorOf(list, part.held);
            part.entries.forEach((entry) => {
              for (const r of entry.readings) {
                if (r.value.catchAll || !r.value.proven) continue;
                for (const code of r.value.codes) {
                  if (isAmbientContractErrorCode(code)) continue;
                  const held = L.and(r.held, L.not(has(denominator, code)));
                  if (L.isFalse(held)) continue;
                  found.push({
                    held,
                    rank: rank(1),
                    render: (read) =>
                      about(id, [
                        undeclaredCodeDiagnostic(
                          indexAt(entries, entry.index, read.holds),
                          code,
                          [...denominator.codes].filter(([, c]) => read.holds(c.held)).map(([name]) => name),
                          read.holds(denominator.unbounded),
                          denominatorText(list.isScope),
                          placed(id, [...list.keys, entry.index], read, ".when"),
                        ),
                      ]),
                  });
                }
              }
            });
          });
          if (list.isScope) return;
        }
        if (L.isFalse(judged)) return;
        const u = checkedAgainst(list, judged);
        for (const part of list.parts) {
          const at = L.and(part.held, judged);
          if (L.isFalse(at)) continue;
          const covered = (code: string | null): T => L.or(answers(part, code), rungCovers(id, code, at, new Set()));
          const open = L.and(at, L.and(u.unbounded, L.not(covered(null))));
          if (!L.isFalse(open)) {
            found.push({ held: open, rank: rank(2), render: (read) => about(id, [unboundedUnionDiagnostic(placed(id, list.keys, read))]) });
          }
          const uncovered = [...u.codes].map(([code, entry]) => ({ code, held: L.and(at, L.and(entry.held, L.not(covered(code)))) }));
          const anyUncovered = orOf(uncovered);
          if (L.isFalse(anyUncovered)) continue;
          found.push({
            held: anyUncovered,
            rank: rank(3),
            render: (read) =>
              about(id, [
                uncoveredCodesDiagnostic(
                  handlerAt(list, read),
                  uncovered.filter((c) => read.holds(c.held)).map((c) => c.code).sort(),
                  list.codeChains[0],
                  placed(id, list.keys, read),
                ),
              ]),
          });
        }
      });
    }

    /** The handler of a list as a run's message names it where `read` reads. */
    function handlerAt(list: CatchListSite<T>, read: WorldReader<T>): string {
      const value = readAt(rootOf(list.node), list.handlerKeys!, L.TRUE).find((v) => read.holds(v.held))?.value;
      if (typeof value === "string") return handlerText({ kind: value });
      if (isObject(value) && !isRefSentinel(value) && typeof value.kind === "string") {
        const named = (value.metadata as { name?: unknown } | undefined)?.name;
        return typeof named === "string" ? handlerText({ ref: named }) : handlerText({ inline: value.kind });
      }
      if (isRefSentinel(value)) {
        const target = targetsAt(list.node, list.handlerKeys!, L.TRUE).find((t) => read.holds(t.held));
        if (target?.to !== undefined) return handlerText({ ref: graph.identityBy(target.to, read).name });
        return handlerText({ ref: value.source });
      }
      return handlerText({});
    }

    // Retry policies over a dispatch: what each re-attempt can see fail.
    const retried = (id: string, policyKeys: Keys, policy: Held<T>, u: Union<T>, rankBase: number[]): void => {
      const region = L.and(policy.held, L.not(u.unbounded));
      if (L.isFalse(region) || !isObject(policy.value)) return;
      for (const list of arrays(policy.value.nonRetryable, region).lists) {
        const items = list.value.map((item, i) => ({ index: i, present: orOf(flat(item, list.held).filter((v) => v.value !== undefined)) }));
        list.value.forEach((item, i) => {
          for (const code of flat(item, list.held)) {
            if (typeof code.value !== "string" || isAmbientContractErrorCode(code.value)) continue;
            const name = code.value;
            const held = L.and(code.held, L.not(has(u, name)));
            if (L.isFalse(held)) continue;
            found.push({
              held,
              rank: [...rankBase, 0, i],
              render: (read) =>
                about(id, [
                  nonRetryableNotThrownDiagnostic(
                    name,
                    [...u.codes].filter(([, c]) => read.holds(c.held)).map(([c]) => c),
                    ownPlace(id, `${graph.relativePathBy(id, [...policyKeys, "nonRetryable"], read)}[${indexAt(items, i, read.holds)}]`, read),
                  ),
                ]),
            });
          }
        });
      }
      // The data each class of codes the union may hold declares, judged once per class.
      let classes: { held: T; datas: Record<string, any>[] }[] = [{ held: region, datas: [] }];
      for (const [, entry] of u.codes) {
        const withData = entry.metas.filter((m) => m.meta.data);
        if (withData.length === 0) continue;
        classes = classes.flatMap((c) => [
          ...withData.map((m) => ({ held: L.and(c.held, m.held), datas: [...c.datas, m.meta.data!] })),
          { held: L.and(c.held, L.not(orOf(withData))), datas: c.datas },
        ]).filter((c) => !L.isFalse(c.held));
      }
      for (const retryAfter of flat(policy.value.retryAfter, region)) {
        if (retryAfter.value === undefined) continue;
        for (const c of classes) {
          const held = L.and(c.held, retryAfter.held);
          if (L.isFalse(held) || c.datas.length === 0) continue;
          const dataSchema = intersectDataSchemas(c.datas);
          const probe = collectCelStrings(retryAfter.value, "retryAfter").flatMap((entry) =>
            checkCelChainAgainstDataSchema(entry, dataSchema, { kind: "", name: "" }, undefined, env),
          );
          if (probe.length === 0) continue;
          found.push({
            held,
            rank: [...rankBase, 1],
            render: (read) => {
              const place = ownPlace(id, `${graph.relativePathBy(id, policyKeys, read)}.retryAfter`, read);
              return about(
                id,
                collectCelStrings(retryAfter.value, place.path).flatMap((entry) =>
                  checkCelChainAgainstDataSchema(entry, dataSchema, place.resource, place.filePath, env),
                ),
              );
            },
          });
        }
      }
    };

    for (const id of sortedIds) {
      const module = nodeModule(id);
      if (module && rootModules.size > 0 && !rootModules.has(module)) continue;
      const definition = definitionOf(id);
      if (!definition?.schema) continue;
      const node = graph.node(id)!;
      const steps = (drivenOf.get(id) ?? []).filter((s) => s.kind === "step" && !s.built);
      const schema = defs.effectiveSchemaOf(definition);
      steps.sort((a, b) => compareRanks(schemaRank(schema, a.keys.slice(node.keys.length)), schemaRank(schema, b.keys.slice(node.keys.length))));
      let counter = 0;
      const walk = (list: unknown[], keys: Keys, invoke: string, held: T): void => {
        list.forEach((item, i) => {
          for (const step of flat(item, held)) {
            const value = step.value;
            if (!isObject(value)) continue;
            const at = [...keys, i];
            const invoked = orOf(flat(value[invoke], step.held).filter((v) => !!v.value));
            if (!L.isFalse(invoked)) {
              for (const policy of flat(value.retry, invoked)) {
                if (!isObject(policy.value)) continue;
                const u = refTargetThrows(id, [...at, invoke], policy.held, (h) => {
                  const out = empty();
                  for (const inputs of flat(value.inputs, h)) {
                    if (isObject(inputs.value)) into(out, codeExpression(inputs.value.code, undefined, inputs.held));
                    else out.unbounded = L.or(out.unbounded, inputs.held);
                  }
                  return out;
                });
                const timed = orOf(flat(value.timeout, policy.held).filter((v) => v.value !== undefined));
                addCode(u, "ERR_STEP_TIMEOUT", {}, timed);
                retried(id, [...at, "retry"], policy, u, [2, order.get(id)!, counter++]);
              }
            }
            const rest = L.and(step.held, L.not(invoked));
            if (L.isFalse(rest)) continue;
            for (const key of STEP_BRANCHES) for (const branch of arrays(value[key], rest).lists) walk(branch.value, [...at, key], invoke, branch.held);
            for (const branches of arrays(value.elseif, rest).lists) {
              branches.value.forEach((b, j) => {
                for (const elseif of flat(b, branches.held)) {
                  if (!isObject(elseif.value)) continue;
                  for (const then of arrays(elseif.value.then, elseif.held).lists) walk(then.value, [...at, "elseif", j, "then"], invoke, then.held);
                }
              });
            }
            for (const cases of flat(value.cases, rest)) {
              if (!cases.value || typeof cases.value !== "object") continue;
              for (const [key, arr] of Object.entries(cases.value as Record<string, unknown>)) {
                for (const list of arrays(arr, cases.held).lists) walk(list.value, [...at, "cases", key], invoke, list.held);
              }
            }
          }
        });
      };
      for (const site of steps) {
        for (const invoke of new Set(site.stepSlots.map((slot) => slot.invoke))) {
          for (const list of readAt(rootOf(id), site.keys, site.held)) if (Array.isArray(list.value)) walk(list.value, site.keys, invoke, list.held);
        }
      }
      for (const { held: present, value: content } of contents.get(id) ?? []) {
        for (const { field, retryFor } of retryForSites(definition.schema)) {
          for (const policy of flat((content as Record<string, unknown>)[field], present)) {
            if (!isObject(policy.value)) continue;
            const u = refTargetThrows(id, [...node.keys, retryForTargetField(retryFor)], policy.held);
            for (const [code, meta] of retryFor.codes) addCode(u, code, meta, policy.held);
            retried(id, [...node.keys, field], policy, u, [2, order.get(id)!, counter++]);
          }
        }
      }
    }

    found.sort((a, b) => compareRanks(a.rank, b.rank));
    return { found };
  }

  const conditions = project<Condition>({ ...graph.conditionWorld(), option: (option) => option.condition });
  const fixed = (diagnostic: AnalysisDiagnostic) => () => [diagnostic];
  const found: ReadFinding[] = [
    ...declarations.map((diagnostic) => ({ held: TRUE, render: fixed(diagnostic) })),
    ...conditions.found.map((entry) => ({ held: entry.held, render: (read: WorldReader<Condition>) => entry.render(read) })),
  ];
  const dead: DeadFinding[] = readDeadBranches("throwsCoverage", inputs.deadBranches, (branch) => {
    const witness: World = branch.world;
    const world: ThrowsWorld<boolean> = {
      ...graph.witnessWorld(witness),
      option: (option) => takenAt(space, option.condition, option.path, witness.assignment, witness.forcing),
    };
    return [
      ...declarations.map((diagnostic) => ({ branch, render: fixed(diagnostic) })),
      ...project(world).found.filter((entry) => entry.held).map((entry) => ({ branch, render: (read: WorldReader<boolean>) => entry.render(read) })),
    ];
  });
  return { found, dead };
}

