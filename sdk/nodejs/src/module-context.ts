import type { Invocable } from "./capabilities/invokable.js";
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

  /** Maps import alias -> real module name for kind resolution. */
  readonly importAliases: Map<string, string>;

  setVariables(vars: Record<string, unknown>): void;
  setTargets(vars: string[]): void;
  setSecrets(secrets: Record<string, unknown>): void;
  setResource(name: string, props: Record<string, unknown>): void;

  registerImport(alias: string, targetModule: string, kinds: string[]): void;
  getInstance(name: string): unknown;
  getInvocable<TInput = Record<string, any>, TOutput = any>(
    name: string,
  ): Invocable<TInput, TOutput>;
  resolveKind(kind: string): string;
  runTargets(): Promise<void>;
}
