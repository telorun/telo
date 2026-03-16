import type { ResourceContext } from "./resource-context.js";
import type { Invokable } from "./capabilities/invokable.js";
import type { Runnable } from "./capabilities/runnable.js";

export type ResourceInstance<TInput = Record<string, any>, TOutput = any> =
  Partial<Invokable<TInput, TOutput>> &
  Partial<Runnable> & {
    init?(ctx?: ResourceContext): Promise<void>;
    teardown?(): void | Promise<void>;
    snapshot?(): Record<string, any> | Promise<Record<string, any>>;
  };
