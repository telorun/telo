/**
 * Every function call in a CEL expression, reported for the caller that judges it.
 *
 * **The classifier is gone, and so is its reason for existing.** This file used to decide
 * `CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM` and `CEL_INVALID_ARGUMENT` itself, by
 * looking every call up in the environment's registry — because the engine it drove reported
 * one sentence for three unrelated mistakes (`found no matching overload for 'f(...)'`), two
 * of whose readings actively misled: the message named argument types, so the repair for
 * `startsWith(key, 'x')` looked like a cast when the fix was `key.startsWith('x')`.
 *
 * `@telorun/cel` decides each of them where the cause is known, with a range and a whole-
 * source fix — an unknown name, a name called in the other form, a type no overload takes,
 * and a refusal over a literal argument (`checkLiteralArguments`, which runs the very code
 * the evaluation runs). So nothing here classifies, and nothing reads a message.
 *
 * What is left is Telo's half: the call LIST, which the analyzer needs to judge whether a
 * module call reaches a function at all (`FUNCTION_UNRESOLVED` / `_NOT_EXPORTED` /
 * `_NOT_CALLABLE` / `_ARITY_MISMATCH` / `_ARGUMENT_MISMATCH`) — a verdict that is manifest
 * context and never this engine's.
 */
import type { CelEnvironment, CelNode, CheckResult } from "@telorun/cel";
import { moduleCallArgumentChains } from "./analyze.js";
import type { CallSite, EngineDiagnostic } from "../engine.js";
import type { CelCallAudit } from "./verdict-codes.js";

/**
 * What one audit establishes. The diagnostic lists stay on the shape because the ANALYZER
 * reads them: they are now always empty from here — the engine's checker decides every
 * verdict about a call — and a caller that merged two lists keeps doing so unchanged.
 */
export interface CallAudit {
  readonly diagnostics: readonly EngineDiagnostic[];
  /** Every function call in the source, in source order. */
  readonly calls: readonly CallSite[];
  /** Names a type-check failure mentions that resolved to nothing. */
  readonly unresolved: readonly string[];
  /** Refusals over a literal argument. The engine decides these at check now. */
  readonly argumentIssues: readonly EngineDiagnostic[];
}

/**
 * The flags a module function carries, as the host that resolves it derives them — or
 * undefined where the name reaches no function. Absent means "no signal", never
 * "deterministic".
 */
export type ModuleCallFlags = (
  qualified: string,
) => { readonly deterministic: boolean; readonly hostBacked: boolean } | undefined;

/**
 * Every call the expression makes, with what the checker resolved about it.
 *
 * A module call carries no catalog flag: what a module function's determinism and
 * host-backedness are follows from the callable it resolves to, so they are carried only as
 * the host's `moduleCallFlags` reports them, and stay absent where it gives nothing.
 */
export function auditCalls(
  source: string,
  root: CelNode,
  environment: CelEnvironment,
  moduleCallFlags?: ModuleCallFlags,
  checked?: CheckResult,
): CelCallAudit {
  const result = checked ?? environment.check({ source, root, namespaces: environment.namespaces(), diagnostics: [] });
  const argumentChains = moduleCallArgumentChains(root);
  const byNode = new Map(
    [...argumentChains].map(([node, chains]) => [`${node.range[0]}:${node.range[1]}`, chains]),
  );

  // **One entry per call.** The checker already lists a qualified call — with `namespace`
  // set and `form: "receiver"`, which is how it was written — so appending a second entry
  // per `qualifiedCalls` showed every module call twice, with two contradictory forms, to
  // every consumer that iterates this list.
  const calls: CallSite[] = [];
  for (const call of result.calls) {
    const qualified = call.namespace !== undefined;
    const flags = qualified ? moduleCallFlags?.(call.name) : undefined;
    const chains = qualified ? byNode.get(`${call.range[0]}:${call.range[1]}`) : undefined;
    calls.push({
      name: call.name,
      form: call.form,
      arity: call.arity,
      start: call.range[0],
      end: call.range[1],
      ...(qualified ? { moduleCall: true as const } : {}),
      // A module call's arguments as the analysis saw them: the type the checker gives each
      // one, and the chain where the argument IS one — so a caller holding the callee's
      // signature can compare a declared shape rather than a CEL type alone.
      ...(qualified && call.argumentTypes
        ? {
            arguments: call.argumentTypes.map((type, at) => {
              const chain = chains?.[at] ?? null;
              return {
                ...(type === "dyn" ? {} : { type }),
                ...(chain ? { chain } : {}),
              };
            }),
          }
        : {}),
      // A module call carries no catalog flag: its determinism and host-backedness follow
      // from the callable the name resolves to, which only the host that resolves it knows.
      ...(qualified
        ? flags
          ? { deterministic: flags.deterministic, hostBacked: flags.hostBacked }
          : {}
        : {
            ...(call.deterministic === undefined ? {} : { deterministic: call.deterministic }),
            ...(call.hostBacked === undefined ? {} : { hostBacked: call.hostBacked }),
          }),
    });
  }

  calls.sort((left, right) => left.start - right.start || left.end - right.end);
  return { diagnostics: [], calls, unresolved: [], argumentIssues: [] };
}

/**
 * Registered signatures for names a type-check failure mentions, so a residual message says
 * what the function actually accepts rather than only echoing what the author wrote.
 */
export function explainUnresolved(names: readonly string[], environment: CelEnvironment): string {
  const wanted = new Set(names);
  const signatures = environment
    .definitions()
    .functions.filter((entry) => wanted.has(entry.name))
    .map((entry) => entry.signature);
  if (signatures.length === 0) return "";
  const listed = [...new Set(signatures)].map((signature) => `\`${signature}\``);
  const last = listed.pop()!;
  return ` Registered: ${listed.length > 0 ? `${listed.join(", ")} and ${last}` : last}.`;
}
