/**
 * The strict half of the `x-telo-resource-rules` accessor split
 * (`validate-ref-slots.ts` / `validate-zone-slots.ts` precedent), plus the
 * evaluation pass that runs the rules against each resource.
 *
 * Both halves live here because they fail in opposite directions and must agree
 * about what a rule MEANS: a declaration the reader cannot parse is silently
 * unenforced — the check reads as passing when it never ran — while a rule that
 * throws would otherwise be reported against the consumer's manifest, blaming an
 * author for a defect in someone else's kind.
 *
 * Scoping follows `X_TELO_REF_UNRESOLVED`, and it splits by WHOSE defect it is.
 * A declaration defect belongs to the kind, so it is reported only for
 * definitions in the entry's own modules. A VIOLATION belongs to the data, so it
 * is reported wherever the offending resource is the entry's — the opposite
 * direction, for the same reason. A rule that THROWS or runs out of budget is a
 * defect in the rule found while checking someone else's data: the caller
 * anchors it on the declaring definition when that is ours, and downgrades it to
 * a warning when it is a published dependency's, so it is never an error on a
 * line the author cannot change.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { MODULE_CALL_DISPATCH_KEY, type ModuleCallDispatch } from "@telorun/templating";
import type { CallableFlags } from "./callable-flags.js";
import {
  RULE_BUDGET_MS,
  UNTAGGED_CONDITION,
  compileRuleCondition,
  conditionCallRefusals,
  conditionRefusals,
  untaggedConditionFix,
} from "./rule-condition.js";
import {
  bindingFailureReason,
  isSilentBindingFailure,
  type PeerBinder,
  type PeerBindingFailure,
} from "./peer-binding.js";
import type { DiagnosticFix } from "./types.js";
import { readRefSlot } from "./ref-slot.js";
import {
  RESOURCE_RULES_ANNOTATION,
  celSourceOf,
  findDynamicRead,
  type DynamicLeaf,
  isTaggedCondition,
  parseRulePointer,
  pointerSegments,
  readRawResourceRules,
  readResourceRules,
  resolveRuleSubjects,
  type ResourceRule,
  type RulePointerStep,
} from "./resource-rule.js";
import { resolveSchemaPointer } from "./manifest-navigation.js";

/** Published name for the shared budget — see `rule-condition.ts`. */
export const RESOURCE_RULE_BUDGET_MS = RULE_BUDGET_MS;

export interface ResourceRuleIssue {
  code: "RESOURCE_RULE_INVALID";
  manifest: ResourceManifest;
  path: string;
  message: string;
  fix?: DiagnosticFix;
}

