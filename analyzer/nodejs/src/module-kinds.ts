export const MODULE_KINDS = ["Telo.Application", "Telo.Library"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];

export function isModuleKind(kind: string | undefined): kind is ModuleKind {
  return kind === "Telo.Application" || kind === "Telo.Library";
}
