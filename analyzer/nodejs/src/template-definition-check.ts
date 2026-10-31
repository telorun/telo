/**
 * A TEMPLATE DEFINITION IS CHECKED WITH NO CONSUMER.
 *
 * Every `!if` / `!switch` / `!for-each` a `Telo.Definition`'s body holds is read
 * here once: each repeat's source and binding, each splice's key, each choice's
 * condition or selector — and from those, the DEFINITION DIMENSIONS the body is
 * checked over:
 *
 *  - a CLOSED read is a dimension keyed by its read path, ranging over the domain
 *    the schema closes there — an `enum` / `const` / boolean at a `self.` path,
 *    at a binding's element (`each.value.mode`), past a reference into the
 *    referenced kind's own schema, or a library input's declared domain;
 *  - every other read a consumer can decide (an open `self.` path, a binding's
 *    `key` / `index`, a module call) makes its leaf of the condition an ATOM,
 *    keyed by the leaf's canonical text (`condition-atoms.ts`), so two tags whose
 *    conditions are equal or negated take matching branches; a `!switch` over an
 *    open selector is one atom ranging over the case keys of every switch on
 *    that selector, and "another value";
 *  - a read no consumer can decide (`request`, `inputs`, `steps`, `ports`, a
 *    resource's published state) is `BRANCH_UNDECIDABLE` at the template.
 *
 * A choice is STRUCTURAL when its branches can differ in which body declarations
 * exist, in their kind, or in the references and `resources.` / `steps.` reads
 * they hold. The body is expanded once per assignment of the structural
 * dimensions, and within each, once per assignment of the dimensions the
 * non-structural choices of any one entry read — every entry walking its own
 * product, so an entry's checks run once per assignment of what it reads and the
 * whole-body checks once per structural assignment, never over the product of
 * choices that cannot interact. Each repeat emits one representative element.
 * Exhaustiveness, reachability and case keys are decided per choice, over its
 * own dimensions; a branch no assignment takes is still checked, in a variant of
 * its own.
 *
 * Browser-safe.
 */
import { listRequests } from "./declaration-requests.js";
import type { ResourceManifest } from "@telorun/sdk";
import { isCompiledValue } from "@telorun/sdk";
import {
  CEL_ENGINE,
  celEngine,
  expansionBody,
  expansionTagOf,
  isExpansionSentinel,
  isRefSentinel,
  isTaggedSentinel,
  type ExpansionSentinel,
} from "@telorun/templating";
import { refSentinelTarget } from "./ref-sentinel-target.js";
import type { AliasResolver } from "./alias-resolver.js";
import { buildSelfSchema } from "./cel-scope.js";
import { moduleNamesEnvironment } from "./cel-environment.js";
import {
  branchesOf,
  branchForValue,
  caseKeyValue,
  celTypeOfValue,
  declarationBranchProblem,
  describeBranch,
  evaluate,
  staticTypeProblem,
  valueTypeProblem,
} from "./choice-reading.js";
import {
  canonicalSource,
  conditionShape,
  evaluateShape,
  leavesOf,
  type BooleanShape,
} from "./condition-atoms.js";
import { admitsAbsence, entriesOfBlocks, memberDomain, wholeDomain } from "./configuration-dimensions.js";
import { readDecisionExpression } from "./decision-reads.js";
import type { DefinitionRegistry } from "./definition-registry.js";
import type { ExpansionReading, ExpansionSite } from "./expansion-sites.js";
import { findBindingSites } from "./cel-bindings.js";
import { checkName, CEL_RESERVED_WORDS } from "./identifier-name.js";
import { buildKernelGlobalsIndex, mergeKernelGlobalsIntoContext } from "./kernel-globals.js";
import { isModuleKind } from "./module-kinds.js";
import { bodyResourcesFor } from "./template-body-resources.js";
import { moduleAliasScope } from "./module-alias-scope.js";
import { moduleCallNamesByModule, moduleCallNamesOf } from "./module-call-names.js";
import { readRefSlot } from "./ref-slot.js";
import { forbiddenCatalogCall, ruleEnv } from "./rule-condition.js";
import { gatherPropertySchemas, resolveLocalRef } from "./schema-walk.js";
import {
  expandTemplateBody,
  parseKeys,
  pathText,
  TEMPLATE_BODY_FIELDS,
  type LoopBinding,
  type LoopElement,
  type LoopInstance,
  type TemplateBodyExpansion,
} from "./template-expansion.js";
import { extractContextsFromSchema } from "./validate-cel-context.js";
import { substituteDecodedCelFields } from "./plain-literal-decoding.js";
import type { StandIns } from "./stand-in-findings.js";
import { DiagnosticSeverity, type AnalysisDiagnostic } from "./types.js";
import { iteratesFamilySource, type LoopView } from "./family-source.js";
import { ConditionSpace } from "./presence-condition.js";

const SOURCE = "telo-analyzer";

/** The value of a switch atom no case key names. */
export const OTHER_VALUE = "\0other";
/** The key a splice's representative element emits at the definition. */
export const REPRESENTATIVE_KEY = "⟨key⟩";

/** The CEL globals a binding may not shadow. */
const RESERVED_GLOBALS = new Set([
  "self",
  "variables",
  "secrets",
  "ports",
  "module",
  "resources",
  "steps",
  "inputs",
  "request",
  "error",
]);

/** The roots no consumer's literal can decide. */
const UNDECIDABLE_ROOTS = new Set(["request", "inputs", "steps", "ports", "error", "result", "resources"]);

/** One definition dimension. */
export interface TemplateDimension {
  readonly key: string;
  readonly values: readonly unknown[];
  /** `closed`: a read path over its schema's domain; `input`: a module input,
   *  in the input key space; `atom`: a leaf's truth; `selector`: an open
   *  selector's value. */
  readonly kind: "closed" | "input" | "atom" | "selector";
}

/** A definition's assignment of its dimensions. */
export type TemplateAssignment = Readonly<Record<string, unknown>>;

/** One expansion of one definition, and what it assigns where. */
export interface DefinitionVariant {
  readonly expansion: TemplateBodyExpansion;
  /** The dimensions a finding at `writtenPath` varies over, and what this
   *  variant assigns them. */
  assignmentAt(writtenPath: string): { readonly assignment: TemplateAssignment; readonly dimensions: readonly TemplateDimension[] };
  /** The branch this variant forces, where it exists to check one no
   *  assignment takes: only what is found beneath it is kept. */
  readonly forced?: string;
  /** The loop bindings in scope at an expanded path, as CEL context
   *  properties. */
  bindingsAt(path: string): Record<string, Record<string, any>> | undefined;
}

export interface TemplateDefinitions {
  readonly diagnostics: readonly AnalysisDiagnostic[];
  /** Constructs refused here: what is found at or beneath one is dropped. */
  readonly refused: readonly { readonly holder: ResourceManifest; readonly path: string }[];
  /** Every definition whose body holds a construct, as written. */
  readonly definitions: readonly ResourceManifest[];
  /** The most variants any one definition has. */
  readonly variantCount: number;
  /** `definition`'s variant `index`, clamped to its own count. */
  variant(definition: ResourceManifest, index: number): DefinitionVariant;
  /** Every variant of `definition`. */
  variantsOf(definition: ResourceManifest): number;
  /** Diagnostic statistics, for measuring the model. */
  stats(definition: ResourceManifest): { structural: number; entries: ReadonlyMap<string, number> };
}

export interface TemplateDefinitionInputs {
  readonly manifests: readonly ResourceManifest[];
  readonly reading: ExpansionReading;
  readonly registry: DefinitionRegistry;
  readonly aliases: AliasResolver;
  readonly aliasesByModule: Map<string, AliasResolver>;
}

/** A loop's binding as a CEL context property: a closed record. */
export function bindingRecordSchema(binding: Pick<LoopBinding, "keyed" | "element">): Record<string, any> {
  return {
    type: "object",
    additionalProperties: false,
    required: binding.keyed ? ["value", "index", "key"] : ["value", "index"],
    properties: {
      value: binding.element ?? {},
      index: { type: "integer" },
      ...(binding.keyed ? { key: { type: "string" } } : {}),
    },
  };
}

/** True when a definition's body holds an expansion construct. */
export function holdsTemplateConstructs(definition: ResourceManifest): boolean {
  if (definition.kind !== "Telo.Definition") return false;
  const seen = (value: unknown): boolean => {
    if (value === null || typeof value !== "object") return false;
    if (expansionTagOf(value) !== undefined) return true;
    if (isTaggedSentinel(value) || isCompiledValue(value)) return false;
    if (Array.isArray(value)) return value.some(seen);
    return Object.entries(value).some(([key, field]) => key === "..." || seen(field));
  };
  return ["resources", "targets", "invoke", "run", "provide", "mount", "inputs", "result"].some((field) =>
    seen((definition as Record<string, unknown>)[field]),
  );
}