/** One rule's verdict on one resource. */
export type ResourceRuleFinding =
  | {
      kind: "violation";
      rule: ResourceRule;
      /** Path of the offending element, or "" for a rule with no `in:`. */
      path: string;
      message: string;
    }
  | { kind: "skipped"; rule: ResourceRule; path: string; dynamic: DynamicLeaf }
  | { kind: "unbound"; rule: ResourceRule; failure: PeerBindingFailure }
  | { kind: "failed"; rule: ResourceRule; path: string; reason: string }
  | { kind: "over-budget"; rule: ResourceRule; path: string; elapsedMs: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Navigate a kind's own schema to the node describing what a pointer names, so
 *  an `in:` naming a field the kind does not declare is caught at the kind.
 *  Exported because the peer-rule strict half asks the same question of the
 *  REFERRER's schema, and two navigators would eventually disagree about what a
 *  pointer names. */
export function schemaAtPointer(schema: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (!segments) return undefined;
  let node: unknown = schema;
  for (const segment of segments) {
    if (!isObject(node)) return undefined;
    const properties = isObject(node.properties) ? node.properties : undefined;
    const next =
      properties?.[segment] ??
      (node.type === "array" ? node.items : undefined) ??
      (isObject(node.additionalProperties) ? node.additionalProperties : undefined);
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

/** The named shape a non-local `$ref` names, with the module that declares it;
 *  `module` is the module of the document the reference is written in. */
export type RuleShapeLookup = (
  ref: string,
  module: string | undefined,
) => { schema: Record<string, any>; module: string | undefined } | undefined;

/** A schema node, with the document its local references resolve in and the
 *  module that wrote it. */
interface SchemaPlace {
  readonly node: Record<string, any>;
  readonly root: Record<string, any>;
  readonly module: string | undefined;
}

/** The deepest a repeated group is followed through a schema. */
const MAX_SCHEMA_REPEAT = 16;

/**
 * The schema nodes an `in:` pointer names in a kind's schema — following local
 * references and, through `shapes`, named ones, and looking into union
 * branches — or why it names none. A repeated group must reach something from
 * where it is written, or it is a typo that silently iterates nothing.
 */
export function ruleCollectionSchemas(
  schema: unknown,
  pointer: string,
  module: string | undefined,
  shapes?: RuleShapeLookup,
): { nodes: Record<string, any>[] } | { problem: string } {
  const steps = parseRulePointer(pointer);
  if (!steps) {
    return { problem: `'in' must be a JSON Pointer starting with '/', optionally with '*' and repeated groups '(…)*', got '${pointer}'.` };
  }
  if (!isObject(schema)) return { nodes: [] };

  const resolved = (place: SchemaPlace): SchemaPlace[] => {
    const out: SchemaPlace[] = [];
    const seen = new Set<object>();
    const visit = (current: SchemaPlace): void => {
      if (seen.has(current.node)) return;
      seen.add(current.node);
      const ref = current.node.$ref;
      if (typeof ref === "string") {
        if (ref.startsWith("#")) {
          const target = resolveSchemaPointer(current.root, ref);
          if (isObject(target)) visit({ ...current, node: target });
        } else {
          const shape = shapes?.(ref, current.module);
          if (shape) visit({ node: shape.schema, root: shape.schema, module: shape.module });
        }
      }
      out.push(current);
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        const branches = current.node[key];
        if (Array.isArray(branches)) for (const branch of branches) if (isObject(branch)) visit({ ...current, node: branch });
      }
    };
    visit(place);
    return out;
  };

  const along = (from: readonly SchemaPlace[], path: readonly RulePointerStep[]): SchemaPlace[] | string => {
    let places = [...from];
    for (const step of path) {
      const next: SchemaPlace[] = [];
      for (const place of places) {
        if (step.kind === "repeat") {
          next.push(place);
          let frontier: SchemaPlace[] = [place];
          const reached = new Set<object>([place.node]);
          for (let depth = 0; frontier.length > 0 && depth < MAX_SCHEMA_REPEAT; depth++) {
            const found: SchemaPlace[] = [];
            for (const alternative of step.alternatives) {
              const each = along(frontier, alternative);
              if (typeof each === "string") return each;
              if (depth === 0 && each.length === 0) {
                return `'in' repeats a group that names nothing this kind's schema declares at '${pointer}'.`;
              }
              found.push(...each);
            }
            frontier = found.filter((candidate) => !reached.has(candidate.node));
            for (const candidate of frontier) reached.add(candidate.node);
            next.push(...frontier);
          }
          continue;
        }
        for (const node of resolved(place)) {
          const children: unknown[] =
            step.kind === "any"
              ? [node.node.items, node.node.additionalProperties, ...Object.values((node.node.patternProperties ?? {}) as object)]
              : [
                  isObject(node.node.properties) ? node.node.properties[step.key] : undefined,
                  node.node.type === "array" ? node.node.items : undefined,
                  node.node.additionalProperties,
                ];
          const child = children.find(isObject);
          if (child) next.push({ ...node, node: child });
        }
      }
      places = next;
    }
    return places;
  };

  const reached = along([{ node: schema, root: schema, module }], steps);
  if (typeof reached === "string") return { problem: reached };
  return { nodes: reached.flatMap(resolved).map((place) => place.node) };
}

/** The schemas a reference slot's kind may hold — the kind's and each of its
 *  implementations'. */
export type KindSchemas = (kind: string) => readonly Record<string, any>[];

/**
 * Whether a rule's `resolve:` pointer names something the schema declares: a
 * field at each segment (`*` for every item or value), continuing past a
 * reference slot inside every kind the slot may hold. `unknown` where a slot's
 * kinds cannot be read here.
 */
export function rulePointerReaches(
  schema: unknown,
  pointer: string,
  kindSchemas?: KindSchemas,
): "ok" | "absent" | "unknown" {
  const segments = pointerSegments(pointer);
  if (!segments) return "absent";
  const seen = new Set<unknown>();
  const walk = (node: unknown, rest: readonly string[]): "ok" | "absent" | "unknown" => {
    if (!isObject(node)) return rest.length === 0 && node !== undefined ? "ok" : "absent";
    if (rest.length === 0) return "ok";
    const slot = readRefSlot(node as Record<string, any>);
    if (slot) {
      if (!kindSchemas || slot.kinds.length === 0) return "unknown";
      const schemas = slot.kinds.flatMap((kind) => kindSchemas(kind));
      if (schemas.length === 0 || seen.has(node)) return "unknown";
      seen.add(node);
      const verdicts = schemas.map((s) => walk(s, rest));
      return verdicts.includes("ok") ? "ok" : verdicts.includes("unknown") ? "unknown" : "absent";
    }
    const [segment, ...tail] = rest;
    const properties = isObject(node.properties) ? node.properties : undefined;
    const next =
      segment === "*"
        ? (node.items ?? (isObject(node.additionalProperties) ? node.additionalProperties : undefined))
        : (properties?.[segment!] ??
          (node.type === "array" ? node.items : undefined) ??
          (isObject(node.additionalProperties) ? node.additionalProperties : undefined));
    const verdicts: Array<"ok" | "absent" | "unknown"> = [];
    if (next !== undefined) verdicts.push(walk(next, tail));
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = node[key];
      if (Array.isArray(branches)) for (const branch of branches) verdicts.push(walk(branch, rest));
    }
    return verdicts.includes("ok") ? "ok" : verdicts.includes("unknown") ? "unknown" : "absent";
  };
  return walk(schema, segments);
}

/** True when a schema node describes something a rule can iterate. Unknown or
 *  absent `type` passes: an open schema is not evidence of a defect. */
export function isIterableSchema(node: unknown): boolean {
  if (!isObject(node)) return true;
  const type = node.type;
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => t === "array" || t === "object");
}

