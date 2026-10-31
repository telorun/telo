/**
 * Every `!if` / `!switch` outside a template body, read once per manifest set:
 * what each condition and selector reads (the one decidability rule), the
 * dimensions those reads reach, the configurations their product is, which
 * branch each choice takes in a configuration, and every refusal a choice is
 * owed — `BRANCH_UNDECIDABLE`, `BRANCH_CONDITION_INVALID`,
 * `BRANCH_CASE_KEY_INVALID`, `BRANCH_NOT_EXHAUSTIVE`, `BRANCH_CASE_UNREACHABLE`,
 * `BRANCH_CASE_INVALID`.
 *
 * One reading serves both halves: the analysis enumerates its configurations
 * and expands each, and the kernel asks it for the branches of the one
 * configuration the process started with. Positions and shapes are the
 * expansion reader's (`expansion-sites.ts`); a tag it refuses is never
 * expanded, and whatever is reported beneath it is dropped with its
 * consequences. A choice nothing decides — refused, undecidable, or matching
 * no case in a configuration — is decided as {@link STAND_IN} there, and what
 * is reported at or beneath it is dropped the same way. A module call a
 * condition makes is judged and evaluated in the {@link ChoiceScope}.
 *
 * A library's documents a consumer's analysis holds (its forwarded exports)
 * read the library's inputs as the import binds them — the import of their own
 * instance, where the library is imported several times: a literal is a fact,
 * an expression whose every read is decidable in the importer is evaluated
 * there per configuration, and anything else is `BRANCH_UNDECIDABLE` at that
 * import's binding. A library's inputs never add a dimension of their own.
 *
 * Browser-safe.
 */
import { listRequests } from "./declaration-requests.js";
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  celEngine,
  MODULE_CALL_DISPATCH_KEY,
  expansionTagLabel,
  expansionTagOf,
  isExpansionSentinel,
  isTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import {
  ABSENT,
  asDeclared,
  assignmentKey,
  enumerateConfigurations,
  memberDomain,
  memberOfValue,
  PRESENT,
  wholeDomain,
  projectionName,
  readNeedInput,
  readRootInput,
  rootInputValues,
  type Assignment,
  type Dimension,
  type ReachedNeed,
  type RootReading,
} from "./configuration-dimensions.js";
import { moduleNamesEnvironment } from "./cel-environment.js";
import type { ChoiceScope, NeedReach } from "./choice-scope.js";
import { readDecisionExpression, type DecisionExpression, type InputBlock, type InputRead } from "./decision-reads.js";
import {
  buildKernelGlobalsIndex,
  type DecidedInput,
  type DecidedInputs,
  type InputNarrowing,
} from "./kernel-globals.js";
import { membersSlotOf } from "./members-value-slot.js";
import { FALSE, TRUE, type Condition, type ConditionSpace } from "./presence-condition.js";
import type { BranchConditions } from "./conditioned-expansion.js";
import { authoredModuleMetadata } from "./module-metadata-scope.js";
import { checkName, type NameLevel } from "./identifier-name.js";
import { importPathOf } from "./scoped-name-resolver.js";
import { isModuleKind } from "./module-kinds.js";
import { readNeeds } from "./need-type.js";
import { readResourceInputs, readSuppliedResources } from "./resource-input.js";
import { compileRuleCondition, forbiddenCatalogCall, ruleEnv } from "./rule-condition.js";
import { isKindDocumentOrImport } from "./system-kinds.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";

const SOURCE = "telo-analyzer";

/** One `!if` / `!switch` where it is written. */
export interface ChoiceSite {
  readonly sentinel: ExpansionSentinel;
  readonly tag: "if" | "switch";
  /** The top-level document holding it; a whole-document tag is its own. */
  readonly holder: ResourceManifest;
  readonly keys: readonly (string | number)[];
  /** At a declaration position: each branch declares the resource the
   *  outermost tag names. */
  readonly declaration: boolean;
  /** The branch of an enclosing choice this one sits in. */
  readonly parent?: { readonly site: ChoiceSite; readonly branch: string };
  readonly module: string | undefined;
  /** The instance of its module the holder was forwarded as, where the module
   *  is imported several times. */
  readonly importPath?: readonly string[];
  /** Of the analysed root's own modules — reported where written. */
  readonly own: boolean;
}

/** A diagnostic with the configurations it holds in; none means every one. */
export interface ConfigurationDiagnostic {
  readonly diagnostic: AnalysisDiagnostic;
  readonly configurations?: ReadonlySet<string>;
}

/** Which branch every choice takes in one configuration: a branch id
 *  (`then`, `else`, `default`, `case:<key>`), `null` for none, or
 *  {@link STAND_IN}. */
export type Decisions = ReadonlyMap<ExpansionSentinel, string | null>;

/** What a choice nothing decides expands to — one refused or undecidable, or
 *  one no case covers in a configuration: a stand-in claiming nothing, so no
 *  branch is judged until the choice is decided. */
export const STAND_IN = "\0stand-in";

/** A construct a configuration expands to a stand-in, by the document holding
 *  it and its path there. */
export interface StandInConstruct {
  readonly holder: ResourceManifest;
  readonly path: string;
}

export interface ChoiceReading {
  readonly sites: readonly ChoiceSite[];
  readonly dimensions: readonly Dimension[];
  /** Every configuration, in enumeration order; one empty assignment when no
   *  choice reads a dimension. */
  readonly configurations: readonly Assignment[];
  readonly diagnostics: readonly ConfigurationDiagnostic[];
  /** The branch each choice takes under `assignment`. */
  decide(assignment: Assignment): Decisions;
  /** What `assignment` decides of each module's inputs, for typing. */
  narrowing(assignment: Assignment): InputNarrowing;
  /** Every choice `assignment` expands to a stand-in — a choice `forcing`
   *  forces taking its forced branch: what the analysis finds at or beneath
   *  one is dropped, its own refusal being the one report. */
  standIns(assignment: Assignment, forcing?: Decisions): readonly StandInConstruct[];
  /** Every branch of the root's own choices no configuration takes — each
   *  still checked, by an expansion taking it in a configuration reaching its
   *  choice. */
  readonly unreachable: readonly UnreachableBranch[];
  /** Every branch refused as `BRANCH_CASE_INVALID`: what the analysis finds
   *  beneath one is its consequence, reported once by the refusal. */
  readonly refusedBranches: readonly { readonly holder: ResourceManifest; readonly path: string }[];
  /** The value of `source`, written in `holder`, in `assignment` — when every
   *  name it reads is a literal or a dimension of this reading; undefined when
   *  the configuration does not decide it. */
  valueIn(holder: ResourceManifest, source: string, assignment: Assignment): { value: unknown } | undefined;
  /** Every value {@link valueIn} gives `source` over `space`, each with the
   *  configurations giving it — evaluated once per assignment of the dimensions
   *  it reads, never per configuration; undefined where no configuration
   *  decides it. */
  valueOutcomes(
    holder: ResourceManifest,
    source: string,
    space: ConditionSpace,
  ): readonly { readonly value: unknown; readonly condition: Condition }[] | undefined;
  /** The condition each choice takes each of its branches under, over
   *  `space` — this reading's dimensions, their domains possibly narrowed —
   *  regardless of the branch enclosing it, as {@link decide} reads it: each
   *  choice decided once per assignment of the dimensions its own condition
   *  reads, never per configuration. */
  branchConditions(space: ConditionSpace): BranchConditions;
  /** The dimensions {@link narrowing} reads to decide `input.<name>` (every
   *  input of the block when `name` is omitted) of one module instance: a root
   *  module's own dimensions of that input; for an imported instance, decided
   *  through its import's bindings, every dimension. */
  inputDimensions(
    module: string | undefined,
    importPath: readonly string[] | undefined,
    input: "variables" | "secrets" | "resources",
    name?: string,
  ): readonly Dimension[];
}

export interface UnreachableBranch {
  readonly site: ChoiceSite;
  readonly branch: string;
  /** Where the branch is written in its holder. */
  readonly keys: readonly (string | number)[];
  /** A configuration in which its choice is reached. */
  readonly baseline: Assignment;
}

/** Where the module a document belongs to binds its inputs. */
interface Binding {
  /** The import writing it — the module its expressions are written in. */
  readonly importDoc: ResourceManifest;
  readonly owner: string;
  /** The instance of the owner the binding is written in, where it is one of
   *  several. */
  readonly ownerPath?: readonly string[];
  readonly alias: string;
  readonly filePath?: string;
  readonly value: unknown;
  readonly present: boolean;
}

type Resolution =
  | {
      readonly kind: "root";
      readonly module: string;
      readonly read: InputRead;
      /** The importer's binding the read was carried through, nearest the root. */
      readonly via?: BindingAnchor;
    }
  | { readonly kind: "constant"; readonly value: unknown }
  /** A need's presence or a member of one of its fields, read off the need it
   *  reaches — a dimension of the analysed root whoever reads it. */
  | { readonly kind: "need"; readonly read: InputRead; readonly need: ReachedNeed }
  | {
      readonly kind: "open";
      readonly reason: string;
      /** The importer's binding the open value is written at, when it is one. */
      readonly binding?: BindingAnchor;
    }
  | {
      readonly kind: "derived";
      readonly owner: string;
      readonly expression: DecisionExpression;
      readonly parts: readonly Resolution[];
      readonly via?: BindingAnchor;
    };

