/**
 * The strict half of the `x-telo-referrer-rules` accessor split
 * (`validate-resource-rules.ts` / `validate-zone-slots.ts` precedent), plus the
 * evaluation pass that runs a kind's rules against the resources referencing it.
 *
 * Both halves live here because they fail in opposite directions and must agree
 * about what a rule MEANS: a declaration the reader cannot parse is silently
 * unenforced — the check reads as passing when it never ran — while a rule that
 * throws would otherwise be reported against a consumer's manifest, blaming an
 * author for a defect in someone else's kind.
 *
 * A CONSUMER of the call graph with no traversal of its own: the referrers are
 * `edgesTo` on the resource's node, exactly as the zone projection consumes the
 * outgoing direction. What it hands back is plain findings; the caller pushes
 * them.
 *
 * Ownership splits by whose defect it is, and lands one hop further out than for
 * a resource rule. A VIOLATION belongs to the data — but the offending data is
 * the REFERRER's, so the finding names that manifest and the analyzer reports it
 * when the referrer is the entry's own. A rule that throws or exhausts its
 * budget is a defect in the rule, anchored on the declaring definition.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import {
  REFERRER_RULES_ANNOTATION,
  readRawReferrerRules,
  readReferrerRules,
  type ReferrerRule,
} from "./referrer-rule.js";
import type { PeerBinder, PeerBindingFailure, PeersTarget } from "./peer-binding.js";
import {
  celSourceOf,
  findDynamicLeaf,
  type DynamicLeaf,
  isTaggedCondition,
  pointerSegments,
  pointerToPath,
  readNodes,
} from "./resource-rule.js";
import {
  RULE_BUDGET_MS,
  UNTAGGED_CONDITION,
  compileRuleCondition,
  conditionRefusals,
} from "./rule-condition.js";

export interface ReferrerRuleIssue {
  code: "REFERRER_RULE_INVALID";
  manifest: ResourceManifest;
  path: string;
  message: string;
}

/** One resource that reaches the resource under test, and where it does so. */
export interface Referrer {
  readonly manifest: ResourceManifest;
  readonly kind: string;
  readonly name: string;
  /** Concrete path of the slot in the referrer (`mounts[1].mount`) — the anchor. */
  readonly path: string;
}

/** One rule's verdict on one referrer. */
export type ReferrerRuleFinding =
  | { kind: "violation"; rule: ReferrerRule; referrer: Referrer; message: string }
  | { kind: "skipped"; rule: ReferrerRule; referrer: Referrer; dynamic: DynamicLeaf }
  | { kind: "unbound"; rule: ReferrerRule; referrer: Referrer; failure: PeerBindingFailure }
  | { kind: "failed"; rule: ReferrerRule; referrer?: Referrer; reason: string }
  | { kind: "over-budget"; rule: ReferrerRule; referrer: Referrer; elapsedMs: number };

/** What a peer rule needs beyond the referrers themselves: the binder that
 *  resolves a referrer's collection into declarations. Absent for a host that
 *  cannot resolve one — a rule declaring `peers:` then reports as unbound rather
 *  than running with the binding missing, which would evaluate a condition
 *  against names that are simply not there.
 *
 *  ONE binder per analysis, because it caches each referrer's resolved
 *  collection and both the evaluation and the exercised check ask for it. */
