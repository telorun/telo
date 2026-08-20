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
import {
  CEL_FUNCTIONS,
  buildCelEnvironment,
  celEngine,
  extractAccessChains,
} from "@telorun/templating";
import {
  RESOURCE_RULES_ANNOTATION,
  celSourceOf,
  findDynamicLeaf,
  pointerSegments,
  readRawResourceRules,
  readResourceRules,
  readNodes,
  resolveRuleSubjects,
  type ResourceRule,
} from "./resource-rule.js";

export interface ResourceRuleIssue {
  code: "RESOURCE_RULE_INVALID";
  manifest: ResourceManifest;
  path: string;
  message: string;
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
  | { kind: "skipped"; rule: ResourceRule; path: string; dynamicAt: string }
  | { kind: "failed"; rule: ResourceRule; path: string; reason: string }
  | { kind: "over-budget"; rule: ResourceRule; path: string; elapsedMs: number };

/**
 * Wall-clock ceiling for one rule over one resource. The rules run on the
 * kernel's boot path and at the editor's keystroke-time analysis, and the
 * comprehension nesting is the RULE AUTHOR's — a dependency's quadratic rule
 * must not be able to hang a consumer's `telo check`.
 *
 * It bounds the SUBJECT LOOP, not one expression: cel-js offers no step limit,
 * so a single pathological expression over one huge element still runs to
 * completion. Stated rather than hidden — the budget catches the shape that
 * actually occurs (a cheap expression over many elements) and reports the rule
 * as defective rather than truncating coverage silently.
 */
export const RESOURCE_RULE_BUDGET_MS = 50;

const HOST_BACKED = new Set(CEL_FUNCTIONS.filter((f) => f.hostBacked).map((f) => f.name));
const NON_DETERMINISTIC = new Set(
  CEL_FUNCTIONS.filter((f) => !f.deterministic).map((f) => f.name),
);

let sharedEnv: ReturnType<typeof buildCelEnvironment> | undefined;
/** The analyzer's own environment — no host handlers, so every `hostBacked`
 *  entry is a throwing stub. Built once; it is stateless. */
function ruleEnv(): ReturnType<typeof buildCelEnvironment> {
  sharedEnv ??= buildCelEnvironment();
  return sharedEnv;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type CompiledRule =
  | { parsed: (ctx: Record<string, unknown>) => unknown; chains: readonly (readonly string[])[] }
  | { reason: string };

/**
 * A rule's condition, parsed once per process rather than once per resource.
 *
 * The pass runs over every resource of a kind and at the editor's
 * keystroke-time analysis, so a workspace with fifty tables parsed the same
 * six conditions fifty times each. The source string is the whole key: the
 * environment is stateless and shared, so two identical conditions genuinely
 * compile to the same program. A parse FAILURE is cached too — it is a property
 * of the condition, and re-deriving it per resource costs the same as the
 * success it replaced.
 *
 * BOUNDED, because the editor analyses on every keystroke: a kind author editing
 * a `condition:` interns one entry per character typed, and every one of those
 * intermediate strings is dead the moment the next arrives. Insertion-ordered
 * eviction is enough — the working set is the conditions a workspace actually
 * declares, and a stale entry costs one re-parse.
 */
const RULE_CACHE_LIMIT = 512;
const compiledRules = new Map<string, CompiledRule>();

function compileRule(
  env: ReturnType<typeof buildCelEnvironment>,
  condition: string,
): CompiledRule {
  const cached = compiledRules.get(condition);
  if (cached) return cached;
  let result: CompiledRule;
  try {
    const parsed = env.parse(condition) as (ctx: Record<string, unknown>) => unknown;
    const ast = (parsed as unknown as { ast?: unknown }).ast;
    // No AST is not "reads nothing" — it is "unknown", and treating it as the
    // former would evaluate a placeholder silently. Fall back to the whole
    // subject, the conservative reading.
    result = {
      parsed,
      chains: ast ? extractAccessChains(ast as never) : [["self"], ["this"]],
    };
  } catch (err) {
    result = { reason: err instanceof Error ? err.message : String(err) };
  }
  if (compiledRules.size >= RULE_CACHE_LIMIT) {
    const oldest = compiledRules.keys().next();
    if (!oldest.done) compiledRules.delete(oldest.value);
  }
  compiledRules.set(condition, result);
  return result;
}

/** Navigate a kind's own schema to the node describing what a pointer names, so
 *  an `in:` naming a field the kind does not declare is caught at the kind. */
function schemaAtPointer(schema: unknown, pointer: string): unknown {
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

/** True when a schema node describes something a rule can iterate. Unknown or
 *  absent `type` passes: an open schema is not evidence of a defect. */
function isIterableSchema(node: unknown): boolean {
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
): ResourceRuleIssue[] {
  const own = (manifest as unknown as Record<string, unknown>).schema;
  const schema = effectiveSchema ?? own;
  const raw = readRawResourceRules(own);
  if (raw === undefined) return [];

  const base = `schema.${RESOURCE_RULES_ANNOTATION}`;
  const issues: ResourceRuleIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ code: "RESOURCE_RULE_INVALID", manifest, path, message });
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
      } else if (!pointerSegments(entry.in)) {
        issue(`${at}.in`, `'in' must be a JSON Pointer starting with '/', got '${entry.in}'.`);
      } else {
        const node = schemaAtPointer(schema, entry.in);
        if (node === undefined) {
          issue(
            `${at}.in`,
            `'in' points at '${entry.in}', which this kind's schema does not declare. ` +
              "The pointer is the diagnostic's anchor, so it must name a field of this kind.",
          );
        } else if (!isIterableSchema(node)) {
          issue(
            `${at}.in`,
            `'in' points at '${entry.in}', which is not a collection. A rule iterates an ` +
              "array or a map; omit 'in' for a rule about the resource as a whole.",
          );
        }
      }
    }

    if (condition) {
      const result = celEngine.analyze(condition, { celEnv: ruleEnv(), contextSchema: null });
      for (const diagnostic of result.diagnostics) {
        issue(`${at}.condition`, `Rule condition: ${diagnostic.message}`);
      }
      for (const call of result.calls) {
        if (HOST_BACKED.has(call.name)) {
          issue(
            `${at}.condition`,
            `Rule condition calls '${call.name}()', which the kernel supplies at boot ` +
              "(it needs Node crypto / Buffer). The analyzer registers a throwing stub, so " +
              "the rule cannot run at telo check.",
          );
        } else if (NON_DETERMINISTIC.has(call.name) || call.deterministic === false) {
          issue(
            `${at}.condition`,
            `Rule condition calls '${call.name}()', which re-evaluates per call. A check ` +
              "whose verdict depends on when it ran is not a check.",
          );
        }
      }
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
): ResourceRuleFinding[] {
  const rules = readResourceRules(definitionSchema);
  if (rules.length === 0) return [];

  const env = ruleEnv();
  const self = manifest as unknown as Record<string, unknown>;
  const findings: ResourceRuleFinding[] = [];

  for (const rule of rules) {
    const subjects =
      rule.in === undefined ? [{ path: "", value: self }] : resolveRuleSubjects(self, rule.in);
    // `undefined` means the pointer resolved to a scalar — a declaration defect
    // the strict half reports at the kind. Evaluating anyway would report it
    // against the consumer instead.
    if (subjects === undefined) continue;

    const compiled = compileRule(env, rule.condition);
    if ("reason" in compiled) {
      findings.push({ kind: "failed", rule, path: "", reason: compiled.reason });
      continue;
    }
    const { parsed, chains } = compiled;

    const started = Date.now();
    for (const subject of subjects) {
      // Only the nodes this condition READS decide whether it can run — see
      // `readNodes`. Scanning the whole subject would disable every
      // resource-wide rule on any manifest containing one unrelated expression.
      let dynamicAt: string | undefined;
      for (const node of readNodes(chains, self, subject.value)) {
        dynamicAt = findDynamicLeaf(node);
        if (dynamicAt !== undefined) break;
      }
      if (dynamicAt !== undefined) {
        findings.push({ kind: "skipped", rule, path: subject.path, dynamicAt });
        continue;
      }
      let held: unknown;
      try {
        held = parsed({ self, this: subject.value, key: subject.key ?? null });
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
      const elapsed = Date.now() - started;
      if (elapsed > RESOURCE_RULE_BUDGET_MS) {
        findings.push({ kind: "over-budget", rule, path: subject.path, elapsedMs: elapsed });
        break;
      }
    }
  }

  return findings;
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
    const at = finding.path === "" ? undefined : finding.path;
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
    if (finding.kind === "skipped") {
      out.push({
        code: "RESOURCE_RULE_SKIPPED",
        severity: "information",
        message:
          `${manifest.kind}/${name}: rule '${finding.rule.code}' did not run` +
          `${at ? ` at '${at}'` : ""} — the value holds a CEL expression at ` +
          `'${finding.dynamicAt}', which is not known until the resource is created. ` +
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
      severity: declarationIsOurs ? "error" : "warning",
      message:
        `Rule '${finding.rule.code}' on kind '${manifest.kind}' ${because} ` +
        `This is a defect in the rule, not in ${name}` +
        (declarationIsOurs ? "." : " — it is declared by a module this workspace does not own."),
      manifest: declarationIsOurs && definition ? definition : manifest,
      path:
        declarationIsOurs && definition
          ? `schema.${RESOURCE_RULES_ANNOTATION}[${finding.rule.index}]`
          : at,
      rule: finding.rule.code,
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
