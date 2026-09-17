import type { AliasResolver } from "./alias-resolver.js";
import type { DefinitionRegistry } from "./definition-registry.js";

/**
 * "Can this kind be written as a resource?" — asked in one place.
 *
 * `Telo.Abstract` is the non-instantiable flavor of a base kind: it names a
 * contract for `x-telo-ref` slots and has no controller to construct, so the
 * kernel refuses one at `create()`. Four surfaces have to agree with that —
 * the checker, the "did you mean" list, completion, and the editor's
 * create-and-link picker — and each one that answers it independently is a
 * surface free to offer a kind the runtime will reject, which is exactly what
 * the create picker did with `Telo.Invocable`.
 */
export function isInstantiableDefinition(def: { kind?: string } | undefined): boolean {
  return def != null && def.kind !== "Telo.Abstract";
}

/**
 * The alias-form kinds an author could write in place of an abstract one: every
 * instantiable definition that extends it, spelled with the aliases the scope
 * that wrote the declaration actually has.
 *
 * Alias form, never canonical. `postgres.Connection` is what the registry is
 * keyed on and is not something anyone can type, so a message listing it sends
 * the reader to a spelling that resolves nowhere.
 *
 * The subtree is walked, not just its first level: an abstract extending an
 * abstract (`Telo.Runnable` under `Telo.Executable`) contributes its own
 * implementations rather than itself.
 */
export function userFacingImplementationsOf(
  kind: string,
  aliases: Pick<AliasResolver, "aliasesFor">,
  defs: Pick<DefinitionRegistry, "getByExtends">,
): string[] {
  const out = new Set<string>();
  for (const def of defs.getByExtends(kind)) {
    if (!isInstantiableDefinition(def)) continue;
    const module = (def.metadata as { module?: string } | undefined)?.module;
    const name = def.metadata?.name as string | undefined;
    if (!module || !name) continue;
    for (const alias of aliases.aliasesFor(module)) out.add(`${alias}.${name}`);
  }
  return [...out].sort();
}

/**
 * The sentence every abstract-instantiation site reports, so the wording does
 * not depend on which shape the declaration was written in.
 *
 * Worded exactly as the kernel's own refusal is (`kernel.ts`), because the
 * static check exists to predict that refusal: a reader who hits one and then
 * the other must not have to work out that they are the same fact.
 */
export function abstractKindMessage(kind: string, implementations: string[]): string {
  const hint = implementations.length
    ? `instantiate a concrete implementation: ${implementations.join(", ")}`
    : "no concrete implementations are registered — import a module that provides one";
  return `Kind '${kind}' is abstract and cannot be instantiated directly; ${hint}.`;
}
