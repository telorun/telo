import type { ResourceManifest } from "@telorun/sdk";

/**
 * Instance → the manifest it was DECLARED with, recorded at `create()` — the
 * kernel's single instance-production site, beside where the handle is minted
 * and the contract is bound.
 *
 * A contract typed from a referenced declaration
 * (`x-telo-schema-projection-from`) is bound AFTER Phase-5 injection has already
 * replaced the reference in the slot with the live instance, so the reference is
 * gone by the time the contract needs it. This is what recovers the declaration
 * behind it — and recovering it is what lets the kernel enforce exactly the
 * schema the analyzer checked, rather than a reopened one.
 *
 * Its own module rather than a second table in `resource-handle.ts`, which
 * guards an exact export list precisely so a new direction gets looked at: the
 * rule there is that a HANDLE must never become someone else's live instance,
 * and this is the unrelated instance→declaration direction. Weak and one-way —
 * a manifest is obtainable FROM an instance, never an instance from a manifest —
 * so nothing here extends a lifetime or hands out a reference to live state.
 */
const declarations = new WeakMap<object, ResourceManifest>();

/** Record what a live instance was declared with. First record wins, matching
 *  the handle rule: a `base:` child IS its parent instance, and the parent's
 *  declaration is the one that produced it. */
export function recordInstanceDeclaration(instance: object, manifest: ResourceManifest): void {
  if (!declarations.has(instance)) declarations.set(instance, manifest);
}

/** The manifest a live instance was declared with, if it is one of ours. */
export function declarationOfInstance(instance: unknown): ResourceManifest | undefined {
  return instance && typeof instance === "object"
    ? declarations.get(instance as object)
    : undefined;
}