/**
 * Report every way a kind's rule declarations are malformed. Runs on the
 * `Telo.Definition` / `Telo.Abstract` doc, so a defect lands on the line the
 * kind's author wrote rather than on a consumer's resource.
 */
export function validateResourceRuleDeclarations(
  manifest: ResourceManifest,
  /**
   * The schema an `in:` pointer is checked against — the SAME merged schema the
   * evaluation pass reads, so the two halves cannot disagree about which fields
   * a kind has. Reading the doc's own `schema:` here was correct only for a leaf
   * kind: a rule declared on a parent and evaluated against a child's field
   * would be reported invalid at the parent, and a child's rule naming an
   * INHERITED field would be told the kind does not declare it. Both arrive as
   * soon as rules are declared on an abstract, which is where a rule shared by
   * every backend belongs.
   */
  effectiveSchema?: unknown,
  /** The declaring kind's module names — a condition may call another module's
   *  function, and classifying such a call against the catalog would refuse it
   *  as a missing method. */
  moduleNames?: ReadonlySet<string>,
  /** What a `resolve:` pointer continuing past a reference slot reads in. */
  kindSchemas?: KindSchemas,
  /** The named shapes an `in:` pointer follows a `$ref` into. */
  shapes?: RuleShapeLookup,
): ResourceRuleIssue[] {
  const own = (manifest as unknown as Record<string, unknown>).schema;
  const schema = effectiveSchema ?? own;
  const raw = readRawResourceRules(own);
  if (raw === undefined) return [];

  const base = `schema.${RESOURCE_RULES_ANNOTATION}`;
  const issues: ResourceRuleIssue[] = [];
  const issue = (path: string, message: string, fix?: DiagnosticFix): void => {
    issues.push({ code: "RESOURCE_RULE_INVALID", manifest, path, message, ...(fix ? { fix } : {}) });
  };

  if (!Array.isArray(raw)) {
    issue(base, `'${RESOURCE_RULES_ANNOTATION}' must be an array of rules.`);
    return issues;
  }

  const seen = new Map<string, number>();
  raw.forEach((entry, index) => {
    const at = `${base}[${index}]`;
    if (!isObject(entry)) {
      issue(at, "A rule must be an object with 'condition', 'code' and 'message'.");
      return;
    }

    const condition = celSourceOf(entry.condition);
    if (condition === undefined || condition.length === 0) {
      issue(
        `${at}.condition`,
        "A rule needs a 'condition' — a CEL expression that is TRUE when the rule holds " +
          "(the polarity Telo.JsonSchema rules use). Write it with the !cel tag.",
      );
    }
    if (typeof entry.code !== "string" || entry.code.length === 0) {
      issue(
        `${at}.code`,
        "A rule needs a 'code' naming it. It is reported in the diagnostic's data.rule, " +
          "not as a diagnostic code — every violation reports under RESOURCE_RULE_VIOLATED.",
      );
    } else {
      const first = seen.get(entry.code);
      if (first !== undefined) {
        issue(
          `${at}.code`,
          `Rule code '${entry.code}' is already used by rule ${first}. A code names one rule, ` +
            "so two rules sharing it are indistinguishable in data.rule.",
        );
      } else {
        seen.set(entry.code, index);
      }
    }
    if (typeof entry.message !== "string" || entry.message.length === 0) {
      issue(
        `${at}.message`,
        "A rule needs a 'message' saying what the relationship means — only the kind's " +
          "author knows that, and the analyzer supplies only where and what.",
      );
    }
    if (
      entry.severity !== undefined &&
      entry.severity !== "error" &&
      entry.severity !== "warning"
    ) {
      issue(`${at}.severity`, "'severity' must be 'error' or 'warning'.");
    }

    if (entry.in !== undefined) {
      if (typeof entry.in !== "string") {
        issue(`${at}.in`, "'in' must be a JSON Pointer to the collection the rule iterates.");
      } else {
        const named = ruleCollectionSchemas(
          schema,
          entry.in,
          (manifest.metadata as { module?: string } | undefined)?.module,
          shapes,
        );
        if ("problem" in named) {
          issue(`${at}.in`, named.problem);
        } else if (named.nodes.length === 0) {
          issue(
            `${at}.in`,
            `'in' points at '${entry.in}', which this kind's schema does not declare. ` +
              "The pointer is the diagnostic's anchor, so it must name a field of this kind.",
          );
        } else if (!named.nodes.some(isIterableSchema)) {
          issue(
            `${at}.in`,
            `'in' points at '${entry.in}', which is not a collection. A rule iterates an ` +
              "array or a map; omit 'in' for a rule about the resource as a whole.",
          );
        }
      }
    }

    if (entry.resolve !== undefined) {
      if (!Array.isArray(entry.resolve)) {
        issue(`${at}.resolve`, "'resolve' must be a list of JSON Pointers to this kind's reference slots.");
      } else {
        entry.resolve.forEach((pointer: unknown, i: number) => {
          if (typeof pointer !== "string" || !pointerSegments(pointer)) {
            issue(`${at}.resolve[${i}]`, "Each 'resolve' entry must be a JSON Pointer starting with '/'.");
          } else if (rulePointerReaches(schema, pointer, kindSchemas) === "absent") {
            issue(
              `${at}.resolve[${i}]`,
              `'resolve' names '${pointer}', which this kind's schema does not declare. It must ` +
                "name a reference slot of this kind, or a collection of them, and may continue " +
                "inside what it names.",
            );
          }
        });
      }
    }

    if (condition !== undefined && condition.length > 0 && !isTaggedCondition(entry.condition)) {
      issue(`${at}.condition`, UNTAGGED_CONDITION, untaggedConditionFix(condition));
    }

    if (condition) {
      for (const refusal of conditionRefusals(condition, moduleNames)) {
        issue(`${at}.condition`, refusal);
      }
    }
  });

  return issues;
}