interface Choice {
  readonly site: ExpansionSite;
  readonly sentinel: ExpansionSentinel;
  readonly tag: "if" | "switch";
  readonly keys: readonly (string | number)[];
  readonly entry: string;
  readonly structural: boolean;
  /** The dimension keys it reads. */
  readonly dimensions: string[];
  /** Refused here: never decided, its place dropped. */
  readonly refused?: true;
  /** Its branch under an assignment of its dimensions; undefined when it
   *  cannot be decided (a refused choice). */
  decide(assignment: TemplateAssignment): string | null | undefined;
}

/** Read every template definition `inputs.manifests` holds. */
export function readTemplateDefinitions(inputs: TemplateDefinitionInputs): TemplateDefinitions {
  const { manifests, reading, registry, aliases, aliasesByModule } = inputs;
  const diagnostics: AnalysisDiagnostic[] = [];
  const refused: { holder: ResourceManifest; path: string }[] = [];
  const rootModules = new Set<string>();
  for (const m of manifests) {
    if (isModuleKind(m.kind) && typeof m.metadata?.name === "string") rootModules.add(m.metadata.name);
  }
  const globals = buildKernelGlobalsIndex(
    listRequests(manifests as ResourceManifest[]),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    bodyResourcesFor(registry, aliases, { aliasesByModule, rootModules }),
  );
  const callNames = moduleCallNamesByModule(manifests);

  const sitesBy = new Map<ResourceManifest, ExpansionSite[]>();
  for (const site of reading.sites) {
    if (!site.inTemplate || site.holder.kind !== "Telo.Definition") continue;
    const list = sitesBy.get(site.holder);
    if (list) list.push(site);
    else sitesBy.set(site.holder, [site]);
  }

  const variantsBy = new Map<ResourceManifest, (index: number) => DefinitionVariant>();
  const countBy = new Map<ResourceManifest, number>();
  const statsBy = new Map<ResourceManifest, { structural: number; entries: Map<string, number> }>();
  for (const [definition, sites] of sitesBy) {
    const read = readDefinition(definition, sites);
    variantsBy.set(definition, read.variant);
    countBy.set(definition, read.count);
    statsBy.set(definition, read.stats);
  }

  return {
    diagnostics,
    refused,
    definitions: [...sitesBy.keys()],
    variantCount: Math.max(1, ...countBy.values()),
    variant: (definition, index) => {
      const count = countBy.get(definition) ?? 1;
      return variantsBy.get(definition)!(Math.min(index, count - 1));
    },
    variantsOf: (definition) => countBy.get(definition) ?? 1,
    stats: (definition) => statsBy.get(definition) ?? { structural: 1, entries: new Map() },
  };

  function readDefinition(
    definition: ResourceManifest,
    sites: readonly ExpansionSite[],
  ): {
    variant: (index: number) => DefinitionVariant;
    count: number;
    stats: { structural: number; entries: Map<string, number> };
  } {
    const scope = moduleAliasScope(definition.metadata, aliases, aliasesByModule);
    const selfSchema = buildSelfSchema(definition as Record<string, any>, registry, scope);
    const schemaRefused = holdsExpansionSentinel(definition.schema);
    const metadata = definition.metadata as { name?: string; source?: string; module?: string } | undefined;
    const label = `Telo.Definition/${metadata?.name ?? ""}`;
    const report = (
      code: string,
      keys: readonly (string | number)[],
      message: string,
      severity: DiagnosticSeverity = DiagnosticSeverity.Error,
    ) =>
      diagnostics.push({
        severity,
        code,
        source: SOURCE,
        message: `${label}: ${message}`,
        data: {
          resource: { kind: "Telo.Definition", name: metadata?.name },
          ...(metadata?.source ? { filePath: metadata.source } : {}),
          path: pathText(keys),
        },
      });
    const refuse = (keys: readonly (string | number)[]) => refused.push({ holder: definition, path: pathText(keys) });
    const moduleNames = moduleCallNamesOf(callNames, definition);
    const moduleDoc = manifests.find(
      (m) => (m.kind === "Telo.Application" || m.kind === "Telo.Library") &&
        (metadata?.module === undefined || m.metadata?.name === metadata.module),
    ) as Record<string, any> | undefined;
    const moduleMetadata = (moduleDoc?.metadata ?? {}) as Record<string, unknown>;

    const live = sites.filter((site) => site.refusal === undefined);
    const positions = new Map<unknown, ExpansionSite>(live.map((site) => [site.value, site]));
    const keysOf = (site: ExpansionSite) => parseKeys(site.path);

    // Loops: their bindings, outermost first, and the loops each site sits in.
    const repeats = live.filter((site) => site.construct === "for-each");
    const enclosingOf = (site: ExpansionSite): ExpansionSite[] =>
      repeats
        .filter((r) => r !== site && isUnder(site.path, `${r.path}.emit`))
        .sort((a, b) => a.path.length - b.path.length);
    const bindings = new Map<ExpansionSite, LoopBinding>();
    const views = new Map<ExpansionSite, LoopView>();
    for (const repeat of [...repeats].sort((a, b) => a.path.length - b.path.length)) {
      const body = expansionBody(repeat.value as ExpansionSentinel);
      const keys = keysOf(repeat);
      const outer = enclosingOf(repeat).map((r) => bindings.get(r)!).filter(Boolean);
      const name = typeof body.as === "string" ? body.as : "each";
      const source = sourceOf(body.in, outer, keys);
      bindings.set(repeat, {
        name,
        sentinel: repeat.value as ExpansionSentinel,
        site: keys,
        keyed: source?.keyed ?? false,
        element: source?.element,
      });
      judgeBindingName(repeat, name, typeof body.as === "string", outer, keys);
      judgeEmit(repeat, body, keys);
    }
    const bindingsIn = (site: ExpansionSite): LoopBinding[] =>
      enclosingOf(site).map((r) => bindings.get(r)!).filter(Boolean);
    judgeFamilies();
    judgeMemberReferences();
    const contextFor = (inScope: readonly LoopBinding[]): Record<string, any> =>
      mergeKernelGlobalsIntoContext(
        {
          type: "object",
          additionalProperties: false,
          properties: {
            self: selfSchema,
            ...Object.fromEntries(inScope.map((b) => [b.name, bindingRecordSchema(b)])),
          },
        },
        globals.forResource(definition, "resources"),
      );

    // Splice keys: CEL typed to `string`, judged at the definition.
    for (const repeat of repeats) {
      if (repeat.position !== "splice") continue;
      const body = expansionBody(repeat.value as ExpansionSentinel);
      const keys = [...keysOf(repeat), "key"];
      const inScope = [...bindingsIn(repeat), bindings.get(repeat)!];
      if (!isTaggedSentinel(body.key) && !isCompiledValue(body.key)) {
        if (typeof body.key !== "string") {
          refuse(keys);
          report("REPEAT_KEY_INVALID", keys, `The 'key:' of '!for-each' is ${describeValue(body.key)}; a splice's key is a string, or a '!cel' expression typing to one.`);
        }
        continue;
      }
      const source = celSourceOf(body.key);
      if (source === undefined) {
        refuse(keys);
        report("REPEAT_KEY_INVALID", keys, `The 'key:' of '!for-each' is written with a tag other than '!cel'.`);
        continue;
      }
      const problems = typeProblems(source, contextFor(inScope), "string");
      if (problems.length > 0) {
        refuse(keys);
        report("REPEAT_KEY_INVALID", keys, `The 'key:' of '!for-each' ${problems.join("; ")}.`);
      }
    }

    // Choices.
    const dimensions = new Map<string, TemplateDimension>();
    /** Case keys refused as no value of the selector's type, by branch id. */
    const invalidCases = new Set<string>();
    const switchAtoms = new Map<string, Set<string>>();
    const choices: Choice[] = [];
    for (const site of live) {
      if (site.construct !== "if" && site.construct !== "switch") continue;
      const choice = readChoice(site, site.construct);
      if (choice) choices.push(choice);
    }
    for (const [key, cases] of switchAtoms) {
      dimensions.set(key, { key, values: [...cases, OTHER_VALUE], kind: "selector" });
    }

    // Per choice, over its own dimensions: exhaustiveness, reachability, keys.
    const unreachable: { choice: Choice; branch: string }[] = [];
    for (const choice of choices) {
      if (choice.refused) continue;
      const own = choice.dimensions.map((key) => dimensions.get(key)!).filter(Boolean);
      const taken = new Set<string>();
      const unmatched = new Set<string>();
      for (const assignment of product(own)) {
        const branch = choice.decide(assignment);
        if (branch === undefined) continue;
        if (branch === null) {
          if (choice.tag === "switch") {
            const selector = own.find((d) => d.kind === "selector");
            unmatched.add(
              selector && assignment[selector.key] === OTHER_VALUE
                ? "a value no case names"
                : describeAssignment(assignment, own),
            );
          }
          continue;
        }
        taken.add(branch);
      }
      const label = `'!${choice.tag}'`;
      if (unmatched.size > 0) {
        report("BRANCH_NOT_EXHAUSTIVE", choice.keys,
          `${label} selects no case for ${[...unmatched].join("; ")} and has no 'default:'. ` +
            `Add a case for each, or a 'default:'; absence decided by a selector is written as an enclosing '!if'.`);
      }
      for (const [branch, branchKeys] of branchesOf({ sentinel: choice.sentinel, tag: choice.tag })) {
        if (taken.has(branch) || invalidCases.has(`${pathText(choice.keys)}#${branch}`)) continue;
        unreachable.push({ choice, branch });
        report("BRANCH_CASE_UNREACHABLE", [...choice.keys, ...branchKeys],
          `The ${describeBranch(branch)} of ${label} is taken for no value the definition can be given` +
            (choice.tag === "if" ? ` — its condition is the same for every one.` : ` — no value its selector can hold selects it.`) +
            ` It is still checked.`,
          DiagnosticSeverity.Warning);
      }
    }

    // Variants: the structural product, and per entry the product of the rest.
    const structural = new Set<string>();
    for (const choice of choices) if (choice.structural) for (const key of choice.dimensions) structural.add(key);
    const structuralDims = [...structural].map((key) => dimensions.get(key)!).filter(Boolean);
    const entryDims = new Map<string, Set<string>>();
    for (const choice of choices) {
      if (choice.structural) continue;
      const set = entryDims.get(choice.entry) ?? new Set<string>();
      entryDims.set(choice.entry, set);
      for (const key of choice.dimensions) if (!structural.has(key)) set.add(key);
    }
    const entryProducts = new Map<string, { dims: TemplateDimension[]; assignments: TemplateAssignment[] }>();
    for (const [entry, keys] of entryDims) {
      const dims = [...keys].map((key) => dimensions.get(key)!).filter(Boolean);
      entryProducts.set(entry, { dims, assignments: product(dims) });
    }
    const width = Math.max(1, ...[...entryProducts.values()].map((p) => p.assignments.length));
    const structuralAssignments = product(structuralDims);
    type Plan = { s: TemplateAssignment; k: number; forced?: { choice: Choice; branch: string } };
    const plans: Plan[] = [];
    for (const s of structuralAssignments) for (let k = 0; k < width; k++) plans.push({ s, k });
    for (const forced of unreachable) plans.push({ s: structuralAssignments[0]!, k: 0, forced });

    const entryAssignment = (entry: string, k: number): TemplateAssignment => {
      const p = entryProducts.get(entry);
      return p ? p.assignments[k % p.assignments.length]! : {};
    };
    const entryOfPath = (path: string): string | undefined => {
      const keys = parseKeys(path);
      if (keys.length === 0) return undefined;
      return keys[0] === "resources" && typeof keys[1] === "number" ? `resources[${keys[1]}]` : String(keys[0]);
    };
    const choiceBySentinel = new Map(choices.map((c) => [c.sentinel as unknown, c]));
    const representative = (binding: LoopBinding): LoopElement => ({
      index: 0,
      value: undefined,
      representative: true,
      ...(binding.keyed ? { key: REPRESENTATIVE_KEY } : {}),
    });

    const built = new Map<number, DefinitionVariant>();
    const variant = (index: number): DefinitionVariant => {
      const known = built.get(index);
      if (known) return known;
      const plan = plans[index]!;
      const assignmentFor = (entry: string | undefined): TemplateAssignment => ({
        ...plan.s,
        ...(entry ? entryAssignment(entry, plan.k) : {}),
      });
      const expansion = expandTemplateBody(definition, {
        positionOf: (sentinel) => positions.get(sentinel)?.position,
        decide: (sentinel) => {
          const choice = choiceBySentinel.get(sentinel);
          if (!choice) return undefined;
          if (plan.forced?.choice === choice) return plan.forced.branch;
          return choice.decide(assignmentFor(choice.entry));
        },
        elements: (sentinel) => {
          const site = positions.get(sentinel);
          const binding = site ? bindings.get(site) : undefined;
          return binding ? { binding, elements: [representative(binding)] } : undefined;
        },
        key: () => REPRESENTATIVE_KEY,
      });
      const result: DefinitionVariant = {
        expansion,
        ...(plan.forced
          ? { forced: pathText([...plan.forced.choice.keys, ...branchKeysOf(plan.forced.branch)]) }
          : {}),
        assignmentAt: (writtenPath) => {
          const entry = entryOfPath(writtenPath);
          const own = entry ? entryProducts.get(entry)?.dims ?? [] : [];
          return { assignment: assignmentFor(entry), dimensions: [...structuralDims, ...own] };
        },
        bindingsAt: (path) => {
          const instance = expansion.instanceAt(path);
          if (instance.length === 0) return undefined;
          return Object.fromEntries(instance.map((frame) => [frame.binding.name, bindingRecordSchema(frame.binding)]));
        },
      };
      built.set(index, result);
      return result;
    };

    return {
      variant,
      count: plans.length,
      stats: {
        structural: structuralAssignments.length,
        entries: new Map(
          [...entryProducts].map(([entry, p]) => [entry, p.assignments.length * structuralAssignments.length]),
        ),
      },
    };

    // --- helpers over this definition ---

    function sourceOf(
      written: unknown,
      outer: readonly LoopBinding[],
      keys: readonly (string | number)[],
    ): { element: Record<string, any> | undefined; keyed: boolean } | undefined {
      const at = [...keys, "in"];
      const source = celSourceOf(written);
      const chain = source?.trim();
      const segments = chain && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(chain) ? chain.split(".") : undefined;
      const invalid = (why: string) => {
        refuse(at);
        // The schema is refused where it is written: no source can be judged by it.
        if (schemaRefused) return undefined;
        report("REPEAT_SOURCE_INVALID", at,
          `The source of '!for-each' ${why}. A repeat's source is a bare 'self.<path>' or ` +
            `'<binding>.value.<path>' naming a list or a map the schema declares.`);
        return undefined;
      };
      if (!segments) {
        return invalid(
          source === undefined
            ? `is ${describeValue(written)}, written in the template`
            : `'${chain}' is not a bare path`,
        );
      }
      let node: Record<string, any> | undefined;
      let root: Record<string, any> | undefined;
      if (segments[0] === "self") {
        ({ node, root } = walk(selfSchema, selfSchema, segments.slice(1)));
      } else {
        const binding = outer.find((b) => b.name === segments[0]);
        if (!binding || segments[1] !== "value") {
          return invalid(`'${chain}' reads neither 'self' nor the 'value' of an enclosing loop's binding`);
        }
        ({ node, root } = binding.element
          ? walk(binding.element, binding.element, segments.slice(2))
          : { node: undefined, root: undefined });
        if (!binding.element) return { element: undefined, keyed: false };
      }
      const element = node && root ? elementOf(node, root) : undefined;
      if (!element) {
        return invalid(`'${chain}' is ${node ? "not declared as a list or a map" : "not declared by the schema"}`);
      }
      return element;
    }

    function judgeBindingName(
      repeat: ExpansionSite,
      name: string,
      written: boolean,
      outer: readonly LoopBinding[],
      keys: readonly (string | number)[],
    ): void {
      const at = written ? [...keys, "as"] : keys;
      if (written) {
        const violation = checkName(name, "value", "binding name");
        if (violation) report(violation.code, at, violation.message, violation.severity);
      }
      let why: string | undefined;
      if (outer.some((b) => b.name === name)) {
        why = `an enclosing '!for-each' already binds '${name}'`;
      } else if (CEL_RESERVED_WORDS.includes(name)) {
        why = `'${name}' is a CEL keyword`;
      } else if (RESERVED_GLOBALS.has(name)) {
        why = `'${name}' is a name CEL reads in every expression here`;
      } else if (moduleNames.has(name)) {
        why = `'${name}' is a module-call receiver of this module`;
      } else if (boundByEmittedKind(repeat, name)) {
        why = `the kind an emitted item declares binds '${name}' itself`;
      }
      if (!why) return;
      report("BINDING_NAME_RESERVED", at,
        `A '!for-each' binds '${name}', but ${why}. Name the binding with ` +
          `'as:', choosing a name nothing in scope already reads.`);
    }

    /** True when an `x-telo-context` of the entry the repeat sits in binds
     *  `name` in a region covering the repeat's position. */
    function boundByEmittedKind(repeat: ExpansionSite, name: string): boolean {
      const keys = keysOf(repeat);
      if (keys[0] !== "resources" || typeof keys[1] !== "number") return false;
      const entry = ((definition as Record<string, any>).resources ?? [])[keys[1]];
      if (!entry || typeof entry.kind !== "string") return false;
      const entryDefinition = registry.resolve(scope?.resolveKind(entry.kind) ?? entry.kind) ?? registry.resolve(entry.kind);
      const schema = entryDefinition ? (registry.effectiveSchemaOf(entryDefinition) as Record<string, any> | undefined) : undefined;
      if (!schema) return false;
      const local = keys.slice(2).filter((k) => typeof k === "string").join(".");
      for (const context of extractContextsFromSchema(schema, registry.shapeLookup)) {
        const at = context.scope.replace(/^\$\.?/, "").replace(/\[\*\]/g, "");
        if (!local.startsWith(at.split(".")[0] ?? "")) continue;
        if (Object.hasOwn(context.schema.properties ?? {}, name)) return true;
      }
      // The entry's own named bindings (`x-telo-bindings-from`) are read by bare
      // name beside the loop's, so a key written there or emitted into it is the
      // same name.
      const sites = findBindingSites(schema, registry.shapeLookup);
      if (sites) {
        const declared = entry[sites.field];
        if (declared && typeof declared === "object" && !Array.isArray(declared)) {
          if (Object.hasOwn(declared, name)) return true;
          if (emitsBindingKey(declared, name)) return true;
        }
      }
      return false;
    }

    function judgeEmit(repeat: ExpansionSite, body: Record<string, unknown>, keys: readonly (string | number)[]): void {
      const emit = body.emit;
      const at = [...keys, "emit"];
      const family = isFamilyPosition(repeat.position);
      const step = repeat.position === "step";
      const named = step && typeof body.name === "string";
      const invalid = (where: readonly (string | number)[], why: string) => {
        refuse(where);
        report("REPEAT_EMIT_INVALID", where, why);
      };
      if (named) {
        const violation = checkName(body.name as string, "value", "step name");
        if (violation) report(violation.code, [...keys, "name"], violation.message, violation.severity);
      }
      if (Array.isArray(emit) && (family || named)) {
        invalid(at,
          family
            ? `A family's '!for-each' emits a sequence here; every element declares exactly one member — ` +
                `emit one unnamed declaration, or a nested '!if' / '!switch' / '!for-each' that does.`
            : `The named step repeat '${body.name as string}' emits a sequence; each element files exactly one ` +
                `result under 'steps.${body.name as string}' — emit one step.`);
        return;
      }
      if (named && expansionTagOf(emit) === "for-each") {
        invalid(at,
          `The named step repeat '${body.name as string}' emits a nested '!for-each', which emits a step per ` +
            `element of its own; each element of '${body.name as string}' files exactly one result — emit one step.`);
        return;
      }
      const items: [unknown, (string | number)[]][] =
        Array.isArray(emit) ? emit.map((item, i) => [item, [...at, i]]) : [[emit, at]];
      for (const [item, where] of items) {
        if (family) {
          judgeFamilyEmit(item, where);
          continue;
        }
        if (!item || typeof item !== "object" || Array.isArray(item) || expansionTagOf(item) !== undefined) continue;
        const record = item as Record<string, unknown>;
        if (step && "name" in record) {
          refuse(where);
          report("REPEAT_EMIT_INVALID", [...where, "name"],
            `A step a '!for-each' emits carries 'name:', which every element would repeat. An emitted step is ` +
              `unnamed: name the repeat itself (its 'name:' publishes 'steps.<name>' as a map by element key), ` +
              `or drop the name.`);
          continue;
        }
        if (typeof record.kind === "string" && "metadata" in record) {
          invalid(where,
            `The declaration '!for-each' emits here carries 'metadata': every element would declare the same ` +
              `name. An emitted declaration is unnamed — drop its 'metadata'.`);
        }
      }
    }

    /** What a family's `emit:` holds: one unnamed declaration, or a nested tag
     *  whose every branch does — and a choice there exhaustive, since every
     *  element has a member. */
    function judgeFamilyEmit(item: unknown, where: readonly (string | number)[]): void {
      const tag = expansionTagOf(item);
      if (tag === "for-each") return;
      if (tag === "if" || tag === "switch") {
        const body = item as Record<string, unknown>;
        if (tag === "if" && !("else" in body)) {
          refuse(where);
          report("REPEAT_EMIT_INVALID", where,
            `A family's '!for-each' emits an '!if' with no 'else:', so an element it is false for would have no ` +
              `member — and every member of a family is reachable by '!ref <family>[<binding>.key]'. Give the ` +
              `'!if' an 'else:', or filter the elements with an unnamed repeat at a list position.`);
          return;
        }
        for (const [, branchKeys] of branchesOf({ sentinel: item as ExpansionSentinel, tag })) {
          judgeFamilyEmit(valueAt(item, branchKeys), [...where, ...branchKeys]);
        }
        return;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      if ("metadata" in (item as Record<string, unknown>)) {
        refuse(where);
        report("REPEAT_EMIT_INVALID", where,
          `The declaration a family emits carries 'metadata': its name is the family's, written once on the ` +
            `'!for-each', and each member is named by it and its element. Drop the declaration's 'metadata'.`);
      }
    }

    /** The family loops of the body, each with the loops it is nested in. */
    function familyLoops(): { site: ExpansionSite; chain: ExpansionSite[]; name: unknown; metadataAt: (string | number)[] }[] {
      const loops = repeats.filter((r) => isFamilyPosition(r.position));
      const out: { site: ExpansionSite; chain: ExpansionSite[]; name: unknown; metadataAt: (string | number)[] }[] = [];
      for (const loop of loops) {
        const chain = loops
          .filter((other) => other === loop || isUnder(loop.path, `${other.path}.emit`))
          .sort((a, b) => a.path.length - b.path.length);
        // The identity is the outermost declaration construct's: a family's own
        // tag, or the declaration-position choice holding it.
        const holder = live
          .filter((site) => !site.nested && isFamilyPosition(site.position) && (site.path === loop.path || isUnder(loop.path, site.path)))
          .sort((a, b) => a.path.length - b.path.length)[0];
        const metadata = (holder?.value as { metadata?: { name?: unknown } } | undefined)?.metadata;
        out.push({
          site: loop,
          chain,
          name: metadata?.name,
          metadataAt: holder ? [...keysOf(holder), "metadata", "name"] : [],
        });
      }
      return out;
    }

    /** Every chain of family loops a family name declares, outermost first —
     *  one per branch of a declaration-position choice holding families. */
    function familyChains(): Map<string, ExpansionSite[][]> {
      const loops = familyLoops();
      const out = new Map<string, ExpansionSite[][]>();
      for (const loop of loops) {
        if (typeof loop.name !== "string") continue;
        const innermost = !loops.some((other) => other !== loop && other.chain.includes(loop.site));
        if (!innermost) continue;
        const list = out.get(loop.name) ?? [];
        list.push(loop.chain);
        out.set(loop.name, list);
      }
      return out;
    }

    /** A family is one name: judged once, beside the other names of its list. */
    function judgeFamilies(): void {
      const loops = familyLoops().filter((loop) => loop.chain.length === 1);
      const judged = new Set<string>();
      for (const loop of loops) {
        if (typeof loop.name !== "string") continue;
        const at = loop.metadataAt;
        if (judged.has(pathText(at))) continue;
        judged.add(pathText(at));
        const violation = checkName(loop.name, "value", "family name");
        if (violation) report(violation.code, at, violation.message, violation.severity);
        // Its list holds it once: a sibling entry of the same name is the same
        // name written twice.
        const listKeys = at.slice(0, -2);
        const list = valueAt(definition, listKeys.slice(0, -1));
        if (!Array.isArray(list)) continue;
        const own = listKeys[listKeys.length - 1];
        list.forEach((entry, i) => {
          if (i === own) return;
          const name = (entry as { metadata?: { name?: unknown } } | undefined)?.metadata?.name;
          if (name !== loop.name) return;
          report("DUPLICATE_RESOURCE_NAME", at,
            `the family '${loop.name}' and the entry at '${pathText([...listKeys.slice(0, -1), i])}' are one ` +
              `name. A family is one name in its list — rename one of them.`);
        });
      }
    }

    /**
     * Every indexed `!ref` the body holds names a member by its bindings: the
     * head a family of this body, one index per family depth, each binding an
     * enclosing loop iterating the family's own source at that depth, with the
     * member the source keys its elements by — so a member's existence is proven
     * here, never per consumer.
     */
    function judgeMemberReferences(): void {
      const chains = familyChains();
      const visit = (value: unknown, keys: (string | number)[]): void => {
        if (isRefSentinel(value)) {
          const target = refSentinelTarget(value);
          if (!target) return;
          const problem = memberReferenceProblem(target, keys, chains);
          if (problem) {
            refuse(keys);
            report("REF_MEMBER_INVALID", keys, `'!ref ${value.source}' ${problem}`);
          }
          return;
        }
        if (value === null || typeof value !== "object" || isTaggedSentinel(value) || isCompiledValue(value)) return;
        if (Array.isArray(value)) {
          value.forEach((item, i) => visit(item, [...keys, i]));
          return;
        }
        for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
          visit(field, [...keys, key]);
        }
      };
      for (const field of TEMPLATE_BODY_FIELDS) {
        const value = (definition as Record<string, unknown>)[field];
        if (value !== undefined) visit(value, [field]);
      }
    }

    function memberReferenceProblem(
      target: { alias?: string; name: string; indexes: readonly { binding: string; member: "key" | "index" }[] },
      keys: readonly (string | number)[],
      chains: ReadonlyMap<string, ExpansionSite[][]>,
    ): string | undefined {
      if (target.alias !== undefined && target.alias !== "Self") return undefined;
      const variants = chains.get(target.name);
      if (!variants) {
        return target.indexes.length === 0
          ? undefined
          : `indexes '${target.name}', which is no family of this template: only a '!for-each' at a ` +
              `'resources:' entry declares members. Reference a plain entry as '!ref ${target.name}'.`;
      }
      if (target.indexes.length === 0) {
        return `names the family '${target.name}' as a whole; a reference names one member, written ` +
          `'!ref ${target.name}[<binding>.key]' with a loop over the family's own source in scope.`;
      }
      const path = pathText(keys);
      const enclosing = repeats
        .filter((r) => isUnder(path, `${r.path}.emit`))
        .sort((a, b) => b.path.length - a.path.length);
      const loopNamed = (name: string, within: readonly ExpansionSite[]): ExpansionSite | undefined =>
        within.find((r) => bindings.get(r)?.name === name);
      for (const chain of variants) {
        if (chain.length !== target.indexes.length) {
          return `gives ${target.indexes.length} ${target.indexes.length === 1 ? "index" : "indexes"}, but the ` +
            `family '${target.name}' is ${chain.length} deep: write one '[<binding>.key]' per level.`;
        }
        const loops: ExpansionSite[] = [];
        for (let depth = 0; depth < chain.length; depth++) {
          const index = target.indexes[depth]!;
          const loop = loopNamed(index.binding, enclosing);
          if (!loop) {
            return `indexes by '${index.binding}', which no enclosing '!for-each' binds here; a member is named ` +
              `by the binding of a loop around the reference.`;
          }
          const familyLoop = chain[depth]!;
          const keyed = bindings.get(familyLoop)?.keyed ?? false;
          if ((index.member === "key") !== keyed) {
            return keyed
              ? `reads '${index.binding}.index' at depth ${depth}, but the family's source there is a map, whose ` +
                  `members are named by key: write '[${index.binding}.key]'.`
              : `reads '${index.binding}.key' at depth ${depth}, but the family's source there is a list, which ` +
                  `has no keys: write '[${index.binding}.index]'.`;
          }
          const same = iteratesFamilySource(
            depth,
            viewOf(loop),
            loops[depth - 1] ? viewOf(loops[depth - 1]!) : undefined,
            viewOf(familyLoop),
          );
          if (!same) {
            return `indexes by '${index.binding}', which iterates ${describeSource(loop)}, not the family's own ` +
              `source at that depth (${describeSource(familyLoop)}): only a loop over the same source proves ` +
              `the member exists.`;
          }
          loops.push(loop);
        }
      }
      return undefined;
    }

    /** A loop as the shared same-source rule sees it. */
    function viewOf(site: ExpansionSite): LoopView {
      let view = views.get(site);
      if (!view) {
        view = {
          binding: bindings.get(site)?.name ?? "each",
          source: celSourceOf((site.value as Record<string, unknown>).in),
          get enclosing() {
            return enclosingOf(site).map(viewOf);
          },
        };
        views.set(site, view);
      }
      return view;
    }

    function describeSource(loop: ExpansionSite): string {
      const source = celSourceOf((loop.value as Record<string, unknown>).in);
      return source !== undefined ? `'${source.trim()}'` : "a source that is no expression";
    }

    function readChoice(site: ExpansionSite, tag: "if" | "switch"): Choice | undefined {
      const sentinel = site.value as ExpansionSentinel;
      const keys = keysOf(site);
      const entry = keys[0] === "resources" && typeof keys[1] === "number" ? `resources[${keys[1]}]` : String(keys[0]);
      const label = `'!${tag}'`;
      const what = tag === "if" ? "condition" : "selector";
      const at = [...keys, tag];
      const inScope = bindingsIn(site);
      const declarationPosition =
        (site.position === "template-resource" || site.position === "scope-member") && !site.nested;
      if (declarationPosition) {
        let first: { arity: number; branch: string } | undefined;
        for (const [branch, branchKeys] of branchesOf({ sentinel, tag })) {
          const value = valueAt(sentinel, branchKeys);
          // A family is a branch here too; every branch declares as many
          // levels of members, so a `!ref` to the name has one meaning.
          const arity = declarationArity(value);
          if (arity !== undefined) {
            if (!first) first = { arity, branch };
            else if (arity !== first.arity) {
              refuse([...keys, ...branchKeys]);
              report("BRANCH_CASE_INVALID", [...keys, ...branchKeys],
                `The ${describeBranch(branch)} of ${label} declares ${describeArity(arity)}, where its ` +
                  `${describeBranch(first.branch)} declares ${describeArity(first.arity)}. Every branch at a ` +
                  `declaration position declares the same thing under the tag's name: one resource, or a ` +
                  `family as deep as the others.`);
              continue;
            }
          }
          if (expansionTagOf(value) === "for-each") continue;
          const problem = declarationBranchProblem(value);
          if (!problem) continue;
          refuse([...keys, ...branchKeys]);
          report("BRANCH_CASE_INVALID", [...keys, ...branchKeys],
            `The ${describeBranch(branch)} of ${label} at a declaration position ${problem}. Each branch is one ` +
              `unnamed resource declaration — '{ kind, …fields }' — or a nested '!if' / '!switch' whose ` +
              `branches are; the tag's own 'metadata' names it once for every branch.`);
        }
      }
      const structural =
        site.position === "template-resource" ||
        site.position === "scope-member" ||
        keys[0] === "targets" ||
        branchesOf({ sentinel, tag }).some(([, branchKeys]) => holdsReferences(valueAt(sentinel, branchKeys)));
      const written = (sentinel as Record<string, unknown>)[tag];
      const standIn = (): Choice => {
        refuse(keys);
        return { site, sentinel, tag, keys, entry, structural, dimensions: [], refused: true, decide: () => undefined };
      };
      if (!isTaggedSentinel(written) && !isCompiledValue(written)) {
        const problem = valueTypeProblem(tag, written);
        if (problem) {
          report("BRANCH_CONDITION_INVALID", at, `The ${what} of ${label} ${problem}`);
          return standIn();
        }
        return {
          site, sentinel, tag, keys, entry, structural, dimensions: [],
          decide: () => branchForValue(sentinel, tag, written),
        };
      }
      const source = celSourceOf(written);
      if (source === undefined) {
        report("BRANCH_CONDITION_INVALID", at,
          `The ${what} of ${label} is written with a tag other than '!cel'; a ${what} is a '!cel' expression or a literal.`);
        return standIn();
      }
      // A read no consumer can decide is the one report: typing it against a
      // context that holds no such name would only say it is undefined.
      const openReads = classify(source, inScope).undecidable;
      if (openReads.length > 0) {
        undecidable(at, label, what, openReads);
        return standIn();
      }
      const problems = typeProblems(source, contextFor(inScope), undefined);
      const analysisType = staticTypeOf(source, contextFor(inScope));
      const typeProblem = analysisType ? staticTypeProblem(tag, analysisType) : undefined;
      if (problems.length > 0 || typeProblem) {
        report("BRANCH_CONDITION_INVALID", at,
          `The ${what} of ${label} ${[...problems, ...(typeProblem ? [typeProblem.replace(/\.$/, "")] : [])].join("; ")}.`);
        return standIn();
      }

      if (tag === "switch") {
        const reads = classify(source, inScope);
        if (reads.undecidable.length > 0) {
          undecidable(at, label, what, reads.undecidable);
          return standIn();
        }
        const cases = Object.keys(((sentinel as Record<string, unknown>).cases as Record<string, unknown>) ?? {});
        if (reads.open) {
          const key = canonicalSource(source) ?? source.trim();
          const set = switchAtoms.get(key) ?? new Set<string>();
          for (const c of cases) set.add(c);
          switchAtoms.set(key, set);
          return {
            site, sentinel, tag, keys, entry, structural, dimensions: [key],
            decide: (assignment) => {
              const value = assignment[key];
              if (value === undefined) return undefined;
              if (value === OTHER_VALUE) return "default" in (sentinel as Record<string, unknown>) ? "default" : null;
              return cases.includes(value as string) ? `case:${value as string}` : null;
            },
          };
        }
        for (const dimension of reads.dimensions) dimensions.set(dimension.key, dimension);
        const keysRead = reads.dimensions.map((d) => d.key);
        // Case keys read as the selector's type: its static type, else the type
        // of the values its domain closes to.
        const domainType = reads.dimensions
          .flatMap((d) => d.values)
          .map((v) => celTypeOfValue(asCel(v)))
          .find((t) => t !== undefined);
        const selectorType = analysisType && analysisType !== "dyn" ? analysisType : domainType;
        for (const caseKey of cases) {
          if (caseKeyValue(caseKey, selectorType) !== undefined) continue;
          invalidCases.add(`${pathText(keys)}#case:${caseKey}`);
          report("BRANCH_CASE_KEY_INVALID", [...keys, "cases", caseKey],
            `Case '${caseKey}' of ${label} is not a value of the selector's type '${selectorType}'` +
              (selectorType === "int" ? ` — an integer case is its decimal literal ('1', never '01').` : selectorType === "bool" ? ` — a boolean case is 'true' or 'false'.` : `.`));
        }
        return {
          site, sentinel, tag, keys, entry, structural, dimensions: keysRead,
          decide: (assignment) => {
            const value = evaluateClosed(source, assignment, inScope);
            return value === undefined ? undefined : branchForValue(sentinel, tag, value.value);
          },
        };
      }

      const shaped = conditionShape(source);
      if ("parseError" in shaped) return standIn();
      const leaves = leavesOf(shaped.shape);
      const leafReads = new Map<string, ReturnType<typeof classify>>();
      const undecidableReads: string[] = [];
      for (const leaf of leaves) {
        const reads = classify(leaf.source, inScope);
        leafReads.set(leaf.source, reads);
        undecidableReads.push(...reads.undecidable);
      }
      if (undecidableReads.length > 0) {
        undecidable(at, label, what, undecidableReads);
        return standIn();
      }
      const keysRead = new Set<string>();
      for (const leaf of leaves) {
        const reads = leafReads.get(leaf.source)!;
        if (reads.open) {
          dimensions.set(leaf.canonical, { key: leaf.canonical, values: [true, false], kind: "atom" });
          keysRead.add(leaf.canonical);
        } else {
          for (const dimension of reads.dimensions) {
            dimensions.set(dimension.key, dimension);
            keysRead.add(dimension.key);
          }
        }
      }
      const shape: BooleanShape = shaped.shape;
      return {
        site, sentinel, tag, keys, entry, structural, dimensions: [...keysRead],
        decide: (assignment) => {
          let failed = false;
          const value = evaluateShape(shape, (leaf) => {
            if (leafReads.get(leaf.source)!.open) {
              const atom = assignment[leaf.canonical];
              if (atom === undefined) failed = true;
              // The atom is the `==` a `!=` negates; the shape negates it back.
              return atom === true;
            }
            const closed = evaluateClosed(leaf.source, assignment, inScope);
            if (closed === undefined || typeof closed.value !== "boolean") {
              failed = true;
              return false;
            }
            return leaf.negated ? !closed.value : closed.value;
          });
          return failed ? undefined : branchForValue(sentinel, tag, value);
        },
      };
    }

    function undecidable(at: (string | number)[], label: string, what: string, reads: readonly string[]): void {
      refuse(at.slice(0, -1));
      report("BRANCH_UNDECIDABLE", at,
        `The ${what} of ${label} is decided when an instance is created, before it runs, but it reads ` +
          `${[...new Set(reads)].map((r) => `'${r}'`).join(", ")}, which no consumer's manifest can decide. ` +
          `A template's choice reads 'self', a loop's binding, a declaration a reference names, ` +
          `'module.<field>' or the module's own inputs.`);
    }

    /** What an expression's reads are: dimensions, open reads a consumer can
     *  decide, and reads no consumer can. */
    function classify(
      source: string,
      inScope: readonly LoopBinding[],
    ): { dimensions: TemplateDimension[]; open: boolean; undecidable: string[] } {
      const expression = readDecisionExpression(source);
      const out = { dimensions: [] as TemplateDimension[], open: false, undecidable: [] as string[] };
      for (const read of expression.reads) {
        if (read.class === "module") {
          out.dimensions.push({ key: read.chain, values: [moduleMetadata[read.field]], kind: "closed" });
          continue;
        }
        if (read.class === "call") {
          out.open = true;
          continue;
        }
        if (read.class === "input") {
          const r = read.read;
          if (r.input === "resources") {
            out.open = true;
            continue;
          }
          const entry = (moduleDoc?.[r.input] as Record<string, any> | undefined)?.[r.name] as
            | Record<string, unknown>
            | undefined;
          const absent = entry ? admitsAbsence(entry) : false;
          const domain =
            !entry
              ? undefined
              : r.projection === "whole"
                ? wholeDomain(r.input, entry)
                : r.projection === "member"
                  ? memberDomain(entry, r.member!)
                  : ["present"];
          if (!domain || (r.projection === "presence" && !absent)) {
            if (r.projection === "presence" && entry && !absent) {
              out.dimensions.push({ key: r.chain, values: ["present"], kind: "input" });
              continue;
            }
            out.open = true;
            continue;
          }
          out.dimensions.push({
            key: r.projection === "member" ? `${r.input}.${r.name}.${r.member}` : `${r.input}.${r.name}`,
            values: absent ? [...domain, null] : domain,
            kind: "input",
          });
          continue;
        }
        const chain = read.chain;
        const segments = chain.split(".");
        const root = segments[0]!;
        if (root === "self") {
          const { node } = walk(selfSchema, selfSchema, segments.slice(1));
          const domain = node ? domainOf(node) : undefined;
          if (domain && !chain.includes("[") && !chain.includes("?")) {
            out.dimensions.push({ key: chain, values: domain, kind: "closed" });
          } else out.open = true;
          continue;
        }
        const binding = inScope.find((b) => b.name === root);
        if (binding) {
          if (segments[1] === "value" && binding.element && !chain.includes("[") && !chain.includes("?")) {
            const { node } = walk(binding.element, binding.element, segments.slice(2));
            const domain = node ? domainOf(node) : undefined;
            if (domain) {
              out.dimensions.push({ key: chain, values: domain, kind: "closed" });
              continue;
            }
          }
          out.open = true;
          continue;
        }
        if (UNDECIDABLE_ROOTS.has(root)) {
          out.undecidable.push(chain);
          continue;
        }
        out.open = true;
      }
      return out;
    }

    /** An expression's value under a closed assignment, or undefined when it
     *  cannot be evaluated there. */
    function evaluateClosed(
      source: string,
      assignment: TemplateAssignment,
      inScope: readonly LoopBinding[],
    ): { value: unknown } | undefined {
      const activation: Record<string, unknown> = { self: {}, module: moduleMetadata, variables: {}, secrets: {} };
      for (const binding of inScope) activation[binding.name] = { value: {} };
      for (const [key, value] of Object.entries(assignment)) {
        if (dimensions.get(key)?.kind === "atom" || dimensions.get(key)?.kind === "selector") continue;
        if (key.startsWith("module.")) continue;
        setPath(activation, key.split("."), value === "present" ? "present" : asCel(value));
      }
      try {
        return { value: evaluate(source, activation, moduleNames) };
      } catch {
        return undefined;
      }
    }

    /** What the engine refuses about `source` in `context`, and, with `type`,
     *  a result that is not of that type. */
    function typeProblems(source: string, context: Record<string, any>, type: string | undefined): string[] {
      const analysis = celEngine.analyze(source, {
        celEnv: moduleNamesEnvironment(ruleEnv(), moduleNames),
        contextSchema: context,
        moduleNames,
      } as never);
      const out = analysis.diagnostics.map((d) => d.message);
      for (const call of analysis.calls) {
        const forbidden = forbiddenCatalogCall(call);
        if (forbidden) {
          out.push(
            forbidden === "host-backed"
              ? `calls '${call.name}()', which the runtime supplies at boot`
              : `calls '${call.name}()', which re-evaluates per call`,
          );
        }
      }
      if (type && out.length === 0 && analysis.type && analysis.type !== "dyn" && analysis.type !== type) {
        out.push(`types to '${analysis.type}', where a splice's key is a 'string'`);
      }
      return out;
    }

    function staticTypeOf(source: string, context: Record<string, any>): string | undefined {
      const analysis = celEngine.analyze(source, {
        celEnv: moduleNamesEnvironment(ruleEnv(), moduleNames),
        contextSchema: context,
        moduleNames,
      } as never);
      return analysis.type;
    }

    /** `segments` read down a schema, crossing a reference slot into the
     *  referenced kind's own schema. */
    function walk(
      start: Record<string, any>,
      startRoot: Record<string, any>,
      segments: readonly string[],
    ): { node: Record<string, any> | undefined; root: Record<string, any> | undefined } {
      let node: Record<string, any> | undefined = resolveLocalRef(start, startRoot);
      let root = startRoot;
      for (const segment of segments) {
        if (!node) return { node: undefined, root: undefined };
        const slot = readRefSlot(node);
        if (slot) {
          const crossed = slot.kinds.length === 1 ? registry.resolve(slot.kinds[0]!) : undefined;
          const schema = crossed ? (registry.effectiveSchemaOf(crossed) as Record<string, any> | undefined) : undefined;
          if (!schema) return { node: undefined, root: undefined };
          node = schema;
          root = schema;
        }
        const property = gatherPropertySchemas(node, root).find(([name]) => name === segment)?.[1];
        const additional = node.additionalProperties;
        node = property
          ? resolveLocalRef(property, root)
          : additional && typeof additional === "object"
            ? resolveLocalRef(additional, root)
            : undefined;
      }
      return { node, root };
    }
  }
}