export interface ReferrerRuleContext {
  readonly peerBinder?: PeerBinder;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** What a `peers:` pointer names in the referrer kind it is filtered to. Defined
 *  with the binding vocabulary; re-exported here because this is the surface
 *  that consumes it. The caller resolves it — only it holds the definition
 *  registry, and only after every kind is registered, since a rule may name a
 *  kind declared later in the same file. */
export type { PeersTarget };

export interface ReferrerRuleDeclarationContext {
  /** Resolves a rule's `peers:` against its `referrer:` kind. Omit to skip the
   *  check — the safe direction for a host with no registry. */
  readonly peersTarget?: (referrerKind: string, pointer: string) => PeersTarget;
}

/**
 * Report every way a kind's referrer-rule declarations are malformed. Runs on
 * the `Telo.Definition` / `Telo.Abstract` doc, so a defect lands on the line the
 * kind's author wrote rather than on a consumer's resource.
 *
 * The `referrer:` filter is NOT resolved here: it is canonicalized in the
 * declaring module's scope by `resolveSchemaRefKinds`, the only pass holding
 * that scope, and a name resolving to nothing is reported from there.
 */
export function validateReferrerRuleDeclarations(
  manifest: ResourceManifest,
  context: ReferrerRuleDeclarationContext = {},
): ReferrerRuleIssue[] {
  const own = (manifest as unknown as Record<string, unknown>).schema;
  const raw = readRawReferrerRules(own);
  if (raw === undefined) return [];

  const base = `schema.${REFERRER_RULES_ANNOTATION}`;
  const issues: ReferrerRuleIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ code: "REFERRER_RULE_INVALID", manifest, path, message });
  };

  if (!Array.isArray(raw)) {
    issue(base, `'${REFERRER_RULES_ANNOTATION}' must be an array of rules.`);
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
        "A rule needs a 'condition' — a CEL expression over 'referrer' (the resource that " +
          "references this one) and 'self', TRUE when the rule holds. Write it with the !cel tag.",
      );
    }
    if (typeof entry.code !== "string" || entry.code.length === 0) {
      issue(
        `${at}.code`,
        "A rule needs a 'code' naming it. It is reported in the diagnostic's data.rule, " +
          "not as a diagnostic code — every violation reports under REFERRER_RULE_VIOLATED.",
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
        "A rule needs a 'message' saying what the referrer must do — only the kind's author " +
          "knows that, and the analyzer supplies only where and what.",
      );
    }
    if (entry.referrer !== undefined && typeof entry.referrer !== "string") {
      issue(
        `${at}.referrer`,
        "'referrer' names the kind a referring resource must be, in the same alias-qualified " +
          "grammar as extends: (Self.Server, Http.Server, Telo.Something). Omit it to apply the " +
          "rule to every referrer.",
      );
    }
    if (entry.severity !== undefined && entry.severity !== "error" && entry.severity !== "warning") {
      issue(`${at}.severity`, "'severity' must be 'error' or 'warning'.");
    }

    if (condition !== undefined && condition.length > 0 && !isTaggedCondition(entry.condition)) {
      issue(`${at}.condition`, UNTAGGED_CONDITION);
    }

    validatePeersDeclaration(entry, at, issue, context);

    if (condition) {
      for (const refusal of conditionRefusals(condition)) issue(`${at}.condition`, refusal);
    }
  });

  return issues;
}

/** The strict half of `peers:` — the binding that lets a rule reach a referrer's
 *  OTHER entries, which is also the one that fails invisibly: a pointer naming a
 *  collection nothing in resolves would leave the rule seeing no declaration at
 *  all, and a check that never sees its subject reads as passing. */
function validatePeersDeclaration(
  entry: Record<string, unknown>,
  at: string,
  issue: (path: string, message: string) => void,
  context: ReferrerRuleDeclarationContext,
): void {
  const { peers } = entry;
  if (peers === undefined) return;
  if (typeof peers !== "string") {
    issue(
      `${at}.peers`,
      "'peers' is a JSON Pointer naming a collection OF THE REFERRER (e.g. /tables), whose " +
        "other entries bind as 'peers' and whose own entry binds as 'entry'.",
    );
    return;
  }
  if (pointerSegments(peers) === undefined || peers === "" || peers === "/") {
    issue(
      `${at}.peers`,
      `'peers' must be a JSON Pointer to a collection, e.g. /tables — '${peers}' is not one.`,
    );
    return;
  }
  if (typeof entry.referrer !== "string" || entry.referrer.length === 0) {
    issue(
      `${at}.peers`,
      "'peers' names a collection of the REFERRER, so the rule must also declare 'referrer:' — " +
        "without a kind there is nothing to check the pointer against, and a pointer that " +
        "resolves to nothing disables the rule in silence.",
    );
    return;
  }
  const target = context.peersTarget?.(entry.referrer, peers);
  if (target === "absent") {
    issue(
      `${at}.peers`,
      `'${entry.referrer}' declares no collection at '${peers}'. A pointer that resolves to ` +
        "nothing binds no peers, so the rule would never see a sibling declaration.",
    );
  } else if (target === "plain") {
    issue(
      `${at}.peers`,
      `'${peers}' on '${entry.referrer}' holds plain data — nothing in it is a reference, so ` +
        "no entry resolves to a declaration and the rule would run against values it cannot " +
        "compare. Name a collection whose items are, or contain, a reference.",
    );
  }
}

