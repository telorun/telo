/**
 * A function's declared shape: `size(string): int`, `string.startsWith(string): bool`.
 *
 * One spelling serves registration, the signature data a port reads, and the
 * definition listing a host prints, so a signature that round-trips through text is
 * the signature it started as.
 *
 * **The dispatch key excludes the return type.** That is what makes "register,
 * override exactly, or remove" one mechanism rather than three: registering
 * `duration(string): Money` replaces `duration(string): google.protobuf.Duration`
 * because both answer the same call, and the engine being replaced refuses exactly
 * this as an overlapping overload — which is why its standard library cannot be
 * changed at all.
 */

import type { CelType } from "./cel-type.js";
import type { CelValue } from "./cel-value.js";
import { formatType } from "./cel-type.js";
import type { CelImplementation } from "./runtime-library.js";
import type { NominalResolver } from "./type-expression.js";
import { CelTypeExpressionError, parseTypeExpression } from "./type-expression.js";

export type CallForm = "global" | "receiver";

export interface CelSignature {
  readonly name: string;
  readonly form: CallForm;
  /** The type the call is written on, for a receiver call. */
  readonly receiver?: CelType;
  readonly parameters: readonly CelType[];
  readonly returns: CelType;
}

const SIGNATURE = /^(?:(.+)\.)?([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)\s*:\s*(.+)$/;

export function parseSignature(text: string, resolveNominal?: NominalResolver): CelSignature {
  const parts = SIGNATURE.exec(text.trim());
  if (!parts) {
    throw new CelTypeExpressionError(
      `${JSON.stringify(text)} is not a signature — write 'name(a, b): r' or 'Receiver.name(a): r'`,
    );
  }
  const [, receiverText, name, parameterText, returnText] = parts;
  const parameters = splitParameters(parameterText!).map((part) =>
    parseTypeExpression(part, resolveNominal),
  );
  return {
    name: name!,
    form: receiverText === undefined ? "global" : "receiver",
    ...(receiverText === undefined ? {} : { receiver: parseTypeExpression(receiverText, resolveNominal) }),
    parameters,
    returns: parseTypeExpression(returnText!, resolveNominal),
  };
}

/** The parameter list, split at its own commas — `map<K, V>` holds one of its own. */
function splitParameters(text: string): string[] {
  if (!text.trim()) return [];
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at];
    if (ch === "<") depth += 1;
    else if (ch === ">") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

export function formatSignature(signature: CelSignature): string {
  return `${signatureKey(signature)}: ${formatType(signature.returns)}`;
}

/** What two registrations of the same call share: the name, the form and the parameters. */
export function signatureKey(signature: CelSignature): string {
  const on = signature.receiver ? `${formatType(signature.receiver)}.` : "";
  return `${on}${signature.name}(${signature.parameters.map((type) => formatType(type)).join(", ")})`;
}

/**
 * Checking the arguments a call wrote as LITERALS, where a type cannot say enough.
 *
 * A signature constrains types, so a guard over a VALUE — an unparseable format
 * specifier, a decimal count out of range, an unknown time zone, a pattern the regular
 * expression engine refuses — would otherwise fire only when the expression is evaluated,
 * which puts a defect the source states in plain sight behind a run. A registration that
 * carries one is asked at the call site the checker has just resolved, and a refusal is
 * `CEL_INVALID_ARGUMENT` with the call's own range.
 *
 * `literals[at]` is the value of argument `at` where it was written as a literal — the
 * receiver first, for a call written on a value, so the positions are the ones the
 * implementation sees — and `undefined` where the argument is an expression whose value
 * is not statically known, which a guard must SKIP rather than judge. The answer is the
 * refusal, or nothing where there is none. A guard runs the same code the evaluation
 * runs, so the static and dynamic answers cannot drift into disagreement.
 */
export type LiteralArgumentCheck = (
  literals: readonly (CelValue | undefined)[],
) => string | undefined;

/** What a host declares about a function beyond its types. */
export interface FunctionMetadata {
  /**
   * What the function does. The standard library's behaviour is looked up by dispatch
   * key instead (`runtime-library.ts`), so a registration carries one only where the
   * host supplies it; a call that resolves to a registration with neither is
   * `unbound_function` at evaluation. The type is not thenable, so an implementation
   * that answers asynchronously does not compile.
   */
  readonly implementation?: CelImplementation;
  /** A guard over the arguments written as literals, asked where the checker resolves the call. */
  readonly checkArguments?: LiteralArgumentCheck;
  /** Whether two calls with the same arguments answer the same thing. Default true. */
  readonly deterministic?: boolean;
  /** Whether the implementation is supplied by the host rather than the engine. */
  readonly hostBacked?: boolean;
  /** The error codes a call may fail with. */
  readonly throws?: readonly string[];
  readonly description?: string;
  /** Where the registration came from, for a listing a human reads. */
  readonly origin?: string;
}
