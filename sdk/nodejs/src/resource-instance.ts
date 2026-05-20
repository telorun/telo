import type { Invocable } from "./capabilities/invokable.js";
import type { Provider } from "./capabilities/provider.js";
import type { Runnable } from "./capabilities/runnable.js";
import type { ResourceContext } from "./resource-context.js";

export type ResourceInstance<TInput = Record<string, any>, TOutput = any> = Partial<
  Invocable<TInput, TOutput>
> &
  Partial<Runnable> &
  Partial<Provider<TOutput>> & {
    init?(ctx?: ResourceContext): Promise<void>;
    teardown?(): void | Promise<void>;
    snapshot?(): Record<string, any> | Promise<Record<string, any>>;
  };