/** An import's binding of one library input, as a diagnostic anchor. */
interface BindingAnchor {
  readonly owner: string;
  readonly filePath?: string;
  readonly path: string;
  readonly alias: string;
}

/** A read that neither is a dimension nor is open: a `module.<field>`, or a
 *  module call, judged by its callee. */
type Neutral = { readonly kind: "module" } | { readonly kind: "call"; readonly qualified: string };

/** The value of a site's condition or selector. */
type Decision =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "expression"; readonly expression: DecisionExpression; readonly resolutions: readonly (Resolution | Neutral)[] }
  | { readonly kind: "invalid"; readonly message: string };

/** Read every choice of `manifests` (declarations) and `documents` (whole
 *  documents behind a tag). `scope` resolves the module calls a condition
 *  makes and the kinds its branches declare; without it a call reaches no
 *  function and every name is value-level. */
export function readChoices(
  manifests: readonly ResourceManifest[],
  documents: readonly ResourceManifest[],
  scope?: ChoiceScope,
  /** Expressions a template body's choice reads in a consumer's own values
   *  (`template-consumers.ts`): the dimensions they reach are this reading's. */
  consumerReads: readonly { readonly holder: ResourceManifest; readonly source: string }[] = [],
  /** The choices the expansion reader refuses as written: its refusal is the
   *  one report they are owed, so none is a stand-in whose place is dropped. */
  refused: ReadonlySet<unknown> = new Set(),
): ChoiceReading {
  const roots = new Set(
    manifests.filter((m) => isModuleKind(m.kind)).map((m) => m.metadata?.name as string).filter(Boolean),
  );
  const firstRoot = roots.values().next().value as string | undefined;
  const moduleOf = (doc: ResourceManifest): string | undefined =>
    ((doc.metadata as { module?: unknown } | undefined)?.module as string | undefined) ?? firstRoot;
  const isOwn = (doc: ResourceManifest): boolean => {
    const module = (doc.metadata as { module?: unknown } | undefined)?.module;
    return typeof module !== "string" || roots.has(module);
  };

  const sites = collectSites(manifests, documents, moduleOf, isOwn);
  if (sites.length === 0 && consumerReads.length === 0) {
    return {
      sites,
      dimensions: [],
      configurations: [{}],
      diagnostics: [],
      decide: () => new Map(),
      narrowing: () => () => undefined,
      standIns: () => [],
      unreachable: [],
      refusedBranches: [],
      branchConditions: () => new Map(),
      inputDimensions: () => [],
      valueIn: (holder, source) => moduleOnlyValue(source),
      valueOutcomes: (holder, source) => {
        const decided = moduleOnlyValue(source);
        return decided ? [{ value: decided.value, condition: TRUE }] : undefined;
      },
    };
  }

  // What each module declares and how a library's inputs are bound.
  const moduleDocs = new Map<string, Record<string, any>>();
  for (const m of manifests) if (isModuleKind(m.kind)) moduleDocs.set(m.metadata?.name as string, m as Record<string, any>);
  const libraryGlobals = new Map<string, Record<string, any>>();
  for (const m of [...manifests, ...documents]) {
    const meta = m.metadata as { module?: string; moduleGlobals?: Record<string, any> } | undefined;
    if (meta?.module && meta.moduleGlobals && !libraryGlobals.has(meta.module)) {
      libraryGlobals.set(meta.module, meta.moduleGlobals);
    }
  }
  const declarationOf = (module: string, input: "variables" | "secrets", name: string) => {
    const block = (roots.has(module) ? moduleDocs.get(module) : libraryGlobals.get(module))?.[input];
    const entry = block && typeof block === "object" ? block[name] : undefined;
    return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
  };
  const moduleMetadata = (module: string | undefined): Record<string, unknown> => {
    if (!module) return {};
    if (roots.has(module)) return authoredModuleMetadata(moduleDocs.get(module)?.metadata);
    return authoredModuleMetadata(libraryGlobals.get(module)?.module as Record<string, unknown> | undefined);
  };
  const imports = manifests.filter((m) => m.kind === "Telo.Import");
  const importerOf = (m: ResourceManifest) => (m.metadata as { module?: string }).module ?? firstRoot ?? "";
  /** The import reaching `module`'s instance at `path`: the import at that
   *  path (the last alias, written by the instance one up); for a module
   *  imported once, its one import; for a shared one, whichever import —
   *  every import of it must agree. */
  const importReaching = (
    module: string,
    path: readonly string[] | undefined,
  ): { importDoc: ResourceManifest; shared: boolean } | undefined => {
    const reaching = imports.filter(
      (m) => (m.metadata as { resolvedModuleName?: string } | undefined)?.resolvedModuleName === module,
    );
    const shared = reaching.some((m) => (m.metadata as { sharedLibrary?: unknown }).sharedLibrary === true);
    const chosen = path && !shared
      ? reaching.find(
          (m) =>
            m.metadata?.name === path[path.length - 1] && (path.length === 1) === roots.has(importerOf(m)),
        )
      : reaching[0];
    return chosen ? { importDoc: chosen, shared } : undefined;
  };
  /** How the import reaching `module`'s instance binds one of its inputs. */
  const bindingOf = (
    module: string,
    input: "variables" | "secrets",
    name: string,
    path: readonly string[] | undefined,
  ): Binding | undefined => {
    const chosen = importReaching(module, path);
    if (!chosen) return undefined;
    const { shared } = chosen;
    const block = (chosen.importDoc as Record<string, any>)[input];
    const present = !!block && typeof block === "object" && Object.hasOwn(block, name);
    return {
      importDoc: chosen.importDoc,
      owner: importerOf(chosen.importDoc),
      ...(path && !shared && path.length > 1 ? { ownerPath: path.slice(0, -1) } : {}),
      alias: chosen.importDoc.metadata?.name as string,
      filePath: (chosen.importDoc.metadata as { source?: string }).source,
      value: present ? block[name] : undefined,
      present,
    };
  };

  /** Why a module call written in `caller` cannot be decided before boot. */
  const callRefusal = (caller: ResourceManifest, qualified: string): string | undefined =>
    scope
      ? scope.callRefusal(caller, qualified)
      : "reaches no function this module can call; a choice is decided before boot, so every call it makes must reach a function written in CEL";
  /** `source` evaluated as written in `caller`'s module: its calls dispatch
   *  through that module's functions. */
  const evaluateIn = (caller: ResourceManifest | undefined, source: string, activation: Record<string, unknown>) =>
    evaluate(
      source,
      caller && scope ? { ...activation, [MODULE_CALL_DISPATCH_KEY]: scope.dispatch(caller) } : activation,
      caller && scope ? scope.moduleNames(caller) : undefined,
    );

  // Which library inputs the decisions read, and the bindings they go through —
  // per module instance.
  const instanceKey = (module: string, path: readonly string[] | undefined) =>
    path ? `${module}\0${path.join("/")}` : module;
  const libraryReads = new Map<
    string,
    Map<string, { input: "variables" | "secrets"; name: string; binding?: Binding; projections: Set<string> }>
  >();
  // What each module instance's `resources.<name>` reads reach, by name.
  const needReads = new Map<string, Map<string, Resolution[]>>();
  /** The need `name` of `module` reaches, without a scope: a root module's own
   *  need, whose type's fields are unknown here. */
  const unscopedNeedOf = (module: string, name: string): NeedReach | undefined => {
    if (!roots.has(module)) return undefined;
    const need = readNeeds(moduleDocs.get(module)).find((n) => n.name === name);
    return need ? { kind: "reached", need: { path: [name], optional: need.optional, fields: {} } } : undefined;
  };
  /** What a `resources.<name>` read of one of `module`'s resource inputs
   *  amounts to: in the module's own reading an optional input's presence is
   *  its dimension, keyed as a need's; in a consumer's, the import reaching the
   *  instance supplies it or not — a literal fact. Undefined when `name` is no
   *  resource input of `module`. */
  const resourceInputRead = (module: string, read: InputRead, path: readonly string[] | undefined): Resolution | undefined => {
    let optional: boolean;
    let supplied: boolean | undefined;
    if (roots.has(module)) {
      const input = readResourceInputs(moduleDocs.get(module)).find((i) => i.name === read.name);
      if (!input) return undefined;
      optional = input.optional;
    } else {
      const reaching = importReaching(module, path)?.importDoc;
      const meta = reaching?.metadata as
        | { requiredResources?: Record<string, string>; optionalResources?: readonly string[] }
        | undefined;
      if (!reaching || !meta?.requiredResources || !Object.hasOwn(meta.requiredResources, read.name)) return undefined;
      optional = meta.optionalResources?.includes(read.name) === true;
      supplied = Object.hasOwn(readSuppliedResources(reaching), read.name);
    }
    if (read.projection !== "presence") {
      return { kind: "open", reason: `'${read.chain}' reads a resource input's published state, which is not known before boot` };
    }
    if (!optional) return { kind: "constant", value: PRESENT };
    if (supplied !== undefined) return { kind: "constant", value: supplied ? PRESENT : ABSENT };
    return { kind: "need", read, need: { path: [read.name], optional: true, fields: {} } };
  };
  const resolveNeedRead = (module: string, read: InputRead, path: readonly string[] | undefined): Resolution => {
    const reach = scope ? scope.needOf(module, path, read.name) : unscopedNeedOf(module, read.name);
    const input = reach ? undefined : resourceInputRead(module, read, path);
    const resolution: Resolution = input
      ? input
      : !reach
      ? { kind: "open", reason: `it reads '${read.chain}', which is not known before boot` }
      : reach.kind === "reached"
        ? { kind: "need", read, need: reach.need }
        : read.projection === "presence"
          ? { kind: "constant", value: PRESENT }
          : {
              kind: "open",
              reason:
                `'${read.chain}' reads a member of a need its import supplies, which is not decided before boot`,
            };
    const key = instanceKey(module, path);
    const byName = needReads.get(key) ?? new Map<string, Resolution[]>();
    needReads.set(key, byName);
    byName.set(read.name, [...(byName.get(read.name) ?? []), resolution]);
    return resolution;
  };
  const resolveRead = (
    module: string,
    read: InputRead,
    path: readonly string[] | undefined,
    depth = 0,
  ): Resolution => {
    if (read.input === "resources") return resolveNeedRead(module, read, path);
    if (roots.has(module)) return { kind: "root", module, read };
    if (depth > 32) return { kind: "open", reason: `'${read.chain}' is bound through a chain of imports too deep to follow` };
    const input = read.input;
    const binding = bindingOf(module, input, read.name, path);
    const key = instanceKey(module, path);
    const reads = libraryReads.get(key) ?? new Map();
    libraryReads.set(key, reads);
    const recorded = reads.get(`${input}.${read.name}`) ?? {
      input,
      name: read.name,
      binding,
      projections: new Set<string>(),
    };
    recorded.projections.add(projectionName(read));
    reads.set(`${input}.${read.name}`, recorded);
    const declaration = declarationOf(module, input, read.name);
    const at = binding
      ? {
          owner: binding.owner,
          alias: binding.alias,
          ...(binding.filePath ? { filePath: binding.filePath } : {}),
          path: `imports.${binding.alias}.${read.input}.${read.name}`,
        }
      : undefined;
    const literal = (value: unknown): Resolution => {
      if (read.projection === "presence") return { kind: "constant", value: value === null || value === undefined ? ABSENT : PRESENT };
      if (read.projection === "member") {
        const member = declaration ? memberOfValue(declaration, value, read.member!) : undefined;
        return member === undefined
          ? { kind: "open", reason: `'${read.chain}' reads a member of a value its declaration does not build`, ...(at ? { binding: at } : {}) }
          : { kind: "constant", value: member };
      }
      return { kind: "constant", value };
    };
    if (!binding || !binding.present) {
      return literal(declaration && Object.hasOwn(declaration, "default") ? declaration.default : null);
    }
    const value = binding.value;
    if (!isTaggedSentinel(value) && !isCompiledValue(value)) return literal(value);
    const source = expressionSource(value);
    if (source === undefined) {
      return {
        kind: "open",
        reason: `the import binds '${read.input}.${read.name}' with a tag other than '!cel', which nothing decides before boot`,
        ...(at ? { binding: at } : {}),
      };
    }
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) {
      return { kind: "open", reason: `the import's binding does not parse: ${expression.parseError}`, ...(at ? { binding: at } : {}) };
    }
    const only = expression.reads.length === 1 ? expression.reads[0]! : undefined;
    if (only?.class === "input" && only.read.projection === "whole" && only.read.chain === source.trim()) {
      // A bare chain carries the projection into the importer.
      return carriedThrough(at, resolveRead(
        binding.owner,
        {
          input: only.read.input,
          name: only.read.name,
          projection: read.projection,
          ...(read.member !== undefined ? { member: read.member } : {}),
          chain:
            read.projection === "member" ? `${only.read.chain}.${read.member}` : only.read.chain,
        },
        binding.ownerPath,
        depth + 1,
      ));
    }
    if (read.projection === "member") {
      return {
        kind: "open",
        reason: `'${read.chain}' reads a member of a value the import computes ('${source.trim()}'), which is not decided before boot`,
        ...(at ? { binding: at } : {}),
      };
    }
    const parts: Resolution[] = [];
    for (const part of expression.reads) {
      if (part.class === "input") parts.push(resolveRead(binding.owner, part.read, binding.ownerPath, depth + 1));
      else if (part.class === "call") {
        const refusal = callRefusal(binding.importDoc, part.qualified);
        if (refusal) {
          return {
            kind: "open",
            reason: `the import binds '${read.input}.${read.name}' to an expression calling '${part.qualified}', which ${refusal}`,
            ...(at ? { binding: at } : {}),
          };
        }
      } else if (part.class === "open") {
        return {
          kind: "open",
          reason: `the import binds '${read.input}.${read.name}' to an expression reading '${part.chain}', which is not known before boot`,
          ...(at ? { binding: at } : {}),
        };
      }
    }
    return { kind: "derived", owner: binding.owner, expression, parts, ...(at ? { via: at } : {}) };
  };

  // Each site's decision.
  const decisions = new Map<ChoiceSite, Decision>();
  for (const site of sites) {
    const body = site.sentinel as Record<string, unknown>;
    const written = site.tag === "if" ? body.if : body.switch;
    if (!isTaggedSentinel(written) && !isCompiledValue(written)) {
      decisions.set(site, { kind: "literal", value: written });
      continue;
    }
    const source = expressionSource(written);
    if (source === undefined) {
      decisions.set(site, {
        kind: "invalid",
        message: `is written with a tag other than '!cel'; a ${site.tag === "if" ? "condition" : "selector"} is a '!cel' expression or a literal.`,
      });
      continue;
    }
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) {
      decisions.set(site, { kind: "invalid", message: `does not parse: ${expression.parseError}` });
      continue;
    }
    const resolutions = expression.reads.map((read): Resolution | Neutral =>
      read.class === "input"
        ? resolveRead(site.module ?? firstRoot ?? "", read.read, site.importPath)
        : read.class === "module"
          ? { kind: "module" }
          : read.class === "call"
            ? { kind: "call", qualified: read.qualified }
            : { kind: "open", reason: `it reads '${read.chain}', which is not known before boot` },
    );
    decisions.set(site, { kind: "expression", expression, resolutions });
  }

  // Every projection a root input — or a need — is read through, so one input's
  // presence and its value share one key.
  const projections = new Map<string, Set<string>>();
  const rootReads: { module: string; read: InputRead }[] = [];
  const needResolutions: Extract<Resolution, { kind: "need" }>[] = [];
  const needProjectionKey = (need: ReachedNeed) => `\0need\0${need.path.join(".")}`;
  const collectRoots = (resolution: Resolution | Neutral) => {
    if (resolution.kind === "root") {
      rootReads.push({ module: resolution.module, read: resolution.read });
      const key = `${resolution.module}\0${resolution.read.input}.${resolution.read.name}`;
      const set = projections.get(key) ?? new Set();
      set.add(projectionName(resolution.read));
      projections.set(key, set);
    } else if (resolution.kind === "need") {
      needResolutions.push(resolution);
      const key = needProjectionKey(resolution.need);
      const set = projections.get(key) ?? new Set();
      set.add(projectionName(resolution.read));
      projections.set(key, set);
    } else if (resolution.kind === "derived") {
      for (const part of resolution.parts) collectRoots(part);
    }
  };
  for (const decision of decisions.values()) {
    if (decision.kind === "expression") for (const r of decision.resolutions) collectRoots(r);
  }
  for (const { holder, source } of consumerReads) {
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) continue;
    for (const read of expression.reads) {
      if (read.class === "input") collectRoots(resolveRead(moduleOf(holder) ?? firstRoot ?? "", read.read, importPathOf(holder)));
    }
  }
  const rootReadingOf = (module: string, read: InputRead) =>
    readRootInput(
      read,
      declarationOf(module, read.input as InputBlock, read.name),
      projections.get(`${module}\0${read.input}.${read.name}`) ?? new Set(),
    );
  const needReadingOf = (resolution: Extract<Resolution, { kind: "need" }>): RootReading =>
    readNeedInput(resolution.read, resolution.need, projections.get(needProjectionKey(resolution.need)) ?? new Set());
  const dimensions: Dimension[] = [];
  const dimensionModule = new Map<string, string>();
  for (const { module, read } of rootReads) {
    const reading = rootReadingOf(module, read);
    if (reading.kind !== "dimension" || dimensionModule.has(reading.dimension.key)) continue;
    dimensions.push(reading.dimension);
    dimensionModule.set(reading.dimension.key, module);
  }
  const needDimensions = new Set<string>();
  for (const resolution of needResolutions) {
    const reading = needReadingOf(resolution);
    if (reading.kind !== "dimension" || needDimensions.has(reading.dimension.key)) continue;
    dimensions.push(reading.dimension);
    needDimensions.add(reading.dimension.key);
  }
  const configurations = enumerateConfigurations(dimensions);

  /** What `resources.<name>` holds in `assignment` for a module instance's
   *  decisions: `null` where the need is absent, else its decided members. */
  const needValueIn = (resolutions: readonly Resolution[], assignment: Assignment): unknown => {
    let value: Record<string, Record<string, unknown>> | null = {};
    for (const resolution of resolutions) {
      if (resolution.kind === "constant" && resolution.value === ABSENT) return null;
      if (resolution.kind !== "need") continue;
      const reading = needReadingOf(resolution);
      if (reading.kind !== "dimension") continue;
      const { dimension } = reading;
      const decided = assignment[dimension.key];
      if (decided === ABSENT || decided === null) return null;
      if (dimension.projection === "member" && value) {
        value[dimension.field!] = { ...(value[dimension.field!] ?? {}), [dimension.member!]: decided };
      }
    }
    return value;
  };
  const needActivation = (key: string, assignment: Assignment): Record<string, unknown> | undefined => {
    const byName = needReads.get(key);
    if (!byName) return undefined;
    const out: Record<string, unknown> = {};
    for (const [name, resolutions] of byName) out[name] = needValueIn(resolutions, assignment);
    return out;
  };

  // Why a resolution is open, if it is: the reason, and the binding it sits at.
  const openOf = (
    resolution: Resolution | Neutral,
  ): { reason: string; binding?: BindingAnchor } | undefined => {
    if (resolution.kind === "open") return resolution;
    if (resolution.kind === "root") {
      const reading = rootReadingOf(resolution.module, resolution.read);
      if (reading.kind !== "open") return undefined;
      return { reason: reading.reason, ...(resolution.via ? { binding: resolution.via } : {}) };
    }
    if (resolution.kind === "need") {
      const reading = needReadingOf(resolution);
      return reading.kind === "open" ? { reason: reading.reason } : undefined;
    }
    if (resolution.kind === "derived") {
      for (const part of resolution.parts) {
        const open = openOf(part);
        if (open) return open.binding || !resolution.via ? open : { ...open, binding: resolution.via };
      }
    }
    return undefined;
  };
  // A choice refused statically expands to a stand-in in every configuration.
  const staticallyRefused = new Set<ChoiceSite>();
  const decidable = (site: ChoiceSite): boolean => {
    if (staticallyRefused.has(site)) return false;
    const decision = decisions.get(site)!;
    if (decision.kind === "invalid") return false;
    if (decision.kind === "literal") return true;
    return decision.resolutions.every((r) => openOf(r) === undefined);
  };

  // The activation each module's expressions are evaluated with, per
  // configuration.
  const activationOf = (
    module: string,
    path: readonly string[] | undefined,
    assignment: Assignment,
    memo: Map<string, Record<string, unknown>>,
  ) => {
    const key = instanceKey(module, path);
    const known = memo.get(key);
    if (known) return known;
    const activation: Record<string, unknown> = { module: moduleMetadata(module) };
    memo.set(key, activation);
    const resources = needActivation(key, assignment);
    if (resources) activation.resources = resources;
    if (roots.has(module)) {
      const values = rootInputValues(
        dimensions.filter((d) => dimensionModule.get(d.key) === module),
        assignment,
      );
      for (const { module: m, read } of rootReads) {
        if (m !== module) continue;
        const reading = rootReadingOf(m, read);
        const block = values[read.input as InputBlock];
        if (reading.kind === "constant" && block[read.name] === undefined) block[read.name] = {};
      }
      activation.variables = values.variables;
      activation.secrets = values.secrets;
      return activation;
    }
    const variables: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    for (const { input, name, binding } of libraryReads.get(key)?.values() ?? []) {
      const block = input === "variables" ? variables : secrets;
      const declaration = declarationOf(module, input, name) ?? {};
      if (!binding || !binding.present) {
        block[name] = asDeclared(Object.hasOwn(declaration, "default") ? declaration.default : null, declaration);
        continue;
      }
      const value = binding.value;
      if (!isTaggedSentinel(value) && !isCompiledValue(value)) {
        block[name] = asDeclared(value, declaration);
        continue;
      }
      const source = expressionSource(value);
      if (source === undefined) continue;
      try {
        block[name] = evaluateIn(
          binding.importDoc,
          source,
          activationOf(binding.owner, binding.ownerPath, assignment, memo),
        );
      } catch {
        // An open binding is reported where it is written; nothing to evaluate.
      }
    }
    activation.variables = variables;
    activation.secrets = secrets;
    return activation;
  };

  // The outcome of every site in every configuration.
  /** `unmatched`: a selector no case takes and no `default:` covers, refused
   *  as not exhaustive and expanded to a stand-in. */
  type Outcome = { value?: unknown; branch: string | null; error?: string; unmatched?: true };
  const outcomeIn = (site: ChoiceSite, assignment: Assignment, memo: Map<string, Record<string, unknown>>): Outcome => {
    const decision = decisions.get(site)!;
    if (!decidable(site)) return { branch: STAND_IN };
    let value: unknown;
    if (decision.kind === "literal") value = decision.value;
    else {
      try {
        value = evaluateIn(
          site.holder,
          (decision as { expression: DecisionExpression }).expression.source,
          activationOf(site.module ?? firstRoot ?? "", site.importPath, assignment, memo),
        );
      } catch (error) {
        return { branch: STAND_IN, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (valueTypeProblem(site.tag, value) !== undefined) return { value, branch: STAND_IN };
    const branch = branchFor(site, value);
    if (branch === null && site.tag === "switch") return { value, branch: STAND_IN, unmatched: true };
    return { value, branch };
  };

  const diagnostics: ConfigurationDiagnostic[] = [];
  /** Where each site-anchored diagnostic is written, for the stand-in filter. */
  const placed = new Map<ConfigurationDiagnostic, { site: ChoiceSite; keys: readonly (string | number)[] }>();
  /** The refusals that make a choice a stand-in — the one report it is owed. */
  const standInRefusals = new Set<ConfigurationDiagnostic>();
  const reportAt = (
    site: ChoiceSite,
    keys: readonly (string | number)[],
    code: string,
    message: string,
    severity: DiagnosticSeverity = DiagnosticSeverity.Error,
    configurations?: ReadonlySet<string>,
  ): ConfigurationDiagnostic => {
    const found: ConfigurationDiagnostic = {
      diagnostic: diagnosticAt(site.holder, keys, code, message, severity),
      ...(configurations ? { configurations } : {}),
    };
    diagnostics.push(found);
    placed.set(found, { site, keys });
    return found;
  };
  const refusalAt = (site: ChoiceSite, keys: readonly (string | number)[], code: string, message: string) => {
    standInRefusals.add(reportAt(site, keys, code, message));
  };

  // Structural and static refusals: once, for the root's own choices.
  const refusedBranches: { holder: ResourceManifest; path: string }[] = [];
  const reportedBindings = new Set<string>();
  /** A library's input the importer binds to an open value: reported at the
   *  binding, when the importer is the analysed root's own. */
  const reportOpenBinding = (open: { binding?: { owner: string; alias: string; filePath?: string; path: string }; reason: string }) => {
    const binding = open.binding!;
    if (!roots.has(binding.owner)) return;
    const key = `${binding.filePath}\0${binding.path}`;
    if (reportedBindings.has(key)) return;
    reportedBindings.add(key);
    diagnostics.push({
      diagnostic: {
        severity: DiagnosticSeverity.Error,
        code: "BRANCH_UNDECIDABLE",
        source: SOURCE,
        message:
          `Import '${binding.alias}' binds a value a choice of the library decides on before boot, ` +
          `but ${open.reason}. Bind it to a literal, or to an expression reading only inputs whose ` +
          `values are decided before boot (an 'enum', 'const' or boolean variable, a member an ` +
          `'enum' argument binds, a presence test).`,
        data: {
          ...(binding.filePath ? { filePath: binding.filePath } : {}),
          path: binding.path,
        },
      },
    });
  };
  const staticTypes = new Map<ChoiceSite, string | undefined>();
  const globals = buildKernelGlobalsIndex(listRequests(manifests as ResourceManifest[]));
  for (const site of sites) {
    const decision = decisions.get(site)!;
    const conditionKeys = [...site.keys, site.tag];
    const label = `'!${site.tag}'`;
    const what = site.tag === "if" ? "condition" : "selector";
    if (site.declaration) {
      for (const [branch, keys] of branchesOf(site)) {
        const problem = declarationBranchProblem(valueAt(site.sentinel, keys));
        if (problem && site.own) {
          refusedBranches.push({ holder: site.holder, path: pathOf([...site.keys, ...keys]) });
          reportAt(site, [...site.keys, ...keys], "BRANCH_CASE_INVALID",
            `The ${describeBranch(branch)} of ${label} at a declaration position ${problem}. Each branch is one ` +
              `unnamed resource declaration — '{ kind, …fields }' — or a nested '!if' / '!switch' whose ` +
              `branches are; the tag's own 'metadata' names it once for every branch.`);
        }
      }
    }
    if (decision.kind === "invalid") {
      if (site.own) refusalAt(site, conditionKeys, "BRANCH_CONDITION_INVALID", `The ${what} of ${label} ${decision.message}`);
      continue;
    }
    if (decision.kind === "literal") {
      const problem = valueTypeProblem(site.tag, decision.value);
      if (problem) staticallyRefused.add(site);
      if (problem && site.own) refusalAt(site, conditionKeys, "BRANCH_CONDITION_INVALID", `The ${what} of ${label} ${problem}`);
      staticTypes.set(site, celTypeOfValue(decision.value));
      continue;
    }
    // The engine's verdict on the expression, typed against the module's inputs
    // and read against the module's own names, so a module call is one.
    const names = scope?.moduleNames(site.holder);
    const analysis = celEngine.analyze(decision.expression.source, {
      celEnv: names ? moduleNamesEnvironment(ruleEnv(), names) : ruleEnv(),
      contextSchema: globals.forResource(site.holder, pathOf(site.keys)),
      ...(names ? { moduleNames: names } : {}),
    } as never);
    staticTypes.set(site, analysis.type);
    let refused = false;
    const refuse = (message: string) => {
      refused = true;
      if (site.own) refusalAt(site, conditionKeys, "BRANCH_CONDITION_INVALID", message);
    };
    for (const diagnostic of analysis.diagnostics) refuse(`The ${what} of ${label}: ${diagnostic.message}`);
    for (const call of analysis.calls) {
      const forbidden = forbiddenCatalogCall(call);
      if (!forbidden) continue;
      refuse(
        forbidden === "host-backed"
          ? `The ${what} of ${label} calls '${call.name}()', which the runtime supplies at boot, so ` +
              `it cannot be decided before boot.`
          : `The ${what} of ${label} calls '${call.name}()', which re-evaluates per call; a choice ` +
              `decided before boot must read the same value in every check.`,
      );
    }
    // A module call is decided by its callee: one the analyzer can run is
    // evaluated, any other refused, naming the chain to the leaf.
    const calledNames = new Set<string>();
    for (const read of decision.expression.reads) {
      if (read.class !== "call" || calledNames.has(read.qualified)) continue;
      calledNames.add(read.qualified);
      const refusal = callRefusal(site.holder, read.qualified);
      if (refusal) refuse(`The ${what} of ${label} calls '${read.qualified}', which ${refusal}.`);
    }
    const typeProblem = analysis.type ? staticTypeProblem(site.tag, analysis.type) : undefined;
    if (typeProblem && !refused) refuse(`The ${what} of ${label} ${typeProblem}`);
    if (refused) staticallyRefused.add(site);
    // Every open read the condition makes, named in one report.
    const openReasons: string[] = [];
    for (const resolution of decision.resolutions) {
      const open = openOf(resolution);
      if (!open) continue;
      if (open.binding) {
        reportOpenBinding(open);
        continue;
      }
      if (!openReasons.includes(open.reason)) openReasons.push(open.reason);
    }
    if (openReasons.length === 0 || !site.own || refused) continue;
    refusalAt(site, conditionKeys, "BRANCH_UNDECIDABLE",
      `The ${what} of ${label} is decided before boot, but ${joinClauses(openReasons)}. A choice reads only ` +
        `literals, 'module.<field>', a call to a module function written in CEL, the whole value of a ` +
        `'variables:' entry declared 'enum', 'const' or 'type: boolean', a member its declaration binds ` +
        `to an 'enum' or 'const' argument, an input's presence ('… != null', for an entry declaring ` +
        `'default: null'), the presence of an optional need or resource input ('resources.<name> != null'), ` +
        `or a member its need ` +
        `type's field binds to an 'enum' or 'const' argument.`);
  }

  // A value a dependency's own declaration of a templated kind is chained to:
  // its choices are decided through the import binding, so an open one is
  // refused there, once, like a choice of the library's own.
  for (const { holder, source } of consumerReads) {
    if (!importPathOf(holder)) continue;
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) continue;
    for (const read of expression.reads) {
      if (read.class !== "input") continue;
      const open = openOf(resolveRead(moduleOf(holder) ?? firstRoot ?? "", read.read, importPathOf(holder)));
      if (open?.binding) reportOpenBinding(open);
    }
  }

  // The name a declaration-position choice declares is one entry of its
  // namespace in every configuration, judged here once.
  const names = nameTableDiagnostics(sites, manifests, documents, moduleOf, isOwn, scope);
  for (const diagnostic of names.diagnostics) diagnostics.push({ diagnostic });
  refusedBranches.push(...names.refusedBranches);

  // Per-configuration outcomes: exhaustiveness, reachability, evaluation.
  const keyOf = (a: Assignment) => assignmentKey(a);
  const reached = new Map<ChoiceSite, Map<string, Outcome>>();
  for (const assignment of configurations) {
    const memo = new Map<string, Record<string, unknown>>();
    const key = keyOf(assignment);
    for (const site of sites) {
      const outcomes = reached.get(site) ?? new Map<string, Outcome>();
      reached.set(site, outcomes);
      if (site.parent) {
        const parentOutcome = reached.get(site.parent.site)?.get(key);
        if (!parentOutcome || parentOutcome.branch !== site.parent.branch) continue;
      }
      outcomes.set(key, outcomeIn(site, assignment, memo));
    }
  }
  const everyKey = configurations.map(keyOf);
  const unreachable: UnreachableBranch[] = [];
  for (const site of sites) {
    if (!site.own || !decidable(site)) continue;
    const outcomes = reached.get(site)!;
    if (outcomes.size === 0) continue;
    const label = `'!${site.tag}'`;
    const what = site.tag === "if" ? "condition" : "selector";
    const errors = new Map<string, Set<string>>();
    const invalid = new Map<string, Set<string>>();
    const unmatched = new Map<string, Set<string>>();
    const taken = new Set<string>();
    for (const [key, outcome] of outcomes) {
      if (outcome.error !== undefined) {
        errors.set(outcome.error, (errors.get(outcome.error) ?? new Set()).add(key));
        continue;
      }
      const problem = valueTypeProblem(site.tag, outcome.value);
      if (problem) {
        invalid.set(problem, (invalid.get(problem) ?? new Set()).add(key));
        continue;
      }
      if (outcome.unmatched) {
        const shown = describeSelectorValue(outcome.value);
        unmatched.set(shown, (unmatched.get(shown) ?? new Set()).add(key));
      } else if (outcome.branch !== null) {
        taken.add(outcome.branch);
      }
    }
    const scoped = (keys: Set<string>) => (keys.size === everyKey.length ? undefined : keys);
    for (const [message, keys] of errors) {
      reportAt(site, [...site.keys, site.tag], "BRANCH_CONDITION_INVALID", `The ${what} of ${label} throws: ${message}`, DiagnosticSeverity.Error, scoped(keys));
    }
    for (const [message, keys] of invalid) {
      reportAt(site, [...site.keys, site.tag], "BRANCH_CONDITION_INVALID", `The ${what} of ${label} ${message}`, DiagnosticSeverity.Error, scoped(keys));
    }
    for (const [shown, keys] of unmatched) {
      reportAt(site, site.keys, "BRANCH_NOT_EXHAUSTIVE",
        `${label} selects no case for ${shown} and has no 'default:'. Add a case for it, or a ` +
          `'default:'; absence decided by a selector is written as an enclosing '!if'.`,
        DiagnosticSeverity.Error, scoped(keys));
    }
    if (errors.size > 0 || invalid.size > 0) continue;
    // Case keys read as the selector's type.
    const invalidCases = new Set<string>();
    if (site.tag === "switch") {
      const type = staticTypes.get(site);
      const valueType =
        type && type !== "dyn" ? type : [...outcomes.values()].map((o) => celTypeOfValue(o.value)).find(Boolean);
      const cases = (site.sentinel as Record<string, unknown>).cases;
      if (cases && typeof cases === "object" && !Array.isArray(cases)) {
        for (const caseKey of Object.keys(cases)) {
          if (caseKeyValue(caseKey, valueType) !== undefined) continue;
          invalidCases.add(`case:${caseKey}`);
          reportAt(site, [...site.keys, "cases", caseKey], "BRANCH_CASE_KEY_INVALID",
            `Case '${caseKey}' of ${label} is not a value of the selector's type '${valueType}'` +
              (valueType === "int"
                ? ` — an integer case is its decimal literal ('1', never '01').`
                : valueType === "bool"
                  ? ` — a boolean case is 'true' or 'false'.`
                  : `.`));
        }
      }
    }
    const baseline = configurations.find((a) => outcomes.has(keyOf(a)))!;
    for (const [branch, keys] of branchesOf(site)) {
      if (taken.has(branch) || invalidCases.has(branch)) continue;
      unreachable.push({ site, branch, keys: [...site.keys, ...keys], baseline });
      reportAt(site, [...site.keys, ...keys], "BRANCH_CASE_UNREACHABLE",
        `The ${describeBranch(branch)} of ${label} is taken in no configuration` +
          (site.tag === "if"
            ? ` — its condition is the same in every one.`
            : ` — no value the selector can hold selects it.`) +
          ` It is still checked.`,
        DiagnosticSeverity.Warning);
    }
  }

  // A choice nothing decides is judged only by its own refusal: what is
  // reported at or beneath it is dropped until its condition is fixed.
  const staticStandIns = sites.filter((site) => !decidable(site));
  const reported =
    staticStandIns.length === 0
      ? diagnostics
      : diagnostics.filter((found) => {
          if (standInRefusals.has(found)) return true;
          const at = placed.get(found);
          if (!at) return true;
          const path = pathOf(at.keys);
          return !staticStandIns.some(
            (site) => site.holder === at.site.holder && isAtOrUnder(path, pathOf(site.keys)),
          );
        });

  const decide = (assignment: Assignment): Decisions => {
    const memo = new Map<string, Record<string, unknown>>();
    const out = new Map<ExpansionSentinel, string | null>();
    for (const site of sites) out.set(site.sentinel, outcomeIn(site, assignment, memo).branch);
    return out;
  };

  const standIns = (assignment: Assignment, forcing?: Decisions): StandInConstruct[] => {
    const decided = decide(assignment);
    return sites
      .filter((site) => !refused.has(site.sentinel))
      .filter((site) => (forcing?.has(site.sentinel) ? forcing.get(site.sentinel) : decided.get(site.sentinel)) === STAND_IN)
      .map((site) => ({ holder: site.holder, path: pathOf(site.keys) }));
  };

  const decidedInputsOf = (
    module: string,
    path: readonly string[] | undefined,
    assignment: Assignment,
    memo: Map<string, Record<string, unknown>>,
  ): DecidedInputs | undefined => {
    const variables = new Map<string, DecidedInput>();
    const secrets = new Map<string, DecidedInput>();
    const chains = new Map<string, unknown>();
    const present = new Set<string>();
    const needs = new Map<string, Map<string, Map<string, unknown>>>();
    const blockOf = (input: InputBlock) => (input === "variables" ? variables : secrets);
    const addMember = (input: InputBlock, name: string, parameter: string, member: string, value: unknown) => {
      const block = blockOf(input);
      const known = block.get(name);
      const members = new Map(known && "members" in known ? known.members : []);
      members.set(parameter, value);
      block.set(name, { members });
      chains.set(`${input}.${name}.${member}`, value);
      present.add(`${input}.${name}`);
    };
    const addWhole = (input: InputBlock, name: string, value: unknown) => {
      blockOf(input).set(name, { whole: value });
      chains.set(`${input}.${name}`, value);
      present.add(`${input}.${name}`);
    };
    if (roots.has(module)) {
      for (const dimension of dimensions) {
        const value = assignment[dimension.key];
        if (dimension.input === "resources") {
          // The module's own need: one its analysis is the root of.
          if (dimension.needPath?.length !== 1 || value === null || value === undefined || value === ABSENT) continue;
          const name = dimension.needPath[0]!;
          present.add(`resources.${name}`);
          if (dimension.projection !== "member") continue;
          const parameter = parameterFor(dimension.declaration, dimension.member!);
          if (!parameter) continue;
          const byField = needs.get(name) ?? new Map<string, Map<string, unknown>>();
          needs.set(name, byField);
          byField.set(dimension.field!, new Map(byField.get(dimension.field!) ?? []).set(parameter, value));
          chains.set(`resources.${name}.${dimension.field}.${dimension.member}`, value);
          continue;
        }
        if (dimensionModule.get(dimension.key) !== module || value === null || value === undefined) continue;
        if (dimension.projection === "presence") {
          if (value === PRESENT) present.add(`${dimension.input}.${dimension.name}`);
        } else if (dimension.projection === "whole") addWhole(dimension.input, dimension.name, value);
        else {
          const parameter = parameterFor(dimension.declaration, dimension.member!);
          if (parameter) addMember(dimension.input, dimension.name, parameter, dimension.member!, value);
        }
      }
    } else {
      const activation = activationOf(module, path, assignment, memo);
      for (const { input, name, projections } of libraryReads.get(instanceKey(module, path))?.values() ?? []) {
        const declaration = declarationOf(module, input, name);
        const value = (activation[input] as Record<string, unknown> | undefined)?.[name];
        if (!declaration || value === null || value === undefined) continue;
        present.add(`${input}.${name}`);
        if (projections.has("whole") && wholeDomain(input, declaration)) {
          addWhole(input, name, typeof value === "bigint" ? Number(value) : value);
        }
        for (const projection of projections) {
          if (!projection.startsWith("member:")) continue;
          const member = projection.slice("member:".length);
          const parameter = parameterFor(declaration, member);
          if (!parameter || !memberDomain(declaration, member)) continue;
          const read =
            value && typeof value === "object" && !isUrlLike(value)
              ? (value as Record<string, unknown>)[member]
              : memberOfValue(declaration, value, member);
          if (read !== null && read !== undefined) addMember(input, name, parameter, member, read);
        }
      }
    }
    return variables.size > 0 || secrets.size > 0 || present.size > 0
      ? { variables, secrets, chains, present, needs }
      : undefined;
  };

  const narrowing = (assignment: Assignment): InputNarrowing => {
    const memo = new Map<string, Record<string, unknown>>();
    const cache = new Map<string, DecidedInputs | undefined>();
    return (module, path) => {
      const owner = module ?? firstRoot;
      if (!owner) return undefined;
      const key = instanceKey(owner, path);
      if (!cache.has(key)) cache.set(key, decidedInputsOf(owner, path, assignment, memo));
      return cache.get(key);
    };
  };

  const dimensionKeys = new Set(dimensions.map((d) => d.key));
  const decidedBy = (resolution: Resolution | Neutral): boolean => {
    if (resolution.kind === "constant" || resolution.kind === "module") return true;
    const reading =
      resolution.kind === "root"
        ? rootReadingOf(resolution.module, resolution.read)
        : resolution.kind === "need"
          ? needReadingOf(resolution)
          : undefined;
    if (!reading) return false;
    return reading.kind === "constant" || (reading.kind === "dimension" && dimensionKeys.has(reading.dimension.key));
  };
  const valueIn = (holder: ResourceManifest, source: string, assignment: Assignment) => {
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) return undefined;
    const module = moduleOf(holder) ?? firstRoot ?? "";
    const path = importPathOf(holder);
    for (const read of expression.reads) {
      if (read.class === "module") continue;
      if (read.class !== "input") return undefined;
      if (!decidedBy(resolveRead(module, read.read, path))) return undefined;
    }
    try {
      return { value: evaluateIn(holder, source, activationOf(module, path, assignment, new Map())) };
    } catch {
      return undefined;
    }
  };

  const valueOutcomes = (holder: ResourceManifest, source: string, space: ConditionSpace) => {
    const expression = readDecisionExpression(source);
    if (expression.parseError !== undefined) return undefined;
    const module = moduleOf(holder) ?? firstRoot ?? "";
    const path = importPathOf(holder);
    const footprint = new Set<string>();
    const visit = (resolution: Resolution | Neutral) => {
      const reading =
        resolution.kind === "root"
          ? rootReadingOf(resolution.module, resolution.read)
          : resolution.kind === "need"
            ? needReadingOf(resolution)
            : undefined;
      if (reading?.kind === "dimension") footprint.add(reading.dimension.key);
      if (resolution.kind === "derived") for (const part of resolution.parts) visit(part);
    };
    for (const read of expression.reads) {
      if (read.class === "module") continue;
      if (read.class !== "input") return undefined;
      const resolution = resolveRead(module, read.read, path);
      if (!decidedBy(resolution)) return undefined;
      visit(resolution);
    }
    let partials: Record<string, unknown>[] = [{}];
    for (const dimension of space.dimensions) {
      if (!footprint.has(dimension.key)) continue;
      partials = partials.flatMap((partial) => dimension.values.map((value) => ({ ...partial, [dimension.key]: value })));
    }
    const out: { value: unknown; condition: Condition; text: string }[] = [];
    for (const partial of partials) {
      const decided = valueIn(holder, source, partial);
      if (!decided) return undefined;
      const text = stableText(decided.value);
      const known = out.find((o) => o.text === text);
      if (known) known.condition = space.or(known.condition, space.assignment(partial));
      else out.push({ value: decided.value, condition: space.assignment(partial), text });
    }
    return out.map(({ value, condition }) => ({ value, condition }));
  };

  // The dimensions a site's condition reads: through a binding, the
  // importer's it is evaluated over.
  const footprintOf = (site: ChoiceSite): Set<string> => {
    const out = new Set<string>();
    const visit = (resolution: Resolution | Neutral) => {
      const reading =
        resolution.kind === "root"
          ? rootReadingOf(resolution.module, resolution.read)
          : resolution.kind === "need"
            ? needReadingOf(resolution)
            : undefined;
      if (reading?.kind === "dimension") out.add(reading.dimension.key);
      if (resolution.kind === "derived") for (const part of resolution.parts) visit(part);
    };
    const decision = decisions.get(site)!;
    if (decision.kind === "expression") for (const r of decision.resolutions) visit(r);
    return out;
  };
  const branchConditions = (space: ConditionSpace): BranchConditions => {
    const out = new Map<ExpansionSentinel, Map<string | null, Condition>>();
    for (const site of sites) {
      const branches = new Map<string | null, Condition>();
      out.set(site.sentinel, branches);
      if (!decidable(site)) {
        branches.set(STAND_IN, TRUE);
        continue;
      }
      const footprint = footprintOf(site);
      let partials: Record<string, unknown>[] = [{}];
      for (const dimension of space.dimensions) {
        if (!footprint.has(dimension.key)) continue;
        partials = partials.flatMap((partial) => dimension.values.map((value) => ({ ...partial, [dimension.key]: value })));
      }
      for (const partial of partials) {
        const branch = outcomeIn(site, partial, new Map()).branch;
        branches.set(branch, space.or(branches.get(branch) ?? FALSE, space.assignment(partial)));
      }
    }
    return out;
  };

  const inputDimensions = (
    module: string | undefined,
    importPath: readonly string[] | undefined,
    input: "variables" | "secrets" | "resources",
    name?: string,
  ): readonly Dimension[] => {
    const owner = module ?? firstRoot;
    if (!owner) return [];
    if (!roots.has(owner)) {
      // Decided through the import's bindings, when the reading decides it at all.
      const key = instanceKey(owner, importPath);
      const decided =
        input === "resources"
          ? [...(needReads.get(key)?.keys() ?? [])]
          : [...(libraryReads.get(key)?.values() ?? [])].filter((r) => r.input === input).map((r) => r.name);
      return decided.some((n) => name === undefined || n === name) ? dimensions : [];
    }
    return dimensions.filter((dimension) => {
      if (dimension.input !== input) return false;
      if (input === "resources") return name === undefined || dimension.needPath?.[0] === name;
      return dimensionModule.get(dimension.key) === owner && (name === undefined || dimension.name === name);
    });
  };

  return {
    sites,
    dimensions,
    configurations,
    branchConditions,
    inputDimensions,
    diagnostics: reported,
    decide,
    narrowing,
    standIns,
    unreachable,
    refusedBranches,
    valueIn,
    valueOutcomes,
  };
}