/**
 * Every refusal a kind's rule conditions earn through the module calls they make
 * — asked once the analysis knows every function, since whether a call may run
 * in a rule is derived from the function it reaches (`conditionCallRefusals`).
 */
export function resourceRuleCallIssues(
  manifest: ResourceManifest,
  moduleNames: ReadonlySet<string>,
  flagsOf: (qualified: string) => CallableFlags | undefined,
): ResourceRuleIssue[] {
  const raw = readRawResourceRules((manifest as unknown as Record<string, unknown>).schema);
  if (!Array.isArray(raw)) return [];
  const issues: ResourceRuleIssue[] = [];
  raw.forEach((entry, index) => {
    const condition = isObject(entry) ? celSourceOf(entry.condition) : undefined;
    if (!condition) return;
    for (const message of conditionCallRefusals(condition, moduleNames, flagsOf)) {
      issues.push({
        code: "RESOURCE_RULE_INVALID",
        manifest,
        path: `schema.${RESOURCE_RULES_ANNOTATION}[${index}].condition`,
        message,
      });
    }
  });
  return issues;
}

/**
 * Run a kind's rules against one resource.
 *
 * `self` binds the resource, `this` the element under test — the two coexist in
 * cel-js, which is what lets a rule correlate an element against the whole
 * (`c in self.columns`) with no path language.
 */