/**
 * Run a kind's referrer rules against every resource that references one of its
 * resources.
 *
 * `self` binds the referenced resource, `referrer` the one that reached it. A
 * referrer reaching the same resource through several slots is judged ONCE — by
 * manifest identity, since a name alone is module-scoped — because the condition
 * reads the two manifests and nothing about the site, so a second site could only
 * produce the identical verdict at a different path.
 *
 * **A rule declaring `peers:` is the exception, and evaluates once per ENTRY.**
 * That is a deliberate departure from judge-once rather than an inconsistency: a
 * rule that binds `entry` is about the entry, so a resource listed twice has two
 * entries to answer for, and the two sites can genuinely disagree.
 */
export function evaluateReferrerRules(
  manifest: ResourceManifest,
  definitionSchema: unknown,
  referrers: readonly Referrer[],
  /** Whether a referrer of `kind` satisfies a rule's `referrer:` filter —
   *  Liskov-substitutable, so a child of the named kind matches. Supplied by the
   *  caller, which holds the definition registry. */
  kindMatches: (filter: string, kind: string) => boolean,
  context: ReferrerRuleContext = {},
): ReferrerRuleFinding[] {
  const rules = readReferrerRules(definitionSchema);
  if (rules.length === 0) return [];

  const self = manifest as unknown as Record<string, unknown>;
  const findings: ReferrerRuleFinding[] = [];

  for (const rule of rules) {
    const perEntry = rule.peers !== undefined;
    const compiled = compileRuleCondition(
      rule.condition,
      perEntry ? ["self", "referrer", "entry", "peers"] : ["self", "referrer"],
    );
    if ("reason" in compiled) {
      findings.push({ kind: "failed", rule, reason: compiled.reason });
      continue;
    }
    const { parsed, chains } = compiled;

    // Identity is the MANIFEST, never `(kind, name)`: resource names are
    // module-scoped, so two libraries each declaring a `server` of the same kind
    // would share one bucket and the second violation would be dropped in
    // silence — the trap the migration provenance index names.
    const seen = new Set<ResourceManifest>();
    const started = Date.now();
    for (const referrer of referrers) {
      if (rule.referrer !== undefined && !kindMatches(rule.referrer, referrer.kind)) continue;
      if (!perEntry) {
        if (seen.has(referrer.manifest)) continue;
        seen.add(referrer.manifest);
      }

      const scope: Record<string, unknown> = {
        self,
        referrer: referrer.manifest as unknown as Record<string, unknown>,
      };
      if (perEntry) {
        const bound = context.peerBinder
          ? context.peerBinder.bind(referrer.manifest, referrer.kind, rule.peers!, referrer.path)
          : ({
              ok: false,
              failure: { reason: "unknown-shape", at: pointerToPath(rule.peers!) },
            } as const);
        if (!bound.ok) {
          findings.push({ kind: "unbound", rule, referrer, failure: bound.failure });
          continue;
        }
        scope.peers = bound.binding.peers;
        scope.entry = bound.binding.entry;
      }

      // Only the nodes this condition READS decide whether it can run — the
      // resource-rule reasoning, and it bites harder here: the referrer is a
      // whole manifest, so scanning all of it would disable the rule for any
      // server carrying one unrelated expression.
      let dynamic: DynamicLeaf | undefined;
      for (const node of readNodes(chains, scope)) {
        dynamic = findDynamicLeaf(node);
        if (dynamic !== undefined) break;
      }
      if (dynamic !== undefined) {
        findings.push({ kind: "skipped", rule, referrer, dynamic });
        continue;
      }

      let held: unknown;
      try {
        held = parsed(scope);
      } catch (err) {
        findings.push({
          kind: "failed",
          rule,
          referrer,
          reason: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (held !== true) {
        findings.push({ kind: "violation", rule, referrer, message: rule.message });
      }
      const elapsed = Date.now() - started;
      if (elapsed > RULE_BUDGET_MS) {
        findings.push({ kind: "over-budget", rule, referrer, elapsedMs: elapsed });
        break;
      }
    }
  }

  return findings;
}

/** Whether a rule found any referrer to judge — the input to the never-exercised
 *  report, which is how a mistyped `referrer:` filter would otherwise disable a
 *  check in silence. */
export function referrerRuleExercised(
  rule: ReferrerRule,
  referrers: readonly Referrer[],
  kindMatches: (filter: string, kind: string) => boolean,
  context: ReferrerRuleContext = {},
): boolean {
  const matching =
    rule.referrer === undefined
      ? referrers
      : referrers.filter((referrer) => kindMatches(rule.referrer!, referrer.kind));
  if (matching.length === 0) return false;
  if (rule.peers === undefined) return true;
  // A peer rule that ran against an EMPTY peer set proved nothing — and an empty
  // set everywhere is exactly what a typo in `peers:` looks like from outside,
  // which is silence that reads as passing. Asked through the binder, so it
  // shares the resolution the evaluation already paid for.
  const binder = context.peerBinder;
  if (!binder) return false;
  return matching.some((referrer) =>
    binder.hasPeers(referrer.manifest, referrer.kind, rule.peers!, referrer.path),
  );
}

/** Where a referrer-rule finding is reported, and how loudly. Plain data, so the
 *  caller pushes it exactly as it does for the resource-rule reports. */
export interface ReferrerRuleDiagnostic {
  code:
    | "REFERRER_RULE_VIOLATED"
    | "REFERRER_RULE_SKIPPED"
    | "REFERRER_RULE_INVALID"
    | "REFERRER_RULE_UNEXERCISED";
  severity: "error" | "warning" | "information";
  message: string;
  /** The resource the finding is reported ON — the REFERRER for a violation,
   *  the declaring definition for a defect in the rule itself. */
  manifest: ResourceManifest;
  path?: string;
  rule: string;
}

/** Why a peer binding could not be produced, as the sentence a reader acts on. */
function peerBindingReason(failure: PeerBindingFailure): string {
  switch (failure.reason) {
    case "no-collection":
      return `'${failure.at}' holds no collection to bind 'peers' from.`;
    case "unresolved":
      return (
        `a reference at '${failure.at}' names a declaration this analysis does not hold, ` +
        "so a peer would bind to nothing."
      );
    case "dynamic":
      return (
        `a value at '${failure.at}' holds ${failure.what ?? "a value"}, which is not known ` +
        "until the resource is created, so the comparison would run against a placeholder."
      );
    case "unknown-shape":
      return (
        `which paths under '${failure.at}' hold references is not known here, so nothing ` +
        "could be resolved into a declaration."
      );
  }
}

const nameOf = (manifest: ResourceManifest): string =>
  (manifest.metadata?.name as string | undefined) ?? "<unnamed>";

/**
 * Map one resource's findings to what should be reported.
 *
 * A violation names the declaring kind in the message. For a resource rule the
 * reported resource IS of the kind that declared it, so the origin is implicit;
 * here it is not — the diagnostic lands on an `Http.Server` for a rule
 * `HttpServer.Reference` wrote — and leaving that to the author's prose would
 * make the trail depend on remembering to write it.
 */
export function reportReferrerRules(
  manifest: ResourceManifest,
  definition: ResourceManifest | undefined,
  findings: readonly ReferrerRuleFinding[],
  /** Whether the DECLARING definition is one of the entry's own modules. */
  declarationIsOurs: boolean,
): ReferrerRuleDiagnostic[] {
  const declaringKind = manifest.kind;
  const out: ReferrerRuleDiagnostic[] = [];

  for (const finding of findings) {
    if (finding.kind === "violation") {
      out.push({
        code: "REFERRER_RULE_VIOLATED",
        severity: finding.rule.severity,
        message:
          `${finding.referrer.kind}/${nameOf(finding.referrer.manifest)} at ` +
          `'${finding.referrer.path}': required by ${declaringKind} — ${finding.message}`,
        manifest: finding.referrer.manifest,
        path: finding.referrer.path,
        rule: finding.rule.code,
      });
      continue;
    }
    if (finding.kind === "skipped") {
      out.push({
        code: "REFERRER_RULE_SKIPPED",
        severity: "information",
        message:
          `${finding.referrer.kind}/${nameOf(finding.referrer.manifest)}: rule ` +
          `'${finding.rule.code}' from ${declaringKind} did not run at ` +
          `'${finding.referrer.path}' — the value holds ${finding.dynamic.what} at ` +
          `'${finding.dynamic.path}', which is not known until the resource is created. ` +
          "Reported rather than dropped: a check whose coverage varies invisibly reads as passing.",
        manifest: finding.referrer.manifest,
        path: finding.referrer.path,
        rule: finding.rule.code,
      });
      continue;
    }
    if (finding.kind === "unbound") {
      out.push({
        code: "REFERRER_RULE_SKIPPED",
        severity: "information",
        message:
          `${finding.referrer.kind}/${nameOf(finding.referrer.manifest)}: rule ` +
          `'${finding.rule.code}' from ${declaringKind} did not run at ` +
          `'${finding.referrer.path}' — ${peerBindingReason(finding.failure)}` +
          " Reported rather than dropped: a check whose coverage varies invisibly reads as passing.",
        manifest: finding.referrer.manifest,
        path: finding.referrer.path,
        rule: finding.rule.code,
      });
      continue;
    }

    const because =
      finding.kind === "failed"
        ? `failed to evaluate: ${finding.reason}. Guard an optional field with 'in' or '.?'.`
        : `exceeded its evaluation budget (${finding.elapsedMs}ms) and was stopped, so ` +
          "coverage from here on is incomplete. Simplify the condition.";
    out.push({
      code: "REFERRER_RULE_INVALID",
      severity: declarationIsOurs ? "error" : "warning",
      message:
        `Referrer rule '${finding.rule.code}' on kind '${declaringKind}' ${because} ` +
        `This is a defect in the rule, not in ${nameOf(manifest)}` +
        (declarationIsOurs ? "." : " — it is declared by a module this workspace does not own."),
      // The two halves of the anchor move together or they name a node that
      // does not exist: the rule's own declaration site is a path in the
      // DEFINITION, while a referrer's slot path is a path in the REFERRER. A
      // dependency's broken rule therefore lands on the referrer it was checking
      // — a manifest the reader owns and where the path resolves — and on the
      // referenced resource only when there is no referrer to name (a condition
      // that failed to compile at all).
      ...(declarationIsOurs && definition
        ? {
            manifest: definition,
            path: `schema.${REFERRER_RULES_ANNOTATION}[${finding.rule.index}]`,
          }
        : finding.referrer
          ? { manifest: finding.referrer.manifest, path: finding.referrer.path }
          : { manifest }),
      rule: finding.rule.code,
    });
  }

  return out;
}

/** The report for a rule nothing ever exercised — here that means no resource of
 *  the kind was referenced by anything the filter matches, which is what a typo
 *  in `referrer:` looks like from the outside. */
export function reportUnexercisedReferrerRule(
  definition: ResourceManifest,
  rule: ReferrerRule,
): ReferrerRuleDiagnostic {
  return {
    code: "REFERRER_RULE_UNEXERCISED",
    severity: "information",
    message:
      rule.peers !== undefined
        ? `Referrer rule '${rule.code}' never ran with peers to compare: nothing` +
          (rule.referrer === undefined ? "" : ` of kind '${rule.referrer}'`) +
          ` references a resource of this kind while '${rule.peers}' held another ` +
          "declaration, so nothing has proven the condition. An empty peer set " +
          "everywhere is what a typo in 'peers:' looks like from outside."
        : `Referrer rule '${rule.code}' never ran: nothing` +
          (rule.referrer === undefined ? "" : ` of kind '${rule.referrer}'`) +
          " references a resource of this kind, so nothing has proven the condition." +
          (rule.referrer === undefined
            ? ""
            : " A 'referrer' naming a kind no manifest uses disables the rule in silence."),
    manifest: definition,
    path: `schema.${REFERRER_RULES_ANNOTATION}[${rule.index}]`,
    rule: rule.code,
  };
}
