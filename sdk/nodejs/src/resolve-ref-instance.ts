import type { ModuleContext } from "./module-context.js";
import type { KindRef } from "./ref.js";
import type { ResourceInstance } from "./resource-instance.js";
import { RuntimeError } from "./types.js";

/** The slice of `ResourceContext` needed to resolve a reference. */
export interface RefResolveContext {
  readonly moduleContext: ModuleContext;
  /**
   * Resolve a bare name with the caller's own precedence — scope-local first,
   * enclosing module as the fallback. Optional: a caller holding only a
   * `{ moduleContext }` slice has no scope to prefer, and falls back to the
   * module. Supplying it is what lets a `with:`-scoped resource reference a
   * scoped sibling, and keeps `!ref` agreeing with the CEL `resources` layering
   * about what a name means inside a scope.
   */
  resolveLocalInstance?(name: string): ResourceInstance | undefined;
}

/**
 * Resolve a `!ref` config field to a live instance of `T`. Controllers reach
 * this as `ctx.resolveRef(value, guard, describe, expects)`; the standalone form
 * is for callers holding only a `{ moduleContext }` slice rather than a full
 * `ResourceContext`.
 *
 * Phase 5 injection normally replaces the slot with the live `ResourceInstance`
 * before `init()` — local and cross-module refs alike, since injection resolves
 * an aliased ref through the import's export table (and defers, rather than
 * leaving a raw ref, when the import hasn't published its exports yet). So the
 * common path here is the guard short-circuit.
 *
 * A raw {@link KindRef} still reaches a controller where injection does not
 * reach the slot: a kind whose definition yields no field map, or a ref the
 * controller obtained itself via `ctx.ensureKindRef`. Both are gaps worth
 * closing in the kernel — until they are, both shapes must be accepted here, and
 * an aliased ref routes through the import's exported scope because a bare local
 * lookup would miss it.
 *
 * `guard` decides what counts as the right kind of instance — a duck-type check
 * on the methods the caller will actually invoke, so a mis-wired ref fails with a
 * clear message here rather than as `undefined is not a function` later.
 * `describe` labels the owning resource and slot; `expects` names the contract
 * the slot wants — the slot's own `x-telo-ref` string (`Cache.Store`) — so
 * the message says what was missing, not just that something was.
 *
 * @example
 * const store = resolveRefInstance(
 *   this.resource.store, this.ctx, isKvStore,
 *   () => `Idempotency.Once "${name}": 'store'`, "KvStore.Store",
 * );
 */
export function resolveRefInstance<T>(
  value: unknown,
  ctx: RefResolveContext,
  guard: (candidate: unknown) => candidate is T,
  describe: () => string,
  expects?: string,
): T {
  // Phase-5-injected: already the instance.
  if (guard(value)) return value;

  const target = expects ? `resource satisfying \`${expects}\`` : "resource";
  if (value === undefined || value === null) {
    throw new RuntimeError("ERR_REF_REQUIRED", `${describe()} is required — reference a ${target}.`);
  }

  const ref = value as Partial<KindRef<T>>;
  if (typeof ref.name !== "string") {
    throw new RuntimeError(
      "ERR_REF_UNRESOLVED",
      `${describe()} must be a \`!ref\` to a ${target}.`,
    );
  }

  // `Self` names the declaring library's own scope, so it resolves locally —
  // it is an alias that crosses no import boundary.
  const instance =
    ref.alias && ref.alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name)
      : (ctx.resolveLocalInstance?.(ref.name) ?? ctx.moduleContext.getInstance(ref.name));

  if (!guard(instance)) {
    const label = ref.alias ? `${ref.alias}.${ref.name}` : ref.name;
    throw new RuntimeError(
      "ERR_REF_UNRESOLVED",
      `${describe()} reference '${label}' did not resolve to a ${target}` +
        `${instance === undefined ? " (nothing is registered under that name)" : ""}.`,
    );
  }
  return instance;
}
