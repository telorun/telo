import type { ResourceContext } from "@telorun/sdk";
import type { TableReferenceResolver } from "./normalize-table.js";

/** A `!ref` as the slot holds it: rewritten from the YAML tag to
 *  `{ kind, name, alias? }` at load, and never injected, since the slot is a
 *  declaration read. */
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
 * The slot is `use: schema`, a declaration read: the kernel never injects an
 * instance there and orders nothing on it, so a tree table (which references
 * ITSELF) and a mutual pair are creatable, as they are on an engine that emits
 * keys after every table. The reference is resolved to the target's
 * DECLARATION, which carries the one thing a foreign key needs from it — the
 * physical name — whether or not the target has been constructed.
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

    throw new Error(`${where} is not a reference to a ${kind}.`);
  };
}
