import type { Invocable } from "./capabilities/invokable.js";
import type { InvokeContext } from "./cancellation.js";
import type { ControllerPolicy } from "./controller-policy.js";
import type { EvaluationContext } from "./evaluation-context.js";
import type { BootTarget } from "./invoke-step.js";
import type { ResourceInstance } from "./resource-instance.js";

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
  setTargets(vars: BootTarget[]): void;
  setSecrets(secrets: Record<string, unknown>): void;
  setResource(name: string, props: Record<string, unknown>): void;
  setControllerPolicy(policy: ControllerPolicy | undefined): void;
  getControllerPolicy(): ControllerPolicy | undefined;

  /** Register an imported module under `alias`, gated to `kinds` (its `exports.kinds`).
   *  Only listed kinds resolve; an empty list exports nothing. `kinds` is `undefined` only
   *  when the target declares no `exports.kinds` at all — the legacy permissive default. */
  registerImport(alias: string, targetModule: string, kinds?: readonly string[]): void;
  /** Register an alias that crosses no import boundary and is therefore never gated:
   *  `Self` (a library's own kinds) and the `Telo` built-in namespace. */
  registerUngatedAlias(alias: string, targetModule: string): void;
  /** Resolve a cross-module exported-instance reference `Alias.name` to its `{kind, name}`
   *  ref (canonical kind), gated by the import's `exports.resources`. Returns undefined when
   *  the alias is unknown, the name isn't exported, or the import hasn't initialized yet. */
  resolveImportedRef(alias: string, name: string): { kind: string; name: string } | undefined;
  /** Resolve a cross-module exported-instance reference `Alias.name` to its live instance. */
  resolveImportedInstance(alias: string, name: string): ResourceInstance | undefined;
  getInstance(name: string): unknown;
  getInvocable<TInput = Record<string, any>, TOutput = any>(
    name: string,
  ): Invocable<TInput, TOutput>;
  resolveKind(kind: string): string;
  runTargets(ctx?: InvokeContext): Promise<void>;
}
