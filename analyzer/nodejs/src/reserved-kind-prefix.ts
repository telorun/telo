/**
 * The two names no module and no import may take. `Telo.<Kind>` names a built-in
 * kind and `Self.<Kind>` the declaring module's own, and both resolve through
 * the alias table every other prefix does — so a module named `Telo`, or an
 * import aliased `Self`, would silently replace them: a library named `Telo`
 * declaring `Application` overwrote the built-in definition while its old schema
 * stayed compiled.
 *
 * One rule, read by `telo check` (`KIND_PREFIX_RESERVED`) — the loader for an
 * import's alias and its target's name, the identifier pass for the entry's own
 * module — and by both kernels (`ERR_KIND_PREFIX_RESERVED`), whose messages are
 * these.
 */

export const RESERVED_KIND_PREFIXES: readonly string[] = ["Telo", "Self"];

export function isReservedKindPrefix(name: unknown): boolean {
  return typeof name === "string" && RESERVED_KIND_PREFIXES.includes(name);
}

const WHY =
  "`Telo.<Kind>` names a built-in kind and `Self.<Kind>` the declaring module's own";

/** A module doc's own `metadata.name`. */
export function reservedModuleNameMessage(name: string): string {
  return `A module may not be named '${name}': ${WHY}, so its kinds would replace them. Rename the module.`;
}

/** An `imports:` key. */
export function reservedImportAliasMessage(alias: string): string {
  return `An import may not be aliased '${alias}': ${WHY}, so this import would replace them. Choose another alias.`;
}

/** An import whose target library is named with a reserved prefix. */
export function reservedLibraryNameMessage(source: string, name: string): string {
  return (
    `'${source}' is a Telo.Library named '${name}': ${WHY}, so its kinds would replace them. ` +
    `It cannot be imported until it is renamed.`
  );
}