/** How many levels of members a declaration-position value declares: 0 for one
 *  resource, one more per family loop — undefined where its own branches
 *  disagree (reported at the choice holding them). */
function declarationArity(value: unknown): number | undefined {
  const tag = expansionTagOf(value);
  if (tag === "for-each") {
    const inner = declarationArity((value as Record<string, unknown>).emit);
    return inner === undefined ? undefined : inner + 1;
  }
  if (tag === "if" || tag === "switch") {
    const arities = branchesOf({ sentinel: value as ExpansionSentinel, tag })
      .map(([, keys]) => declarationArity(valueAt(value, keys)));
    const first = arities[0];
    return arities.every((a) => a === first) ? first : undefined;
  }
  return 0;
}

function describeArity(arity: number): string {
  return arity === 0 ? "one resource" : arity === 1 ? "a family" : `a family ${arity} levels deep`;
}

/** True for a declaration position: a `!for-each` there declares a family. */
function isFamilyPosition(position: ExpansionSite["position"]): boolean {
  return position === "template-resource" || position === "scope-member";
}

/** The values a schema node closes its domain to. */
function domainOf(node: Record<string, any>): unknown[] | undefined {
  if (Array.isArray(node.enum)) return [...node.enum];
  if (Object.hasOwn(node, "const")) return [node.const];
  if (node.type === "boolean") return [false, true];
  return undefined;
}

