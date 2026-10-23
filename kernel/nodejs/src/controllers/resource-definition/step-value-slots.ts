import { reachSites, stepValueSlotPaths } from "@telorun/analyzer";

/**
 * Where a declaration holds its pure steps' `value:` — the slots a pass
 * resolving `self` before the step engine runs must leave compiled, since the
 * engine reads a NUMBER it finds there as one the author wrote.
 *
 * The declaration's own step bodies, and those of every resource declared in one
 * of its scopes (`with:`), each read by the analyzer's step-body reader over the
 * schema of the kind that owns it. Paths are spelled as the body walkers spell
 * theirs (`with[0].steps[1].value`).
 */
export function stepValueSlots(
  declaration: Record<string, unknown>,
  schema: Record<string, any>,
  schemaOfKind: (kind: string) => Record<string, any> | undefined,
): string[] {
  const slots = stepValueSlotPaths(declaration, schema);
  for (const site of reachSites(schema, declaration)) {
    if (site.scopes.length === 0 || !Array.isArray(site.data)) continue;
    const at = pathOfKeys(site.keys);
    site.data.forEach((member, i) => {
      if (member === null || typeof member !== "object") return;
      const kind = (member as { kind?: unknown }).kind;
      const memberSchema = typeof kind === "string" ? schemaOfKind(kind) : undefined;
      if (!memberSchema) return;
      for (const slot of stepValueSlots(
        member as Record<string, unknown>,
        memberSchema,
        schemaOfKind,
      )) {
        slots.push(`${at}[${i}].${slot}`);
      }
    });
  }
  return slots;
}

/** True when `path` is one of `slots` or lies beneath one. */
export function isWithinSlot(slots: readonly string[], path: string): boolean {
  return slots.some(
    (slot) => path === slot || path.startsWith(`${slot}.`) || path.startsWith(`${slot}[`),
  );
}

function pathOfKeys(keys: readonly (string | number)[]): string {
  let path = "";
  for (const key of keys) {
    if (typeof key === "number") path += `[${key}]`;
    else path += path ? `.${key}` : key;
  }
  return path;
}
