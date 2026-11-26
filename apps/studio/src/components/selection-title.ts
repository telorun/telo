import { isModuleRootKind } from "../application-adapter";
import { BOOT_FIELD, bootEntries } from "./views/topology/boot-targets";

const BOOT_POINTER = new RegExp(`^/${BOOT_FIELD}/(\\d+)(/inputs)?$`);

/**
 * The detail header's first words for a selection: a boot step reads as one
 * ("Boot step 1 · Console.writeLine · arguments"); any other pointer keeps its
 * JSON Pointer.
 */
export function selectionTitle(
  resource: { kind: string; name: string; fields: Record<string, unknown> },
  pointer: string,
): string {
  if (!pointer) return resource.name;
  const boot = isModuleRootKind(resource.kind) ? BOOT_POINTER.exec(pointer) : null;
  if (!boot) return `${resource.name} • ${pointer}`;
  const index = Number(boot[1]);
  const target = bootEntries(resource.fields[BOOT_FIELD]).find((e) => e.index === index)?.target;
  return [`Boot step ${index + 1}`, target, boot[2] ? "arguments" : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
}
