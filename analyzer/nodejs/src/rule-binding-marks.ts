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

const identities = new WeakMap<object, string>();

/**
 * Records which declaration `value` binds — a key of the module declaring it and
 * its name, which a rule compares instead of what the value holds: two bound
 * declarations are equal exactly when they are the same declaration.
 */
export function markDeclarationIdentity<T extends object>(value: T, identity: string): T {
  identities.set(value, identity);
  return value;
}

/** The identity key of a declaration `module` declares as `name`. */
export function declarationKey(module: unknown, name: unknown): string {
  return JSON.stringify([typeof module === "string" ? module : "", String(name ?? "")]);
}

/** The identity key of a top-level declaration, read off its own metadata. */
export function manifestDeclarationKey(declaration: { metadata?: unknown }): string {
  const metadata = declaration.metadata as { module?: unknown; name?: unknown } | undefined;
  return declarationKey(metadata?.module, metadata?.name);
}

/** The declaration `value` binds, by identity key, or `undefined` for a value
 *  that is no bound declaration. */
export function declarationIdentityOf(value: unknown): string | undefined {
  return value && typeof value === "object" ? identities.get(value as object) : undefined;
}
