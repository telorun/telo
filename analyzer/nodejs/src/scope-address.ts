/**
 * Where a declaration lives: its module, the chain of `x-telo-scope` arrays
 * enclosing it, and its own identity inside the innermost one.
 *
 * A name is unique inside one scope, never across a manifest set: a `with:`
 * member may share its name with a module-level resource (it shadows it inside
 * its scope) and with a member of another scope. The address is what tells them
 * apart, so it is the key every per-declaration fact about a scoped resource is
 * filed under.
 *
 * Browser-safe.
 */
export interface ScopeAddress {
  /** The module that declared it, as the loader stamped it (`metadata.module`);
   *  undefined for a set nothing stamped. A member's is its holder's. */
  readonly module: string | undefined;
  /** The scope declaring it — the holder's own address and the holder's
   *  `x-telo-scope` field (`with`) — or undefined for a module-level declaration. */
  readonly scope: { readonly holder: ScopeAddress; readonly field: string } | undefined;
  /** Its identity inside that scope: the text a reference to it resolves by.
   *  Text rather than a name type, so an identity that is not a plain name
   *  takes the same place. */
  readonly member: string;
  /** Canonical text — two addresses are the same address exactly when their keys
   *  are equal. */
  readonly key: string;
}

/** One scope: the array a holder declares at its `x-telo-scope` field. */
export type ScopeSite = NonNullable<ScopeAddress["scope"]>;

/**
 * The address of `member`, declared at module level in `within` (a module name,
 * or undefined for a set nothing stamped) or inside the scope `within` names.
 */
export function scopeAddress(within: string | undefined | ScopeSite, member: string): ScopeAddress {
  if (within === undefined || typeof within === "string") {
    return { module: within, scope: undefined, member, key: `${within ?? ""}\0${member}` };
  }
  return {
    module: within.holder.module,
    scope: { holder: within.holder, field: within.field },
    member,
    key: `${scopeSiteKey(within)}\0${member}`,
  };
}

/** Canonical text of a scope: its holder's address and the field. Never equal to
 *  an address's key — an address's key has an even number of `\0`-separated
 *  segments, a scope's an odd one. */
export function scopeSiteKey(site: ScopeSite): string {
  return `${site.holder.key}\0${site.field}`;
}
