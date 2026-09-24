import type { ResourceDefinition } from "@telorun/sdk";
import { ancestorChain, type DefResolver } from "./extends-resolution.js";

/**
 * An ancestor's `throws:` is a CEILING: every descendant's declared codes must
 * fall within the nearest ancestor that declares a LITERAL list, abstract or
 * concrete. A dynamic (`inherit` / `passthrough`) ancestor between them bounds
 * nothing of its own and is looked past, or a caller holding the list's kind
 * could be handed a code it was never told about. A child's own block still
 * replaces and never merges — the contract rule.
 *
 * The single reader both halves share: `telo check` reports
 * `THROWS_NOT_SUBSTITUTABLE`, the kernel refuses the definition at registration
 * with `ERR_THROWS_NOT_SUBSTITUTABLE`.
 */
export interface ThrowsCeiling {
  declarer: ResourceDefinition;
  codes: ReadonlySet<string>;
}

interface ThrowsBlock {
  codes?: Record<string, unknown>;
  inherit?: boolean;
  passthrough?: boolean;
}

const throwsOf = (def: ResourceDefinition): ThrowsBlock | undefined =>
  (def as unknown as { throws?: ThrowsBlock }).throws;

/** A block whose union is the call site's or the body's, not a literal list. */
const isDynamic = (block: ThrowsBlock): boolean =>
  block.inherit === true || block.passthrough === true;

const declaresLiteral = (def: ResourceDefinition): boolean => {
  const block = throwsOf(def);
  return block !== undefined && !isDynamic(block);
};

/** The nearest ANCESTOR declaring a literal list; none bounds nothing. */
export function throwsCeiling(
  def: ResourceDefinition,
  resolveDef: DefResolver,
): ThrowsCeiling | undefined {
  const declarer = ancestorChain(def, resolveDef).find(declaresLiteral);
  if (!declarer) return undefined;
  return { declarer, codes: new Set(Object.keys(throwsOf(declarer)!.codes ?? {})) };
}

/**
 * The codes `def` literally declares that its ceiling does not admit. A dynamic
 * (`inherit` / `passthrough`) block is judged per instance by the analyzer and
 * skipped here, as the kernel's dispatch-time check skips it.
 */
export function codesOutsideCeiling(
  def: ResourceDefinition,
  resolveDef: DefResolver,
): { ceiling: ThrowsCeiling; outside: string[] } | undefined {
  const own = throwsOf(def);
  if (!own || isDynamic(own)) return undefined;
  const ceiling = throwsCeiling(def, resolveDef);
  if (!ceiling) return undefined;
  const outside = Object.keys(own.codes ?? {}).filter((code) => !ceiling.codes.has(code));
  return outside.length > 0 ? { ceiling, outside } : undefined;
}

/** `<module>.<Name>` of a definition, for messages. */
export function throwsDeclarerName(def: ResourceDefinition): string {
  const module = (def.metadata as { module?: string } | undefined)?.module;
  const name = def.metadata?.name ?? "?";
  return module ? `${module}.${name}` : name;
}

export function throwsNotSubstitutableMessage(
  def: ResourceDefinition,
  violation: { ceiling: ThrowsCeiling; outside: string[] },
): string {
  const ancestor = throwsDeclarerName(violation.ceiling.declarer);
  const allowed = [...violation.ceiling.codes];
  return (
    `${def.kind} '${def.metadata?.name}': throws ${violation.outside.map((c) => `'${c}'`).join(", ")}, ` +
    `which '${ancestor}' does not declare. An ancestor's throws: is a ceiling — a caller holding ` +
    `this through '${ancestor}' is told it can catch ${allowed.length ? allowed.join(", ") : "nothing"}, ` +
    `and nothing re-checks a replacing list against it at dispatch. Report the failure under one of ` +
    `those codes, or add the code to '${ancestor}'.`
  );
}

/**
 * What a dispatch through a target known ONLY by its kind may throw — a library's
 * `resources:` input standing in for an abstract. The nearest declaration along
 * the chain, the kind's own included; `undefined` when none declares a literal
 * list, which the caller reads as UNBOUNDED rather than as throwing nothing.
 */
export function kindThrowsDeclarer(
  def: ResourceDefinition,
  resolveDef: DefResolver,
): ResourceDefinition | undefined {
  return [def, ...ancestorChain(def, resolveDef)].find(declaresLiteral);
}
