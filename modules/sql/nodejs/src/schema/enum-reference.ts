import type { ResourceContext } from "@telorun/sdk";
import type { DeclaredEnum } from "./declared-schema.js";

/**
 * Resolves a column's `type:` slot when it holds a `!ref` to a declared enum.
 *
 * The mirror of `tableReferenceResolver`: the slot is `use: schema`, a
 * declaration read the kernel never injects, and the reference is resolved to
 * the target's DECLARATION, which carries everything a column needs from it —
 * the physical name and the values — whether or not the target has been
 * constructed.
 */
export type ColumnEnumResolver = (value: unknown, column: string) => DeclaredEnum | undefined;

interface EnumRef {
  readonly name?: unknown;
  readonly alias?: unknown;
}

function asRef(value: unknown): { name: string; alias?: string } | undefined {
  const ref = value as EnumRef | null;
  if (!ref || typeof ref !== "object" || typeof ref.name !== "string") return undefined;
  return { name: ref.name, alias: typeof ref.alias === "string" ? ref.alias : undefined };
}

function readDeclaration(source: Record<string, unknown>, where: string): DeclaredEnum {
  const typeName = source.typeName;
  const values = source.values;
  if (typeof typeName !== "string") {
    throw new Error(`${where} names a resource that declares no 'typeName'.`);
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${where} names a resource whose 'values' are not a list of strings.`);
  }
  return {
    typeName,
    values: values as string[],
    baseType: typeof source.baseType === "string" ? source.baseType : undefined,
  };
}

export function enumReferenceResolver(
  ctx: ResourceContext,
  enumKind: string,
  table: string,
): ColumnEnumResolver {
  return (value, column) => {
    // A storage class from the backend's own vocabulary. The union slot admits
    // both, and which one is written is the whole distinction.
    if (typeof value === "string") return undefined;
    const where = `${enumKind.replace(/\.Enum$/, ".Table")} '${table}': column '${column}': 'type'`;

    const ref = asRef(value);
    if (ref) {
      const declared = ctx.resolveDeclaredManifest?.(ref.name, ref.alias);
      if (!declared) {
        throw new Error(
          `${where} references '${ref.name}', which resolves to no declared resource. A column ` +
            `reads its enum from that resource's DECLARATION, so the type it names has to be ` +
            `declared in a scope this one can see.`,
        );
      }
      // Constrained statically by `x-telo-ref`, so this is a backstop — but one
      // that must not accept the wrong kind, since any resource carrying a
      // `typeName` field would otherwise put a wrong identifier into DDL.
      if (declared.kind !== enumKind) {
        throw new Error(
          `${where} references '${ref.name}', which is a ${declared.kind}, not a ${enumKind}.`,
        );
      }
      return readDeclaration(declared as Record<string, unknown>, where);
    }

    throw new Error(`${where} is neither a storage class nor a reference to a ${enumKind}.`);
  };
}
