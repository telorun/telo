/**
 * **The native function contract** — what a controller for a callable kind
 * (`capability: Telo.Callable` with `controllers:`) exports and returns.
 *
 * The fragment selects a namespace exporting `create(resource, ctx)`, which may
 * be async — instantiating WebAssembly or opening a native file is setup work —
 * and returns an instance whose `call(args)` is SYNCHRONOUS: a function is
 * called from inside one CEL expression, which has nowhere to await. A thenable
 * result is refused by these types at build time and by the kernel at run time
 * (`ERR_FUNCTION_ASYNC`).
 *
 * `call` receives one object keyed by parameter name. The kernel binds it to the
 * signature at creation, so before each call declared defaults are filled,
 * declared scalars normalized and the arguments validated (`ERR_INPUT_INVALID`),
 * and the result is normalized and validated against `returns`
 * (`ERR_OUTPUT_INVALID`). Values arrive as CEL values: a `bigint` for an
 * integer, a `Date` for a timestamp, a `Duration`, a `Uint8Array` for bytes.
 */
import type { EffectBody, EffectChain } from "./effect.js";
import type { Logger } from "./logger.js";
import type { ResourceManifest } from "./resource-manifest.js";

/** A function's `call` returned a promise-like. */
export const ERR_FUNCTION_ASYNC = "ERR_FUNCTION_ASYNC";

/**
 * Everything a function's controller reaches through Telo — deliberately
 * nothing that is I/O or state: no environment, no resource, no dispatch. That
 * limits what the context gives, not what the host language can do, which is
 * why a native kind's determinism is a claim its author makes.
 */
export interface FunctionContext {
  /** A file this controller's own module ships (see `ResourceContext`). */
  resolveControllerFile(relative: string): Promise<string>;
  /** A platform-specific file this controller's module declares under `native:`. */
  resolveNativeFile(name: string): Promise<string>;
  readonly log: Logger;
  /** An allocation made in `create`, paired with its inverse — run it with
   *  `.perform()`, and a reload or teardown releases it. */
  effect<T>(reason: string, body: EffectBody<void, T>): EffectChain<T>;
}

/** What `call` may return: any value that is not a promise-like. */
export type FunctionResult =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined
  | (object & { readonly then?: never });

export interface FunctionInstance<
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result extends FunctionResult = FunctionResult,
> {
  call(args: Args): Result;
}

/** The namespace a callable kind's controller fragment selects. */
export interface FunctionController<
  Resource extends ResourceManifest = ResourceManifest,
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result extends FunctionResult = FunctionResult,
> {
  create(
    resource: Resource,
    ctx: FunctionContext,
  ): FunctionInstance<Args, Result> | Promise<FunctionInstance<Args, Result>>;
}
