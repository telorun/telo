export const MODULE_KINDS = ["Kernel.Application", "Kernel.Library"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export function isModuleKind(kind: string | undefined): kind is ModuleKind {
  return kind === "Kernel.Application" || kind === "Kernel.Library";
}
