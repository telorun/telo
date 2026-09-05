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
  /**
   * Resolve a sibling by NAME.
   *
   * A resolution taken while the module is still initializing is RECORDED,
   * because a caller that resolves during `init()` may hold what it gets, and
   * nothing in the manifest says so: a name passed here is invisible to the
   * reference walk that builds the dependency edges, so a host rebuilding that
   * resource cannot know this caller is holding it. Recording is what makes the
   * host fall back to rebuilding the whole context instead of silently leaving
   * a holder pointing at a dead instance.
   *
   * A resolution taken after initialization is not recorded: it re-resolves per
   * dispatch, so there is nothing to hold and nothing to invalidate.
   *
   * Prefer an `x-telo-ref` slot, which declares the edge and costs the caller
   * nothing at run time — the kernel injects the live instance before `init()`.
   * This is for the case a slot cannot express, and its cost is that the
   * resource it names can no longer be rebuilt on its own.
   *
   * `declaredBy` is for the one caller that has a declared slot behind it and
   * only wants the lookup: the SDK's own `!ref` resolution, for a reference that
   * reached a controller as a raw sentinel instead of being injected. Passing
   * the resolved ref suppresses the record, because the edge is in the manifest
   * already. There is deliberately no second METHOD for this — a public door
   * whose documentation asks you not to use it is one that gets used.
   */
  getInstance(name: string, declaredBy?: { kind: string; name: string }): unknown;
  getInvocable<TInput = Record<string, any>, TOutput = any>(
    name: string,
  ): Invocable<TInput, TOutput>;
  resolveKind(kind: string): string;
  runTargets(ctx?: InvokeContext): Promise<void>;
}
