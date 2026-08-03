import { RuntimeEvent } from "./runtime-event.js";

export interface ControllerContext {
  on(event: string, handler: (event: RuntimeEvent) => void | Promise<void>): void;
  emit(event: string, payload?: any, metadata?: Record<string, any>): void;
  acquireHold(reason?: string): () => void;
  requestExit(code: number): void;
  expandValue(value: any, context: Record<string, any>): any;
  /**
   * Extend a CEL scope with a kind's named `bindings:` map — the field a schema
   * points at with `x-telo-bindings-from`.
   *
   * Each binding is evaluated **lazily and at most once** per returned scope, in
   * the scope itself, so one binding reads another with no declared order and a
   * binding nothing reads is never evaluated. That equivalence with inlining the
   * expression at each use site is the point: a binding is a refactoring, not a
   * change in what runs.
   *
   * A name already in scope is skipped — the passed `scope` and the ambient
   * variables alike, so a scope variable always wins. That bounds a collision
   * the analyzer's `BINDING_NAME_RESERVED` check could not foresee to a binding
   * that is merely unreachable. A binding that reaches itself throws
   * `ERR_BINDING_CYCLE`.
   *
   * **Pass the returned scope to `expandValue` by identity.** Bindings ride on
   * it as accessor properties, so copying it (`{ ...scope, extra }` — the usual
   * way to add a variable) evaluates every binding at the copy, losing both the
   * laziness and the guarantee that an unread binding never runs. Build the base
   * scope first, extend it last.
   */
  bindScope(
    bindings: Record<string, unknown> | undefined,
    scope: Record<string, unknown>,
  ): Record<string, unknown>;
}