/** The value of `source` when it reads nothing but the module's own names. */
function moduleOnlyValue(source: string): { value: unknown } | undefined {
  const expression = readDecisionExpression(source);
  if (expression.parseError !== undefined || expression.reads.some((r) => r.class !== "module")) return undefined;
  try {
    return { value: evaluate(source, { module: {} }) };
  } catch {
    return undefined;
  }
}

/** A value as text, its map keys in order: equal values, equal texts. */
function stableText(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === "bigint"
      ? `${v}n`
      : v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
        : v,
  );
}

/** `a`, `a and b`, `a; b; and c` — clauses joined into one sentence. */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  if (clauses.length === 2) return `${clauses[0]}, and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join("; ")}; and ${clauses[clauses.length - 1]}`;
}

function isAtOrUnder(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** The value type parameter a members declaration binds to `member`. */
function parameterFor(declaration: Record<string, unknown>, member: string): string | undefined {
  return membersSlotOf(declaration)?.entry.parameters.find((p) => (p as { member?: string }).member === member)
    ?.name;
}

/** A built value of a members type, as opposed to the plain map standing in
 *  for one in an activation. */
function isUrlLike(value: object): boolean {
  return Object.getOwnPropertySymbols(value).length > 0;
}

/** `resolution` as read through the importer binding `at`, unless a binding
 *  nearer the root already carries it. */
function carriedThrough(at: BindingAnchor | undefined, resolution: Resolution): Resolution {
  if (!at) return resolution;
  if (resolution.kind === "root" || resolution.kind === "derived") {
    return resolution.via ? resolution : { ...resolution, via: at };
  }
  if (resolution.kind === "open") return resolution.binding ? resolution : { ...resolution, binding: at };
  return resolution;
}

/** The `!cel` source a value holds, or undefined when it holds another tag. */
function expressionSource(value: unknown): string | undefined {
  if (isTaggedSentinel(value)) return value.engine === CEL_ENGINE ? value.source : undefined;
  if (isCompiledValue(value)) return typeof value.source === "string" ? value.source : undefined;
  return undefined;
}

export function evaluate(source: string, activation: Record<string, unknown>, moduleNames?: ReadonlySet<string>): unknown {
  const compiled = compileRuleCondition(source, moduleNames);
  if ("reason" in compiled) throw new Error(compiled.reason);
  return compiled.parsed(activation);
}

/** Each branch a tag writes, with its keys inside the tag. */
export function branchesOf(site: Pick<ChoiceSite, "sentinel" | "tag">): [string, (string | number)[]][] {
  const body = site.sentinel as Record<string, unknown>;
  const out: [string, (string | number)[]][] = [];
  if (site.tag === "if") {
    if ("then" in body) out.push(["then", ["then"]]);
    if ("else" in body) out.push(["else", ["else"]]);
    return out;
  }
  const cases = body.cases;
  if (cases && typeof cases === "object" && !Array.isArray(cases)) {
    for (const key of Object.keys(cases)) out.push([`case:${key}`, ["cases", key]]);
  }
  if ("default" in body) out.push(["default", ["default"]]);
  return out;
}

/** The value a branch id names inside a tag, and whether it is written. */
export function branchValue(sentinel: ExpansionSentinel, branch: string): { written: boolean; value: unknown } {
  const body = sentinel as Record<string, unknown>;
  if (branch.startsWith("case:")) {
    const cases = body.cases as Record<string, unknown> | undefined;
    const key = branch.slice("case:".length);
    return cases && Object.hasOwn(cases, key) ? { written: true, value: cases[key] } : { written: false, value: undefined };
  }
  return Object.hasOwn(body, branch) ? { written: true, value: body[branch] } : { written: false, value: undefined };
}

/** The keys a branch id's value sits at inside its tag. */
export function branchKeys(branch: string): (string | number)[] {
  return branch.startsWith("case:") ? ["cases", branch.slice("case:".length)] : [branch];
}

function valueAt(root: unknown, keys: readonly (string | number)[]): unknown {
  let at: unknown = root;
  for (const key of keys) at = (at as Record<string | number, unknown> | undefined)?.[key];
  return at;
}

function branchFor(site: ChoiceSite, value: unknown): string | null {
  return branchForValue(site.sentinel, site.tag, value);
}

/** The branch a choice takes for its condition's or selector's value: a branch
 *  id, or `null` when none is written for it. */
export function branchForValue(sentinel: ExpansionSentinel, tag: "if" | "switch", value: unknown): string | null {
  const body = sentinel as Record<string, unknown>;
  if (tag === "if") {
    if (value === true) return "then" in body ? "then" : null;
    if (value === false) return "else" in body ? "else" : null;
    return null;
  }
  const cases = body.cases;
  const type = celTypeOfValue(value);
  if (cases && typeof cases === "object" && !Array.isArray(cases)) {
    for (const key of Object.keys(cases)) {
      const read = caseKeyValue(key, type);
      if (read !== undefined && read === value) return `case:${key}`;
    }
  }
  return "default" in body ? "default" : null;
}

/** A case key read as a value of `type`, or undefined when it is none. */
export function caseKeyValue(key: string, type: string | undefined): unknown {
  switch (type) {
    case "int":
      return /^-?(0|[1-9][0-9]*)$/.test(key) ? BigInt(key) : undefined;
    case "bool":
      return key === "true" ? true : key === "false" ? false : undefined;
    case "string":
    case undefined:
    case "dyn":
      return key;
    default:
      return undefined;
  }
}

export function celTypeOfValue(value: unknown): string | undefined {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return "int";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  return undefined;
}

/** Why a value cannot decide a tag, or undefined. */
export function valueTypeProblem(tag: "if" | "switch", value: unknown): string | undefined {
  if (tag === "if") {
    return typeof value === "boolean" ? undefined : `yields ${describeKind(value)}, where a condition is a boolean.`;
  }
  const type = celTypeOfValue(value);
  return type === "string" || type === "int" || type === "bool"
    ? undefined
    : `yields ${describeKind(value)}, where a selector is a string, an integer or a boolean.`;
}

export function staticTypeProblem(tag: "if" | "switch", type: string): string | undefined {
  if (type === "dyn") return undefined;
  if (tag === "if") return type === "bool" ? undefined : `is a '${type}', where a condition is a boolean.`;
  return type === "string" || type === "int" || type === "bool"
    ? undefined
    : `is a '${type}', where a selector is a string, an integer or a boolean.`;
}

function describeKind(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a map";
  if (typeof value === "number" && !Number.isInteger(value)) return `the double ${value}`;
  return `the ${typeof value === "bigint" ? "integer" : typeof value} ${describeSelectorValue(value)}`;
}

function describeSelectorValue(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

export function describeBranch(branch: string): string {
  if (branch.startsWith("case:")) return `case '${branch.slice("case:".length)}'`;
  return `'${branch}:' branch`;
}

/** Why a value cannot be a branch at a declaration position, or undefined. */
export function declarationBranchProblem(value: unknown): string | undefined {
  const tag = expansionTagOf(value);
  if (tag === "if" || tag === "switch") return undefined;
  if (tag === "for-each") return "is a '!for-each', which declares a family only inside a template body";
  if (Array.isArray(value)) return "is a list";
  if (value === null || typeof value !== "object" || isTaggedSentinel(value)) return "is not a declaration";
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string") return "declares no 'kind'";
  if (isModuleKind(record.kind)) return `is a ${record.kind} document, which is never chosen`;
  if (isKindDocumentOrImport(record)) return `is a ${record.kind}, which declares no resource and is never chosen`;
  if ("metadata" in record) return "carries 'metadata'";
  return undefined;
}

function diagnosticAt(
  holder: ResourceManifest,
  keys: readonly (string | number)[],
  code: string,
  message: string,
  severity: DiagnosticSeverity,
): AnalysisDiagnostic {
  const metadata = holder.metadata as { name?: unknown; source?: unknown } | undefined;
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;
  const kind = holder.kind ?? expansionTagLabel(holder);
  return {
    severity,
    code,
    source: SOURCE,
    message: kind && name ? `${kind}/${name}: ${message}` : message,
    data: {
      ...(kind && name ? { resource: { kind, name } } : {}),
      ...(typeof metadata?.source === "string" ? { filePath: metadata.source } : {}),
      path: pathOf(keys),
    },
  };
}

/** `["steps", 0, "if"]` → `steps[0].if`. */
export function pathOf(keys: readonly (string | number)[]): string {
  let out = "";
  for (const key of keys) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out.length === 0 ? key : `.${key}`;
  }
  return out;
}

/**
 * The namespace entries declaration-position choices make, judged once: the
 * tag's name against the identifier rule at the level its branches' kinds
 * declare, and against every other name of its namespace — the module's for a
 * whole document, the scope's for a member — as `DUPLICATE_RESOURCE_NAME` at
 * whichever is written later. One name cannot denote a type in one
 * configuration and a value in another, so branches of mixed levels are
 * `BRANCH_CASE_INVALID` at the first that differs.
 */
function nameTableDiagnostics(
  sites: readonly ChoiceSite[],
  manifests: readonly ResourceManifest[],
  documents: readonly ResourceManifest[],
  moduleOf: (doc: ResourceManifest) => string | undefined,
  isOwn: (doc: ResourceManifest) => boolean,
  scope: ChoiceScope | undefined,
): { diagnostics: AnalysisDiagnostic[]; refusedBranches: { holder: ResourceManifest; path: string }[] } {
  const out: AnalysisDiagnostic[] = [];
  const refusedBranches: { holder: ResourceManifest; path: string }[] = [];
  /** The level `sentinel`'s name carries: its leaf branches' kinds', resolved
   *  in the holder's module; value-level when none resolves. */
  const levelOf = (
    holder: ResourceManifest,
    sentinel: ExpansionSentinel,
    keys: readonly (string | number)[],
  ): NameLevel => {
    const leaves: { keys: (string | number)[]; branch: string; tag: string; level: NameLevel }[] = [];
    const collect = (value: unknown, at: (string | number)[]) => {
      const tag = expansionTagOf(value);
      if (tag === "if" || tag === "switch") {
        for (const [branch, branchKeys] of branchesOf({ sentinel: value as ExpansionSentinel, tag })) {
          const inner = valueAt(value, branchKeys);
          if (isChoiceValue(inner)) collect(inner, [...at, ...branchKeys]);
          else {
            const kind = (inner as { kind?: unknown } | null)?.kind;
            const level = typeof kind === "string" ? scope?.nameLevel(kind, moduleOf(holder)) : undefined;
            if (level) leaves.push({ keys: [...at, ...branchKeys], branch, tag, level });
          }
        }
      }
    };
    collect(sentinel, [...keys]);
    const first = leaves[0];
    if (!first) return "value";
    const differing = leaves.find((leaf) => leaf.level !== first.level);
    if (differing && isOwn(holder)) {
      refusedBranches.push({ holder, path: pathOf(differing.keys) });
      out.push(
        diagnosticAt(
          holder,
          differing.keys,
          "BRANCH_CASE_INVALID",
          `The ${describeBranch(differing.branch)} of '!${differing.tag}' declares a ${describeLevel(differing.level)}, ` +
            `where the ${describeBranch(first.branch)} of '!${first.tag}' declares a ${describeLevel(first.level)}: ` +
            `one name cannot denote a type in one configuration and a value in another. Declare the two ` +
            `under names of their own.`,
          DiagnosticSeverity.Error,
        ),
      );
    }
    return first.level;
  };
  const nameOf = (value: unknown): string | undefined => {
    const name = (value as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
    return typeof name === "string" ? name : undefined;
  };
  const lineOf = (doc: ResourceManifest) => (doc.metadata as { sourceLine?: number } | undefined)?.sourceLine ?? 0;
  const describe = (value: unknown, name: string): string => {
    const tag = expansionTagOf(value);
    if (tag) return `the declaration '!${tag}' '${name}' chooses`;
    const kind = (value as { kind?: unknown }).kind;
    if (kind === "Telo.Import") return `import alias '${name}'`;
    if (isModuleKind(kind as string)) return `this module's own name (${kind as string} '${name}')`;
    return `resource ${kind as string}/${name}`;
  };
  const collision = (name: string, later: unknown, earlier: unknown, scope?: string) =>
    `${describe(later, name)} collides with ${describe(earlier, name)} declared earlier — ` +
    (scope
      ? `the kernel registers both under '${name}' in the '${scope}' scope, so opening that scope fails. `
      : `the kernel registers both under '${name}' in one namespace, so boot fails with ERR_DUPLICATE_RESOURCE. `) +
    `Rename one of them.`;

  // Whole documents, per module.
  const choiceDocuments = documents.filter((d) => {
    const tag = expansionTagOf(d);
    return (tag === "if" || tag === "switch") && isOwn(d) && nameOf(d) !== undefined;
  });
  for (const choice of choiceDocuments) {
    const name = nameOf(choice)!;
    const level = levelOf(choice, choice as unknown as ExpansionSentinel, []);
    const violation = checkName(name, level, "resource name");
    if (violation) out.push(diagnosticAt(choice, ["metadata", "name"], violation.code, violation.message, violation.severity));
  }
  const peers = [
    ...manifests.filter((m) => isOwn(m) && nameOf(m) !== undefined && !isExpansionSentinel(m)),
    ...choiceDocuments,
  ].sort((a, b) => lineOf(a) - lineOf(b));
  const byName = new Map<string, ResourceManifest[]>();
  for (const doc of peers) {
    const key = `${isModuleKind(doc.kind) ? doc.metadata?.name : moduleOf(doc)}\0${nameOf(doc)}`;
    byName.set(key, [...(byName.get(key) ?? []), doc]);
  }
  for (const list of byName.values()) {
    if (list.length < 2 || !list.some((d) => isExpansionSentinel(d))) continue;
    const [first, ...rest] = list;
    for (const later of rest) {
      if (!isExpansionSentinel(later) && !isExpansionSentinel(first!)) continue;
      const name = nameOf(later)!;
      const kind = later.kind ?? expansionTagLabel(later);
      const line = lineOf(later);
      out.push({
        severity: DiagnosticSeverity.Error,
        code: "DUPLICATE_RESOURCE_NAME",
        source: SOURCE,
        message: `${kind}/${name}: ${collision(name, later, first)}`,
        ...(isExpansionSentinel(later)
          ? {}
          : { range: { start: { line, character: 0 }, end: { line, character: Number.MAX_SAFE_INTEGER } } }),
        data: {
          resource: { kind, name },
          filePath: (later.metadata as { source?: string } | undefined)?.source,
          path: "metadata.name",
        },
      });
    }
  }

  // Scope members: a choice beside the other members of its scope.
  const seenScopes = new Set<unknown>();
  for (const site of sites) {
    if (!site.own || site.parent || !site.declaration || site.keys.length !== 2 || nameOf(site.sentinel) === undefined) {
      continue;
    }
    const [field] = site.keys;
    const members = (site.holder as Record<string, unknown>)[field as string];
    if (!Array.isArray(members)) continue;
    const name = nameOf(site.sentinel)!;
    const level = levelOf(site.holder, site.sentinel, site.keys);
    const violation = checkName(name, level, "resource name");
    if (violation) out.push(diagnosticAt(site.holder, [...site.keys, "metadata", "name"], violation.code, violation.message, violation.severity));
    if (seenScopes.has(members)) continue;
    seenScopes.add(members);
    const seen = new Map<string, unknown>();
    members.forEach((member, i) => {
      const memberName = nameOf(member);
      if (memberName === undefined) return;
      const earlier = seen.get(memberName);
      if (earlier === undefined) {
        seen.set(memberName, member);
        return;
      }
      if (!isExpansionSentinel(member) && !isExpansionSentinel(earlier)) return;
      out.push(
        diagnosticAt(
          site.holder,
          [field!, i, "metadata", "name"],
          "DUPLICATE_RESOURCE_NAME",
          collision(memberName, member, earlier, String(field)),
          DiagnosticSeverity.Error,
        ),
      );
    });
  }
  return { diagnostics: out, refusedBranches };
}

function isChoiceValue(value: unknown): boolean {
  const tag = expansionTagOf(value);
  return tag === "if" || tag === "switch";
}

function describeLevel(level: NameLevel): string {
  return level === "type" ? "type (a kind whose capability is Telo.Type)" : "resource instance";
}

/** Every `!if` / `!switch` outside template bodies, outermost first. */
function collectSites(
  manifests: readonly ResourceManifest[],
  documents: readonly ResourceManifest[],
  moduleOf: (doc: ResourceManifest) => string | undefined,
  isOwn: (doc: ResourceManifest) => boolean,
): ChoiceSite[] {
  const sites: ChoiceSite[] = [];
  const walk = (
    holder: ResourceManifest,
    value: unknown,
    keys: (string | number)[],
    parent: ChoiceSite["parent"],
    declaration: boolean,
  ): void => {
    if (isExpansionSentinel(value)) {
      const tag = expansionTagOf(value);
      if (tag !== "if" && tag !== "switch") return;
      const site: ChoiceSite = {
        sentinel: value,
        tag,
        holder,
        keys: [...keys],
        declaration: declaration || "metadata" in value,
        ...(parent ? { parent } : {}),
        module: moduleOf(holder),
        ...(importPathOf(holder) ? { importPath: importPathOf(holder) } : {}),
        own: isOwn(holder),
      };
      sites.push(site);
      for (const [branch, branchKeys] of branchesOf(site)) {
        walk(holder, valueAt(value, branchKeys), [...keys, ...branchKeys], { site, branch }, site.declaration);
      }
      return;
    }
    if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(holder, item, [...keys, i], parent, false));
      return;
    }
    for (const [key, field] of Object.entries(value)) walk(holder, field, [...keys, key], parent, false);
  };
  for (const doc of manifests) {
    if (isKindDocumentOrImport(doc) || isExpansionSentinel(doc)) continue;
    if (isModuleKind(doc.kind)) {
      const targets = (doc as Record<string, unknown>).targets;
      if (Array.isArray(targets)) targets.forEach((item, i) => walk(doc, item, ["targets", i], undefined, false));
      continue;
    }
    for (const [key, field] of Object.entries(doc)) {
      if (key === "kind" || key === "metadata") continue;
      walk(doc, field, [key], undefined, false);
    }
  }
  for (const doc of documents) walk(doc, doc, [], undefined, true);
  return sites;
}
