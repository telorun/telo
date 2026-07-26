import type { ModuleContext } from "./module-context.js";

/** The slice of `ResourceContext` needed to resolve a reference. */
export interface RefResolveContext {
  readonly moduleContext: ModuleContext;
}

/** A reference the kernel left unresolved: the target's name, plus the import
 *  alias when it crosses a library boundary. */
interface ResourceRef {
  name: string;
  alias?: string;
}

/**
 * Resolve a `!ref` config field to a live instance of `T`.
 *
 * **Why every controller needs this.** A reference is normally replaced with the
 * live `ResourceInstance` during Phase 5 injection, so a controller can just use
 * the field. That does not happen for a ref that crosses an import boundary —
 * a store, connection, or model resolved through another library's exports
 * arrives as the raw `{ name, alias }` shape instead. So a controller must handle
 * BOTH forms, and the alias form must route through the import's exported scope
 * rather than a bare local lookup, which would miss it entirely.
 *
 * Every controller with a provider-shaped dependency pays this cost, and each one
 * had reimplemented it. One implementation means one place to simplify when the
 * kernel closes that gap, and one error message shape for authors.
 *
 * `guard` decides what counts as the right kind of instance — a duck-type check
 * on the methods the caller will actually invoke, so a mis-wired ref fails with a
 * clear message here rather than as `undefined is not a function` later.
 * `describe` labels the owning resource in that message.
 *
 * @example
 * const store = resolveRefInstance<KvStore>(
 *   this.resource.store, this.ctx, isKvStore,
 *   () => `Idempotency.Once "${name}": 'store'`,
 * );
 */
export function resolveRefInstance<T>(
  value: unknown,
  ctx: RefResolveContext,
  guard: (candidate: unknown) => candidate is T,
  describe: () => string,
): T {
  // Phase-5-injected: already the instance.
  if (guard(value)) return value;

  const ref = value as ResourceRef | undefined;
  if (!ref || typeof ref.name !== "string") {
    throw new Error(`${describe()} must reference a resource.`);
  }

  // `Self` names the declaring library's own scope, so it resolves locally —
  // it is an alias that crosses no import boundary.
  const instance =
    ref.alias && ref.alias !== "Self"
      ? ctx.moduleContext.resolveImportedInstance(ref.alias, ref.name)
      : ctx.moduleContext.getInstance(ref.name);

  if (!guard(instance)) {
    const label = ref.alias ? `${ref.alias}.${ref.name}` : ref.name;
    throw new Error(
      `${describe()} reference '${label}' did not resolve to a usable instance` +
        `${instance === undefined ? " (nothing is registered under that name)" : ""}.`,
    );
  }
  return instance;
}
