import type { NamedContractShape } from "@telorun/analyzer";

/** What reading a definition's named contract shape needs from the kernel. */
export interface ContractShapeHost {
  resolveNamedContractShape?(
    typeField: unknown,
    holder: Record<string, any>,
  ): NamedContractShape | undefined;
}

/**
 * Reads the named shape a definition's `inputType` / `outputType` names, for
 * the registration-time check of the annotations that shape carries: resolved
 * as `telo check` resolves it — across the definition's imports, with the
 * shape's `extends` parents folded — from the DECLARATIONS the load holds.
 *
 * Not from created instances or an import's export table: a shape registers
 * its schema when it is created and an import exports only once initialized,
 * either of which may be after the kind naming the shape. One that resolves to
 * nothing is not judged — a contract that names nothing is refused at dispatch.
 */
export function declaredContractShape(
  host: ContractShapeHost,
  definition: Record<string, any>,
): (typeField: unknown) => NamedContractShape | undefined {
  return (typeField) => host.resolveNamedContractShape?.(typeField, definition);
}
