/**
 * A compiled expression, and what happens at the top of an evaluation.
 *
 * An error is a **value** throughout evaluation, so that `false && <missing key>` is
 * `false`. At the top there is nothing left to short-circuit, so a surviving error
 * becomes a thrown failure carrying its code — the one place the engine throws about an
 * expression's own data, and the only form a caller can be expected to handle.
 */

import type { CelActivation } from "./activation.js";
import type { CelStep, CompileTarget, NamespaceDispatch } from "./backend-runtime.js";
import { compileTree } from "./closure-backend.js";
import type { CelError, CelEvaluationCode, CelValue } from "./cel-value.js";
import { celError, isCelError, isThenable } from "./cel-value.js";
import type { CelExpression } from "./cel-expression.js";
import type { SourceRange } from "./syntax-tree.js";

/** A failure an evaluation could not carry any further. */
export class CelEvaluationError extends Error {
  readonly code: CelEvaluationCode;
  readonly range?: SourceRange;

  constructor(code: CelEvaluationCode, message: string, range?: SourceRange) {
    super(message);
    this.name = "CelEvaluationError";
    this.code = code;
    if (range) this.range = range;
  }
}

export interface EvaluateOptions {
  /**
   * What a namespaced call (`Alias.fn(x)`) is dispatched through. A host binds it per
   * evaluation, because which functions a scope reaches is the host's own question; a
   * call nothing binds is `unbound_function`.
   */
  readonly namespaceFunction?: NamespaceDispatch;
}

export interface CelProgram {
  readonly source: string;
  /** The value, or a throw carrying the code of the error that survived to the top. */
  evaluate(activation?: CelActivation, options?: EvaluateOptions): CelValue;
  /** The value or the error value, for a caller that carries errors itself. */
  evaluateToValue(activation?: CelActivation, options?: EvaluateOptions): CelValue;
}

/** The refusal a thenable surviving to the top is, spanning the whole expression. */
function asyncRefused(source: string): CelError {
  return celError(
    "async_value_unsupported",
    "a value that must be awaited reached evaluation, and CEL evaluates synchronously",
    [0, source.length],
  );
}

const NO_ACTIVATION: CelActivation = Object.freeze(Object.create(null) as CelActivation);
/** A frame that binds nothing needs no slots, and allocating none is measurable. */
const NO_SLOTS: CelValue[] = [];

export function compileExpression(expression: CelExpression, target: CompileTarget): CelProgram {
  const compiled = compileTree(expression.root, target);
  return new Program(expression.source, compiled.step, compiled.slots);
}

/**
 * A program over a step a backend already built — what an emitted module's function
 * becomes. The top of an evaluation is the same either way: the thenable backstop, and a
 * surviving error turning into a throw. A second implementation of that top would be a
 * second answer to "what does a caller see", which is the one thing two backends may not
 * disagree about.
 */
export function programOfStep(source: string, step: CelStep, slots = 0): CelProgram {
  return new Program(source, step, slots);
}

class Program implements CelProgram {
  constructor(
    readonly source: string,
    private readonly step: CelStep,
    private readonly slots: number,
  ) {}

  evaluateToValue(activation: CelActivation = NO_ACTIVATION, options: EvaluateOptions = {}): CelValue {
    // One shape, every time: a frame built two ways is two shapes, and every step that
    // reads one would see both.
    const value = this.step({
      activation,
      slots: this.slots === 0 ? NO_SLOTS : new Array<CelValue>(this.slots),
      namespaceFunction: options.namespaceFunction,
    });
    // The backstop, one check per evaluation: every door refuses a thenable where the value
    // enters, and this is what catches a door nobody has thought of yet rather than handing a
    // promise to a caller as though it were a value.
    return isThenable(value) ? asyncRefused(this.source) : value;
  }

  evaluate(activation?: CelActivation, options?: EvaluateOptions): CelValue {
    const value = this.evaluateToValue(activation, options);
    if (isCelError(value)) throw new CelEvaluationError(value.code, value.message, value.range);
    return value;
  }
}