/** A list's item schema or a map's value schema. */
function elementOf(
  node: Record<string, any>,
  root: Record<string, any>,
): { element: Record<string, any>; keyed: boolean } | undefined {
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) return undefined;
  if (node.type === "array" || (node.items && typeof node.items === "object" && !Array.isArray(node.items))) {
    const items = node.items;
    return items && typeof items === "object" && !Array.isArray(items)
      ? { element: resolveLocalRef(items, root) ?? items, keyed: false }
      : undefined;
  }
  const additional = node.additionalProperties;
  const patterns = node.patternProperties as Record<string, Record<string, any>> | undefined;
  const values = [
    ...(additional && typeof additional === "object" ? [additional] : []),
    ...Object.values(patterns ?? {}),
  ];
  if (values.length === 0) return undefined;
  const element = values.length === 1 ? values[0]! : { anyOf: values };
  return { element: resolveLocalRef(element, root) ?? element, keyed: true };
}

/** Every assignment of `dimensions`. */
function product(dimensions: readonly TemplateDimension[]): TemplateAssignment[] {
  let out: Record<string, unknown>[] = [{}];
  for (const dimension of dimensions) {
    const next: Record<string, unknown>[] = [];
    for (const partial of out) for (const value of dimension.values) next.push({ ...partial, [dimension.key]: value });
    out = next;
  }
  return out;
}

