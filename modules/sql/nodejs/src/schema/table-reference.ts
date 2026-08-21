import type { ResourceContext } from "@telorun/sdk";
import type { TableReferenceResolver } from "./normalize-table.js";

/** A `!ref` as it reaches a controller when Phase-5 injection has not replaced
 *  it: rewritten from the YAML tag to `{ kind, name, alias? }` at load. */
interface TableRef {
  readonly name?: unknown;
  readonly alias?: unknown;
}

function asRef(value: unknown): { name: string; alias?: string } | undefined {
  const ref = value as TableRef | null;
  if (!ref || typeof ref !== "object" || typeof ref.name !== "string") return undefined;
  return { name: ref.name, alias: typeof ref.alias === "string" ? ref.alias : undefined };
}

/**
 * Resolves a `references.table` slot to the referenced table's physical name.
 *
 * **BOTH shapes arrive, and which one is a race.** A table reads this slot while
 * it is being CREATED, and Phase-5 injection replaces a reference only when the
 * target is already registered — a local ref naming nothing pending is left
 * exactly as written. So the same manifest hands over a live instance on one
 * pass of the init loop and the raw `{ kind, name }` on another, and reading
 * only the instance is what made every cross-table foreign key fail outright.
 *
 * The reference is resolved to the target's DECLARATION, which carries the one
 * thing a foreign key needs from it — the physical name — and carries it whether
 * or not the target has been constructed. That is also why the slot stays
 * `use: schema` and registers no ordering edge: nothing here requires the
 * referenced table to exist first, and an edge would make a tree table (which
 * references ITSELF) and a mutual pair into init cycles, though both are
 * perfectly creatable on an engine that emits keys after every table.
 *
 * A plain string is accepted for an internal caller that already holds a name;
 * an author cannot write one, since a ref slot rejects a bare string
 * (`INVALID_REFERENCE_FORM`).
 */
export function tableReferenceResolver(
  ctx: ResourceContext,
  kind: string,
  table: string,
): TableReferenceResolver {
  return (value, fk) => {
    if (typeof value === "string") return value;
    const where = `${kind} '${table}': foreign key '${fk}': 'references.table'`;

    const ref = asRef(value);
    if (ref) {
      const declared = ctx.resolveDeclaredManifest?.(ref.name, ref.alias);
      if (!declared) {
        throw new Error(
          `${where} names '${ref.name}', which resolves to no declared resource. A foreign key ` +
            `reads its target from that resource's DECLARATION, so the table it names has to be ` +
            `declared in a scope this one can see.`,
        );
      }
      // The kind is constrained statically by `x-telo-ref`, so this is a
      // backstop — but one that must not accept the wrong kind, since any
      // resource carrying a `table` field would otherwise put a wrong
      // identifier into DDL.
      if (declared.kind !== kind) {
        throw new Error(`${where} names '${ref.name}', which is a ${declared.kind}, not a ${kind}.`);
      }
      if (typeof declared.table !== "string") {
        throw new Error(`${where} names '${ref.name}', which declares no 'table'.`);
      }
      return declared.table;
    }

    // Injection won the race: the slot holds the live table resource, which
    // reports the same name its declaration carries.
    const injected = (value as { table?: unknown } | null)?.table;
    if (typeof injected === "string") return injected;

    throw new Error(`${where} is not a reference to a ${kind}.`);
  };
}
