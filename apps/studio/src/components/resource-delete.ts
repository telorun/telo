import { isModuleRootKind } from "../application-adapter";

/**
 * Whether Delete may be offered for a selection: a whole resource only — never
 * a place inside one (a pointer) and never the module's root document, which is
 * the module itself.
 */
export function canDeleteSelection(resource: { kind: string }, pointer: string): boolean {
  return !pointer && !isModuleRootKind(resource.kind);
}

/** The Delete key's rule: the pointer counts only when the selection is inside this resource. */
export function canDeleteResourceByKey(
  resource: { kind: string; name: string },
  selection: { resource: { kind: string; name: string }; pointer: string } | null,
): boolean {
  const inside =
    selection?.resource.kind === resource.kind && selection.resource.name === resource.name;
  return canDeleteSelection(resource, inside ? selection.pointer : "");
}