function describeAssignment(assignment: TemplateAssignment, dimensions: readonly TemplateDimension[]): string {
  return dimensions.map((d) => describeDimensionValue(d, assignment[d.key])).join(" and ");
}

/** One dimension's value, as a label clause names it. */
export function describeDimensionValue(dimension: TemplateDimension, value: unknown): string {
  if (dimension.kind === "atom") return `'${dimension.key}' is ${value === true ? "true" : "false"}`;
  if (dimension.kind === "selector") {
    if (value === OTHER_VALUE) {
      const named = dimension.values.filter((v) => v !== OTHER_VALUE).map((v) => `'${String(v)}'`);
      return `'${dimension.key}' is none of ${named.join(", ")}`;
    }
    return `'${dimension.key}' is '${String(value)}'`;
  }
  if (value === null) return `${dimension.key} is absent`;
  return `${dimension.key} is ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function holdsReferences(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isRefSentinel(value)) return true;
  if (isTaggedSentinel(value)) return /\b(resources|steps)\s*\./.test(value.source);
  if (isCompiledValue(value)) return typeof value.source === "string" && /\b(resources|steps)\s*\./.test(value.source);
  if (Array.isArray(value)) return value.some(holdsReferences);
  return Object.values(value).some(holdsReferences);
}

function celSourceOf(value: unknown): string | undefined {
  if (isTaggedSentinel(value)) return value.engine === CEL_ENGINE ? value.source : undefined;
  if (isCompiledValue(value)) return typeof value.source === "string" ? value.source : undefined;
  return undefined;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a literal list";
  if (typeof value === "object") return "a literal map";
  return `the literal ${JSON.stringify(value)}`;
}

function valueAt(root: unknown, keys: readonly (string | number)[]): unknown {
  let at: unknown = root;
  for (const key of keys) at = (at as Record<string | number, unknown> | undefined)?.[key];
  return at;
}

function branchKeysOf(branch: string): (string | number)[] {
  return branch.startsWith("case:") ? ["cases", branch.slice("case:".length)] : [branch];
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
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

/** An integral JSON number as the int CEL reads it. */
function asCel(value: unknown): unknown {
  return typeof value === "number" && Number.isInteger(value) ? BigInt(value) : value;
}

export type { LoopInstance };

/** One finding of a definition's variant runs: what it is, and where it arose. */
export interface DefinitionFinding {
  readonly diagnostic: AnalysisDiagnostic;
  /** The module configuration it arose in, by key. */
  readonly configuration: string;
  readonly assignment: TemplateAssignment;
  readonly dimensions: readonly TemplateDimension[];
  /** Found under a branch no assignment takes. */
  readonly forced: boolean;
}

/**
 * The findings of every variant of the definitions, one per defect: labelled by
 * the definition assignments it arose in — `(when self.mode is a)`,
 * `(when 'self.adminPort == self.port' is false)` — in the message only, and
 * carrying `data.configurations` for the input dimensions alone (a library's
 * own `variables.*` / `secrets.*`), the key space every other diagnostic of the
 * module uses. Each comes back with the module configurations it arose in.
 */
export function labelDefinitionFindings(
  findings: readonly DefinitionFinding[],
): { diagnostic: AnalysisDiagnostic; configurations: ReadonlySet<string> }[] {
  const groups = new Map<
    string,
    { diagnostic: AnalysisDiagnostic; configurations: Set<string>; assignments: Map<string, TemplateAssignment>; dimensions: readonly TemplateDimension[]; forced: boolean }
  >();
  for (const finding of findings) {
    const data = finding.diagnostic.data as { resource?: { kind?: unknown; name?: unknown }; filePath?: unknown; path?: unknown } | undefined;
    const identity = JSON.stringify([
      finding.diagnostic.code,
      data?.resource?.kind,
      data?.resource?.name,
      data?.filePath,
      data?.path,
      finding.diagnostic.message,
    ]);
    const group = groups.get(identity) ?? {
      diagnostic: finding.diagnostic,
      configurations: new Set<string>(),
      assignments: new Map<string, TemplateAssignment>(),
      dimensions: finding.dimensions,
      forced: true,
    };
    groups.set(identity, group);
    group.configurations.add(finding.configuration);
    if (!finding.forced) {
      group.forced = false;
      const projected = Object.fromEntries(group.dimensions.map((d) => [d.key, finding.assignment[d.key]]));
      group.assignments.set(templateAssignmentKey(projected), projected);
    }
  }
  const out: { diagnostic: AnalysisDiagnostic; configurations: ReadonlySet<string> }[] = [];
  for (const group of groups.values()) {
    if (group.forced) {
      out.push({
        diagnostic: { ...group.diagnostic, message: `${group.diagnostic.message} (in a branch no value the definition can be given takes)` },
        configurations: group.configurations,
      });
      continue;
    }
    const all = product(group.dimensions);
    const subset = [...group.assignments.values()];
    if (subset.length >= all.length) {
      out.push({ diagnostic: group.diagnostic, configurations: group.configurations });
      continue;
    }
    const label = describeTemplateAssignments(subset, all, group.dimensions);
    const inputs = group.dimensions.filter((d) => d.kind === "input");
    const projected = new Map<string, Record<string, unknown>>();
    for (const assignment of subset) {
      const p = Object.fromEntries(inputs.map((d) => [d.key, assignment[d.key] === undefined ? null : assignment[d.key]]));
      projected.set(templateAssignmentKey(p), p);
    }
    const inputsVary = inputs.length > 0 && projected.size < product(inputs).length;
    out.push({
      diagnostic: {
        ...group.diagnostic,
        message: label ? `${group.diagnostic.message} ${label}` : group.diagnostic.message,
        ...(inputsVary
          ? {
              data: {
                ...((group.diagnostic.data as Record<string, unknown> | undefined) ?? {}),
                configurations: inputEntries(inputs, product(inputs), [...projected.values()]),
              },
            }
          : {}),
      },
      configurations: group.configurations,
    });
  }
  return out;
}

/** The input assignments `held` as partial entries: the cover of `held` among
 *  `all` (and `held` itself), over the inputs' own domains plus the absence
 *  `null` a projection may hold. */
function inputEntries(
  inputs: readonly TemplateDimension[],
  all: readonly TemplateAssignment[],
  held: readonly TemplateAssignment[],
): TemplateAssignment[] {
  const space = new ConditionSpace(
    inputs.map((d) => ({
      key: d.key,
      values: held.some((a) => a[d.key] === null) && !d.values.includes(null) ? [...d.values, null] : d.values,
    })),
  );
  return entriesOfBlocks(
    space.cover(
      space.some(held.map((a) => space.assignment(a))),
      space.some([...all, ...held].map((a) => space.assignment(a))),
    ),
  );
}

function templateAssignmentKey(assignment: TemplateAssignment): string {
  return JSON.stringify(Object.keys(assignment).sort().map((key) => [key, assignment[key]]));
}

/** The smallest description of `subset` among `all`, over definition
 *  dimensions: a dimension every value of which the subset holds is left out. */
export function describeTemplateAssignments(
  subset: readonly TemplateAssignment[],
  all: readonly TemplateAssignment[],
  dimensions: readonly TemplateDimension[],
): string {
  const space = new ConditionSpace(dimensions);
  const blocks = space.cover(
    space.some(subset.map((a) => space.assignment(a))),
    space.some(all.map((a) => space.assignment(a))),
  );
  const clauses: string[] = [];
  for (const block of blocks) {
    const parts: string[] = [];
    for (const dimension of dimensions) {
      const values = block.get(dimension.key);
      if (!values) continue;
      parts.push(
        values.length === 1
          ? describeDimensionValue(dimension, values[0])
          : values.map((v) => describeDimensionValue(dimension, v)).join(" or "),
      );
    }
    if (parts.length > 0) clauses.push(parts.join(" and "));
  }
  return clauses.length === 0 ? "" : `(when ${clauses.join("; or when ")})`;
}

/**
 * A splice's representative entry, held to every value schema a key of its
 * mapping could receive — each `properties` entry, each `patternProperties`
 * entry, and `additionalProperties` unless it is `false` — and refused only when
 * it fits none: which key a consumer's element emits, and so the exact schema,
 * is the consumer's to decide. What the mapping's own schema says about the
 * representative key is dropped by the caller (`REPRESENTATIVE_KEY`).
 */
export function representativeSpliceIssues(
  expansion: TemplateBodyExpansion,
  registry: DefinitionRegistry,
  resolveKind: (kind: string) => string | undefined,
): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const body = expansion.definition as Record<string, any>;
  for (const spliced of expansion.splicedKeys) {
    if (spliced.key !== REPRESENTATIVE_KEY) continue;
    const [field, index, ...within] = spliced.container;
    if (field !== "resources" || typeof index !== "number") continue;
    const entry = body.resources?.[index];
    if (!entry || typeof entry.kind !== "string") continue;
    const definition = registry.resolve(resolveKind(entry.kind) ?? entry.kind) ?? registry.resolve(entry.kind);
    const schema = definition ? (registry.effectiveSchemaOf(definition) as Record<string, any> | undefined) : undefined;
    if (!schema) continue;
    let node: Record<string, any> | undefined = schema;
    for (const key of within) {
      node = node ? resolveLocalRef(node, schema) : undefined;
      if (!node) break;
      if (typeof key === "number") node = node.items && typeof node.items === "object" ? node.items : undefined;
      else {
        const property = gatherPropertySchemas(node, schema).find(([name]) => name === key)?.[1];
        node = property ?? (node.additionalProperties && typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
      }
    }
    node = node ? resolveLocalRef(node, schema) : undefined;
    if (!node) continue;
    const branches = [
      ...gatherPropertySchemas(node, schema).map(([, s]) => s),
      ...Object.values((node.patternProperties ?? {}) as Record<string, Record<string, any>>),
      ...(node.additionalProperties === false || node.additionalProperties === undefined
        ? node.type === "object" || node.properties || node.patternProperties
          ? []
          : [{}]
        : [node.additionalProperties === true ? {} : node.additionalProperties]),
    ];
    const at = pathText([...spliced.container, REPRESENTATIVE_KEY]);
    let value: unknown = body;
    for (const key of [...spliced.container, REPRESENTATIVE_KEY]) value = (value as Record<string | number, unknown> | undefined)?.[key];
    if (branches.length === 0) {
      out.push({ path: at, message: `the mapping a '...' splice emits into takes no entry beside the ones written` });
      continue;
    }
    const union = { $defs: schema.$defs, anyOf: branches };
    const standIns: StandIns = new Map();
    const issues = registry.validateResourceConfig(
      substituteDecodedCelFields(value, union, schema, { standIns, external: (ref) => registry.schemaForId(ref) }),
      union,
      standIns,
    );
    if (issues.length === 0) continue;
    out.push({
      path: at,
      message:
        `the value a '...' splice emits fits no value the mapping takes at any key — ` +
        `${issues.map((issue) => issue.message).join("; ")}`,
    });
  }
  return out;
}

/** True when a mapping's splice emits an entry keyed by the literal `name`. */
function emitsBindingKey(mapping: Record<string, unknown>, name: string): boolean {
  const spliced = mapping["..."];
  const repeats = Array.isArray(spliced) ? spliced : spliced === undefined ? [] : [spliced];
  return repeats.some((repeat) => (repeat as { key?: unknown } | undefined)?.key === name);
}

/** True when `value` is, or holds at any depth, an expansion construct. */
function holdsExpansionSentinel(value: unknown): boolean {
  if (isExpansionSentinel(value)) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(holdsExpansionSentinel);
}
