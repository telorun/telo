/**
 * Completion inside a CEL body.
 *
 * Every candidate comes from the scope the analyzer resolved for this exact
 * site, so the list is a claim that what it offers will type-check — not a
 * separate model of what CEL sees. Where the scope declares nothing (an open
 * node, a permissive contract, a live value) nothing is offered, which is the
 * honest answer rather than a guess.
 */
import type { CelScopeQuery, CelSegment } from "@telorun/analyzer";
import type { CompletionResult, ReplaceRange } from "../types.js";
import { celCursorChain } from "../cel/cursor-chain.js";
import { celFunctions, celMemberSymbols, celRootSymbols, type CelSymbol } from "../cel/symbols.js";

/** The resource a cursor's document addresses. */
export interface CelCompletionTarget {
  kind?: string;
  name?: string;
}

/** Markdown listing every overload, with the function's own description above
 *  it. A single-signature function needs no list — its one signature is already
 *  on the detail line. */
function describeOverloads(signatures: string[], description?: string): string | undefined {
  if (signatures.length <= 1) return description;
  const list = signatures.map((s) => `- \`${s}\``).join("\n");
  return description ? `${description}\n\n${list}` : list;
}

function toResult(symbol: CelSymbol, replaceRange?: ReplaceRange): CompletionResult {
  return {
    label: symbol.name,
    kind: "property",
    detail: symbol.type,
    documentation: symbol.description,
    replaceRange,
  };
}

/**
 * Candidates for the cursor inside `segment`.
 *
 * A member position (`req.|`) offers only what the prefix declares — no
 * functions, since a receiver-style call is rare next to a field access and
 * mixing them buries the fields. A root position offers the scope's names
 * first, then the global functions the environment declares.
 */
export function celCompletions(
  text: string,
  segment: CelSegment,
  offset: number,
  concretePath: string,
  target: CelCompletionTarget,
  query: CelScopeQuery | undefined,
): CompletionResult[] {
  if (!query) return [];
  const resource = query.resourceFor(target.kind, target.name);
  if (!resource) return [];
  const scope = query.scopeAt(resource, concretePath);

  const chain = celCursorChain(text, segment, offset);
  const prefix = chain?.prefix ?? [];

  if (chain?.member) {
    return celMemberSymbols(scope, prefix).map((s) => toResult(s));
  }

  const roots = celRootSymbols(scope);
  const results = roots.map((s) => toResult(s));
  // A CEL type name (`double`, `int`, `string`) is registered as a variable of
  // type `type` AND as the conversion function of the same name. Both are real,
  // but two identical labels are two things an author cannot choose between, so
  // the callable form wins the slot and says it also names the type — that is
  // the form written at a root position.
  const typeNames = new Set(roots.filter((s) => s.type === "type").map((s) => s.name));

  // Global functions only: a receiver-style one (`string.startsWith`) is
  // reachable through a member position, where the receiver's type is known.
  for (const fn of celFunctions(scope)) {
    if (fn.receiverType) continue;
    const alsoAType = typeNames.has(fn.name);
    if (alsoAType) {
      const at = results.findIndex((r) => r.label === fn.name);
      if (at >= 0) results.splice(at, 1);
    }
    results.push({
      label: fn.name,
      kind: "value",
      // One candidate per function, so the extra overloads are reported IN it
      // rather than as repeated labels: the count on the detail line, the
      // signatures themselves in the documentation.
      detail:
        fn.signatures.length > 1
          ? `${fn.signatures[0]}  (+${fn.signatures.length - 1} overloads)`
          : fn.signatures[0],
      documentation: describeOverloads(
        fn.signatures,
        alsoAType
          ? [fn.description, `Also names the CEL type \`${fn.name}\`.`].filter(Boolean).join("\n\n")
          : fn.description,
      ),
      // Sorted after the scope's own names: a variable is what an author is
      // reaching for at a root position far more often than a built-in.
      sortText: `z${fn.name}`,
    });
  }
  return results;
}
