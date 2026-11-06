/**
 * What a rule binding holds in place of a member it could not bind — a
 * reference naming nothing loaded, a library's kind-only input — and which bound
 * values are declarations the binder resolved. A failure is a mark in the bound
 * value rather than a refusal of the whole binding, so it is judged only where a
 * condition reads that member (`findDynamicRead`), the way an expression in an
 * unread member is.
 *
 * Browser-safe: no Node built-ins.
 */
import type { PeerBindingFailure } from "./peer-binding.js";

/** The key a mark is held under: not a CEL identifier, so no condition names it. */
const UNBOUND_MEMBER = "@telo:unbound";

/** A member the binder could not bind, carrying why. */
export function unboundMember(failure: PeerBindingFailure): Record<string, unknown> {
  return { [UNBOUND_MEMBER]: failure };
}

/** The failure a bound value holds in place of a member, or `undefined`. */
export function unboundFailureOf(value: unknown): PeerBindingFailure | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ((value as Record<string, unknown>)[UNBOUND_MEMBER] as PeerBindingFailure | undefined)
    : undefined;
}

const boundDeclarations = new WeakSet<object>();
const comparableTags = new WeakSet<object>();

/** Records `declaration` as one the binder resolved a reference to, and each
 *  value in it `comparable` says compares as written (a `!module-path`). */
export function markBoundDeclaration<T extends object>(declaration: T, comparable: (value: unknown) => boolean): T {
  boundDeclarations.add(declaration);
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (comparable(value)) {
      comparableTags.add(value as object);
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) walk(child);
  };
  walk(declaration);
  return declaration;
}

/** Whether a tagged value inside a resolved declaration compares as written. */
export function isComparableTag(value: unknown): boolean {
  return !!value && typeof value === "object" && comparableTags.has(value as object);
}

/** Whether `value` is a declaration the binder resolved a reference to: read
 *  whole, it is read with everything it holds. */
export function isBoundDeclaration(value: unknown): boolean {
  return !!value && typeof value === "object" && boundDeclarations.has(value as object);
}
