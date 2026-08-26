/**
 * The name a newly-declared resource is offered.
 *
 * One rule, because two surfaces now name resources — creating one to fill an
 * empty ref slot, and extracting one out of an inline declaration — and a
 * second spelling would offer `crudResource` in one and `CrudResource` in the
 * other for the same kind. Case follows what the name DENOTES: a `Telo.Type`
 * instance names a shape, everything else names a value.
 */
export function resourceNameBase(kind: string, capability: string | undefined): string {
  const kindName = kind.includes(".") ? kind.slice(kind.lastIndexOf(".") + 1) : kind;
  if (capability === "Telo.Type") return kindName;
  return kindName.charAt(0).toLowerCase() + kindName.slice(1);
}

/** The base name, suffixed until it collides with nothing already declared. */
export function suggestedResourceName(
  kind: string,
  capability: string | undefined,
  taken: Iterable<string>,
): string {
  const base = resourceNameBase(kind, capability);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}
