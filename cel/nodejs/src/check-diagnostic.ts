/**
 * What the checker says, and the fact that **the checker says it**.
 *
 * Every verdict here carries its own code and the range of the text it is about. That
 * is the whole point: an engine that reports one sentence for unrelated mistakes forces
 * whoever consumes it to re-derive the cause afterwards from a registry it has to walk
 * again — a classifier that can only ever explain, never decide, and that must stay
 * silent on anything it cannot account for. The component that already knows decides
 * here, once, and nothing downstream reads a message string.
 *
 * A **fix is a whole-source replacement**, never a sub-range splice. A CEL expression
 * is usually one YAML scalar, an edit to it is applied by replacing that scalar, and a
 * sub-range offset means something different the moment the scalar is re-indented.
 */

import type { SourceRange } from "./syntax-tree.js";

/**
 * Every verdict this engine decides. The type follows the list, so a code can only be
 * added in one place and a host reading the vocabulary reads the same set the compiler
 * holds every diagnostic to.
 */
export const CEL_CHECK_CODES = [
  /** The source could not be read at all (the front end's verdict, carried through). */
  "CEL_SYNTAX_ERROR",
  /** A type is not the one the expression needs here. */
  "CEL_TYPE_ERROR",
  /** A name nothing declares. */
  "CEL_UNKNOWN_IDENTIFIER",
  /** A member a declared type does not hold. */
  "CEL_UNKNOWN_FIELD",
  /** A function nothing registers. */
  "CEL_UNKNOWN_FUNCTION",
  /** A registered function called in the other form — `x.f()` for `f(x)`, or back. */
  "CEL_WRONG_CALL_FORM",
  /** A named type whose type argument differs from the one wanted. */
  "CEL_TYPE_ARGUMENT_MISMATCH",
  /** A dereference of something that may be null, with no guard proving it is not. */
  "CEL_NULLABLE_ACCESS",
  /** An argument a construct refuses on sight — a macro's variable that is not a name. */
  "CEL_INVALID_ARGUMENT",
  /** A namespaced call naming a function the namespace does not declare. */
  "FUNCTION_UNRESOLVED",
  /** A namespaced call with the wrong number of arguments. */
  "FUNCTION_ARITY_MISMATCH",
  /** A namespaced call whose argument is not the declared type. */
  "FUNCTION_ARGUMENT_MISMATCH",
] as const;

export type CelCheckCode = (typeof CEL_CHECK_CODES)[number];

export interface CelDiagnosticFix {
  /** The whole expression, corrected. */
  readonly replacement: string;
}

export interface CelCheckDiagnostic {
  readonly code: CelCheckCode;
  readonly message: string;
  readonly range: SourceRange;
  readonly fix?: CelDiagnosticFix;
}

/**
 * An engine error: the caller used the engine wrongly, so nothing is checked or
 * compiled. It is not a verdict about the expression — `unreadable_expression` is the
 * refusal to compile a tree the front end already reported a syntax diagnostic for,
 * which is a question the caller should have asked before compiling.
 */
export type CelEngineErrorCode = "namespaces_mismatch" | "unreadable_expression";

export class CelEngineError extends Error {
  readonly code: CelEngineErrorCode;

  constructor(code: CelEngineErrorCode, message: string) {
    super(message);
    this.name = "CelEngineError";
    this.code = code;
  }
}

/** Collects diagnostics in discovery order, which is source order for one pass. */
export class DiagnosticList {
  private readonly held: CelCheckDiagnostic[] = [];

  add(diagnostic: CelCheckDiagnostic): void {
    this.held.push(diagnostic);
  }

  get length(): number {
    return this.held.length;
  }

  list(): readonly CelCheckDiagnostic[] {
    return this.held;
  }
}
