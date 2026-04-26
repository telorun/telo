import type { Invocable } from "./capabilities/invokable.js";
import type { ControllerPolicy } from "./controller-policy.js";
import type { EvaluationContext } from "./evaluation-context.js";

/**
 * Public contract for a persistent, module-scoped context.
 *
 * Three reserved CEL namespaces: variables, secrets, resources.
 * Unlike the base EvaluationContext, ModuleContext is stateful and mutable:
 * variables/secrets/resources accumulate during multi-pass initialization.
 * Import aliases are tracked here for alias-prefixed kind resolution.
 *
 * The class implementation lives in `@telorun/kernel`.
 */
export interface ModuleContext extends EvaluationContext {
  readonly variables: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
  readonly resources: Record<string, unknown>;

  /** True if `alias` was registered via `registerImport()` on this module. */
  hasImport(alias: string): boolean;

  setVariables(vars: Record<string, unknown>): void;
  setTargets(vars: string[]): void;
  setSecrets(secrets: Record<string, unknown>): void;
  setResource(name: string, props: Record<string, unknown>): void;
  setControllerPolicy(policy: ControllerPolicy | undefined): void;
  getControllerPolicy(): ControllerPolicy | undefined;

  registerImport(alias: string, targetModule: string, kinds: string[]): void;
  getInstance(name: string): unknown;
  getInvocable<TInput = Record<string, any>, TOutput = any>(
    name: string,
  ): Invocable<TInput, TOutput>;
  resolveKind(kind: string): string;
  runTargets(): Promise<void>;
}
