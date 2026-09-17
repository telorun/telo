/**
 * **A function, bound to its signature at creation** — the callable-kind half of
 * what `invocation-contract-binding.ts` does for `invoke` / `provide`.
 *
 * Every callable instance's `call(args)` is replaced here, at the single
 * instance-production site, so no holder ever reaches it unbound: a CEL call
 * through the module-function table and a controller calling a function it holds
 * through a slot go through the same checks, whether the function is written in
 * CEL or in a controller's code.
 *
 * Before each call the declared defaults are filled and the declared scalars
 * normalized (`callArgumentBinding`, shared with the analyzer), and the
 * arguments validated against the parameters (`ERR_INPUT_INVALID`). A result
 * that is a promise-like is `ERR_FUNCTION_ASYNC`; otherwise it is normalized and
 * validated against `returns` (`ERR_OUTPUT_INVALID`). Those three are the
 * binding's own refusals and pass unchanged; anything else the function throws
 * becomes `ERR_FUNCTION_FAILED`, named by whoever called it.
 *
 * A native function's controller receives a `FunctionContext` — resolving its
 * own module's files, logging, and effects for what `create` allocates.
 */
import {
  callArgumentBinding,
  parameterSchemaOf,
  signatureSchemaOf,
  withLiveValuesSkipped,
  type CallableSignature,
} from "@telorun/analyzer";
import {
  ERR_FUNCTION_ASYNC,
  ERR_FUNCTION_FAILED,
  ERR_INPUT_INVALID,
  ERR_OUTPUT_INVALID,
  InvokeError,
  isCancellationError,
  isInvokeError,
  isSuspension,
  RuntimeError,
  type FunctionContext,
  type Logger,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";

type SchemaResolver = (ref: string) => Record<string, any> | undefined;
type ValidatorFor = (schema: Record<string, any>) => { validate(value: unknown): void };

/** A bound function's checked call over named arguments, before its failures
 *  are classified — what a caller naming the function its own way reaches. */
export type SignatureBoundCall = (args: Record<string, unknown>) => unknown;

const bindingRefusals = new WeakSet<object>();
const boundCalls = new WeakMap<object, SignatureBoundCall>();

/** The narrow context a native function's controller receives — everything
 *  else on a resource context is I/O or state a function must not reach. */
export function functionContextOf(ctx: ResourceContext): FunctionContext {
  return {
    resolveControllerFile: (relative) => ctx.resolveControllerFile(relative),
    resolveNativeFile: (name) => ctx.resolveNativeFile(name),
    get log() {
      return ctx.log;
    },
    effect: (reason, body) => ctx.effect(reason, body),
  };
}

/** The checked call of an instance {@link bindFunction} bound, or undefined for
 *  an instance no function binding produced. */
export function signatureBoundCallOf(instance: ResourceInstance): SignatureBoundCall | undefined {
  return boundCalls.get(instance);
}

export function bindFunction(
  instance: ResourceInstance,
  label: string,
  signature: CallableSignature,
  validatorFor: ValidatorFor,
  resolveRef: SchemaResolver,
  log: Logger,
): void {
  const call = (instance as { call?: unknown }).call;
  if (typeof call !== "function") {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `Function '${label}': its controller's create() returned an instance with no call(args) ` +
        `method. A function's instance must carry a synchronous call(args).`,
    );
  }
  const tag = Object.prototype.toString.call(call);
  if (tag === "[object AsyncFunction]" || tag === "[object AsyncGeneratorFunction]") {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `Function '${label}': its call(args) is declared async. A function's call is evaluated inside ` +
        `a CEL expression, which cannot wait: make call synchronous, and do asynchronous setup in create().`,
    );
  }

  const params = signature.params ?? [];
  const binding = callArgumentBinding(label, params, signature.returns, resolveRef);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of params) {
    if (typeof param.name !== "string") continue;
    properties[param.name] = parameterSchemaOf(param) ?? {};
    if (param.optional !== true) required.push(param.name);
  }
  const argumentsValidator = validatorFor(
    withLiveValuesSkipped({ type: "object", properties, required }, resolveRef),
  );
  const resultSchema = signatureSchemaOf(signature.returns);
  const resultValidator = resultSchema
    ? validatorFor(withLiveValuesSkipped(resultSchema, resolveRef))
    : undefined;

  const refuse = (code: string, message: string, cause?: unknown): InvokeError => {
    const error = new InvokeError(code, message, { function: label }, cause ? { cause } : undefined);
    bindingRefusals.add(error);
    return error;
  };

  const checked: SignatureBoundCall = (args) => {
    const named = binding.bindNamed(args ?? {});
    try {
      argumentsValidator.validate(named);
    } catch (cause) {
      throw refuse(
        ERR_INPUT_INVALID,
        `Function '${label}': the arguments do not satisfy its declared params: ${messageOf(cause)}`,
        cause,
      );
    }
    const result = (call as (args: Record<string, unknown>) => unknown).call(instance, named);
    if (isThenable(result)) {
      // The refusal is raised now; the promise settles later, and a rejection
      // nothing observes would take the process down rather than be reported.
      (result as PromiseLike<unknown>).then(undefined, (rejection: unknown) =>
        log.error(`Function '${label}': the promise its call returned, refused as ERR_FUNCTION_ASYNC, rejected`, {
          function: label,
        }, { error: rejection }),
      );
      throw refuse(
        ERR_FUNCTION_ASYNC,
        `Function '${label}' returned a promise. A function's call(args) is evaluated inside a ` +
          `CEL expression, which cannot wait: make call synchronous, and do asynchronous setup in create().`,
      );
    }
    const normalized = binding.result(result);
    if (resultValidator) {
      try {
        resultValidator.validate(normalized);
      } catch (cause) {
        throw refuse(
          ERR_OUTPUT_INVALID,
          `Function '${label}': the result does not satisfy its declared returns: ${messageOf(cause)}`,
          cause,
        );
      }
    }
    return normalized;
  };

  boundCalls.set(instance, checked);
  (instance as { call: SignatureBoundCall }).call = (args) => {
    try {
      return checked(args);
    } catch (error) {
      throw functionFailure(label, error);
    }
  };
}

/** A function's failure as the runtime reports it, naming the function as the
 *  caller knows it. */
export function functionFailure(name: string, error: unknown): unknown {
  // Neither is the function failing: a cancellation is the runtime leaving, and
  // a suspension is the run leaving — both must reach whatever owns them intact.
  if (isCancellationError(error) || isSuspension(error)) return error;
  // The binding's own refusals name the function already and carry their own
  // codes (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_FUNCTION_ASYNC`).
  if (!!error && typeof error === "object" && bindingRefusals.has(error)) return error;
  if (isInvokeError(error) && error.code === ERR_FUNCTION_FAILED) return error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return new InvokeError(
    ERR_FUNCTION_FAILED,
    `Function '${name}' failed: ${message}`,
    { function: name, message, ...(typeof code === "string" ? { code } : {}) },
    { cause: error },
  );
}

function isThenable(value: unknown): boolean {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