export function evaluateResourceRules(
  manifest: ResourceManifest,
  definitionSchema: unknown,
  /** The DECLARING kind's module names, not the subject resource's: the
   *  condition is the kind author's expression. */
  moduleNames?: ReadonlySet<string>,
  /** The functions the condition may call, evaluated by the analyzer
   *  (`function-body-evaluator.ts`). */
  functions?: ModuleCallDispatch,
  /** Resolves a rule's `resolve:` slots; the run's shared binder. Without one a
   *  rule declaring `resolve:` reports as unbound rather than reading references
   *  as if they were the declarations. */
  binder?: PeerBinder,
  /** The resource's kind, as the binder's reference-reach lookup spells it. */
  kind: string = manifest.kind,
): ResourceRuleFinding[] {
  const rules = readResourceRules(definitionSchema);
  if (rules.length === 0) return [];

  const findings: ResourceRuleFinding[] = [];

  for (const rule of rules) {
    const bound = resolvedRuleView(manifest, rule.resolve, binder, kind);
    if (!bound.ok) {
      findings.push({ kind: "unbound", rule, failure: bound.failure });
      continue;
    }
    const self = bound.self;
    const subjects =
      rule.in === undefined ? [{ path: "", value: self }] : resolveRuleSubjects(self, rule.in);
    // `undefined` means the pointer resolved to a scalar — a declaration defect
    // the strict half reports at the kind. Evaluating anyway would report it
    // against the consumer instead.
    if (subjects === undefined) continue;

    const compiled = compileRuleCondition(rule.condition, moduleNames);
    if ("reason" in compiled) {
      findings.push({ kind: "failed", rule, path: "", reason: compiled.reason });
      continue;
    }
    const { parsed, chains } = compiled;

    // The budget stops the loop, so it is asked before a subject is evaluated:
    // one slow evaluation with nothing left to judge has skipped nothing.
    const started = Date.now();
    for (const subject of subjects) {
      const elapsed = Date.now() - started;
      if (elapsed > RESOURCE_RULE_BUDGET_MS) {
        findings.push({ kind: "over-budget", rule, path: subject.path, elapsedMs: elapsed });
        break;
      }
      // The collection itself is known only once the resource is created.
      if (subject.dynamic) {
        findings.push({ kind: "skipped", rule, path: subject.path, dynamic: subject.dynamic });
        continue;
      }
      // Only the nodes this condition READS decide whether it can run — see
      // `readNodes`. Scanning the whole subject would disable every
      // resource-wide rule on any manifest containing one unrelated expression.
      const dynamic = findDynamicRead(chains, { self, this: subject.value });
      if (dynamic !== undefined) {
        findings.push({ kind: "skipped", rule, path: subject.path, dynamic });
        continue;
      }
      let held: unknown;
      try {
        held = parsed({
          self,
          this: subject.value,
          key: subject.key ?? null,
          ...(functions ? { [MODULE_CALL_DISPATCH_KEY]: functions } : {}),
        });
      } catch (err) {
        findings.push({
          kind: "failed",
          rule,
          path: subject.path,
          reason: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (held !== true) {
        findings.push({ kind: "violation", rule, path: subject.path, message: rule.message });
      }
    }
  }

  return findings;
}

/**
 * `self` as a rule reads it: the manifest, with each `resolve:` slot replaced by
 * the declarations it references. A copy along the replaced paths only.
 *
 * **A pointer that resolves to nothing contributes nothing.** The field stays
 * ABSENT in the rewritten subject rather than appearing as a key holding
 * nothing, which is the line the `in:` subject walk and the peers binder already
 * draw ("an absent collection is an empty one"). Writing the key regardless made
 * `self.?relationships` on a store declaring none answer PRESENT, so
 * `.orValue([])` yielded nothing and every comprehension over it got a
 * non-collection range — a rule correctly guarding an optional collection
 * reported as defective. After this all three subject views agree: absent means
 * absent, never a present key holding nothing.
 */
export function resolvedRuleView(
  manifest: ResourceManifest,
  resolve: readonly string[] | undefined,
  binder: PeerBinder | undefined,
  kind: string,
): { ok: true; self: Record<string, unknown> } | { ok: false; failure: PeerBindingFailure } {
  let self = (binder?.view(manifest) ?? manifest) as unknown as Record<string, unknown>;
  for (const pointer of resolve ?? []) {
    if (!binder) return { ok: false, failure: { reason: "unknown-shape", at: pointer } };
    // A pointer may continue past a reference into what it names, a hop at a
    // time, and range over a collection with `*`.
    const resolved = binder.resolveAlong(manifest, kind, self, pointer);
    if (!resolved.ok) return resolved;
    self = resolved.view;
  }
  return { ok: true, self };
}

/** Whether a rule found anything to iterate on this resource — the input to the
 *  never-exercised report, which is the second way coverage varies invisibly. */
export function ruleExercised(manifest: ResourceManifest, rule: ResourceRule): boolean {
  if (rule.in === undefined) return true;
  const subjects = resolveRuleSubjects(manifest as unknown as Record<string, unknown>, rule.in);
  return subjects !== undefined && subjects.length > 0;
}

/** Where a rule finding is reported, and how loudly. Plain data, so the caller
 *  pushes it exactly as it does for `zoneSlotIssues` / `refSlotIssues` rather
 *  than composing severity, ownership and prose inline in the resource loop. */
export interface ResourceRuleDiagnostic {
  code:
    | "RESOURCE_RULE_VIOLATED"
    | "RESOURCE_RULE_SKIPPED"
    | "RESOURCE_RULE_INVALID"
    | "RESOURCE_RULE_UNEXERCISED";
  severity: "error" | "warning" | "information";
  message: string;
  /** The resource the finding is reported ON — the offending one for a
   *  violation, the DECLARING definition for a defect in the rule itself. */
  manifest: ResourceManifest;
  path?: string;
  rule: string;
  /**
   * An EVALUATION-TIME failure of the rule itself — it threw, or it ran out of
   * budget. Reported ONCE per `(declaring kind, rule code)` per analysis
   * (`RuleFailureLedger`) and anchored where the reader can act: the `imports:`
   * entry that brought the kind in, or this rule's own declaration when the kind
   * is one of the entry's own modules.
   *
   * The flag is here rather than the anchoring itself because only the caller
   * holds the import graph, and only it can tell whether a second resource of
   * the same kind has already failed the same rule.
   */
  evaluationFailure?: true;
}

/**
 * Map one resource's findings to what should be reported.
 *
 * The split by whose defect it is lives here, with the finding vocabulary,
 * rather than in the analyzer's resource loop: a violation belongs to the DATA
 * and is reported on the resource, while a rule that throws or exhausts its
 * budget is a defect in the RULE and belongs on the definition that declared it
 * — downgraded to a warning when that definition is a published dependency's,
 * since an error there blocks `telo check` on a line the consumer cannot change.
 */
export function reportResourceRules(
  manifest: ResourceManifest,
  definition: ResourceManifest | undefined,
  findings: readonly ResourceRuleFinding[],
  /** Whether the DECLARING definition is one of the entry's own modules. */
  declarationIsOurs: boolean,
): ResourceRuleDiagnostic[] {
  const name = (manifest.metadata?.name as string | undefined) ?? "<unnamed>";
  const out: ResourceRuleDiagnostic[] = [];

  for (const finding of findings) {
    const at = "path" in finding && finding.path !== "" ? finding.path : undefined;
    if (finding.kind === "violation") {
      out.push({
        // One analyzer-owned envelope: surfaces branch on `code`, so a published
        // module free to emit any string could shadow machinery that never
        // expected a third party in that space. The rule's own name rides in
        // `data.rule`.
        code: "RESOURCE_RULE_VIOLATED",
        severity: finding.rule.severity,
        message: `${manifest.kind}/${name}${at ? ` at '${at}'` : ""}: ${finding.message}`,
        manifest,
        path: at,
        rule: finding.rule.code,
      });
      continue;
    }
    if (finding.kind === "unbound") {
      // A reference the slot REFUSES is already reported at that slot
      // (`REFERENCE_KIND_MISMATCH`), and the rule never saw its subject at all —
      // coverage did not vary invisibly, so there is nothing to report. A second
      // diagnostic about the rule's internals would blame the kind's author for
      // the manifest author's mistake.
      if (isSilentBindingFailure(finding.failure)) continue;
      out.push({
        code: "RESOURCE_RULE_SKIPPED",
        severity: "information",
        message:
          `${manifest.kind}/${name}: rule '${finding.rule.code}' did not run — ` +
          `${bindingFailureReason(finding.failure)} Reported rather than dropped: a check whose ` +
          "coverage varies invisibly reads as passing.",
        manifest,
        path: finding.failure.at,
        rule: finding.rule.code,
      });
      continue;
    }
    if (finding.kind === "skipped") {
      out.push({
        code: "RESOURCE_RULE_SKIPPED",
        severity: "information",
        message:
          `${manifest.kind}/${name}: rule '${finding.rule.code}' did not run` +
          `${at ? ` at '${at}'` : ""} — the value holds ${finding.dynamic.what} at ` +
          `'${finding.dynamic.path}', which is not known until the resource is created. ` +
          "Reported rather than dropped: a check whose coverage varies invisibly reads as passing.",
        manifest,
        path: at,
        rule: finding.rule.code,
      });
      continue;
    }

    const because =
      finding.kind === "failed"
        ? `failed to evaluate: ${finding.reason}. Guard an optional field with \`in\` or \`.?\`.`
        : `exceeded its evaluation budget (${finding.elapsedMs}ms) and was stopped, so ` +
          "coverage from here on is incomplete. Simplify the condition.";
    out.push({
      code: "RESOURCE_RULE_INVALID",
      // Once for the whole analysis, not per site: see `evaluationFailure`. An
      // ERROR when this workspace declares the rule — the author can fix it —
      // and a warning for a dependency's, where an error would block
      // `telo check` on a line the consumer cannot change.
      severity: declarationIsOurs ? "error" : "warning",
      message:
        `Rule '${finding.rule.code}' on kind '${manifest.kind}' ${because} ` +
        `This is a defect in the rule, not in the manifest it ran against (first seen at ` +
        `${manifest.kind}/${name}${at ? ` at '${at}'` : ""})` +
        (declarationIsOurs ? "." : " — it is declared by a module this workspace does not own.") +
        " Reported once for this rule, however many resources it fails on.",
      manifest: definition ?? manifest,
      path: definition
        ? `schema.${RESOURCE_RULES_ANNOTATION}[${finding.rule.index}]`
        : at,
      rule: finding.rule.code,
      evaluationFailure: true,
    });
  }

  return out;
}

/** The report for a rule nothing ever exercised — the second way coverage varies
 *  invisibly, beside the dynamic-leaf skip. */
export function reportUnexercisedRule(
  definition: ResourceManifest,
  rule: ResourceRule,
): ResourceRuleDiagnostic {
  return {
    code: "RESOURCE_RULE_UNEXERCISED",
    severity: "information",
    message:
      `Rule '${rule.code}' never ran: '${rule.in}' was empty on every resource of this kind, ` +
      "so nothing has proven the condition. A nested typo in the condition is caught only at " +
      "evaluation.",
    manifest: definition,
    path: `schema.${RESOURCE_RULES_ANNOTATION}[${rule.index}]`,
    rule: rule.code,
  };
}
