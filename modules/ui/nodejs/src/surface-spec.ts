import { RuntimeError, type ResourceContext, type RuntimeResource } from "@telorun/sdk";

/** Where a piece of interface appears, as a renderer receives it. */
export type SurfaceSpec = { type: string } & Record<string, unknown>;

export interface SurfaceInstance {
  provide(): Promise<SurfaceSpec>;
}

export function isSurface(candidate: unknown): candidate is SurfaceInstance {
  return typeof (candidate as SurfaceInstance | null)?.provide === "function";
}

/** What a surface kind may be declared with. A member holding nothing is one
 *  left out. */
export interface SurfaceConfig {
  size?: string;
  side?: string;
  align?: string;
  modal?: boolean;
  dismiss?: Record<string, boolean | undefined>;
  address?: { name: string };
  compact?: unknown;
}

export type SurfaceResource = RuntimeResource & SurfaceConfig;

/** Every way of closing is on unless switched off. */
const switches = (declared: SurfaceConfig["dismiss"], names: string[]) =>
  Object.fromEntries(names.map((name) => [name, declared?.[name] ?? true]));

export const dialogSpec = (config: SurfaceConfig = {}): SurfaceSpec => ({
  type: "dialog",
  size: config.size ?? "medium",
  modal: config.modal ?? true,
  dismiss: switches(config.dismiss, ["escape", "outside", "closeButton"]),
});

export const drawerSpec = (config: SurfaceConfig = {}): SurfaceSpec => ({
  type: "drawer",
  side: config.side ?? "end",
  size: config.size ?? "medium",
  modal: config.modal ?? true,
  dismiss: switches(config.dismiss, ["escape", "outside", "closeButton"]),
});

export const popoverSpec = (config: SurfaceConfig = {}): SurfaceSpec => ({
  type: "popover",
  side: config.side ?? "bottom",
  align: config.align ?? "start",
  dismiss: switches(config.dismiss, ["escape", "outside"]),
});

export const inlineSpec = (): SurfaceSpec => ({ type: "inline" });

export const panelSpec = (config: SurfaceConfig = {}): SurfaceSpec => ({
  type: "panel",
  side: config.side ?? "end",
  size: config.size ?? "medium",
  dismiss: switches(config.dismiss, ["escape", "closeButton"]),
});

export const pageSpec = (): SurfaceSpec => ({ type: "page" });

/** A surface's own members with its address and the surface standing in for it
 *  on a narrow viewport, which may declare neither of the two itself. */
export async function surfaceSpec(
  own: SurfaceSpec,
  resource: SurfaceResource,
  ctx: ResourceContext,
  kind: string,
): Promise<SurfaceSpec> {
  const owner = `${kind} '${resource.metadata.name}'`;
  const spec: SurfaceSpec = { ...own };
  if (resource.address !== undefined) spec.address = { name: resource.address.name };
  if (resource.compact === undefined) return spec;
  const compact = await ctx
    .resolveRef(resource.compact, isSurface, () => `'compact' of ${owner}`, "Ui.Dialog or Ui.Drawer")
    .provide();
  if (compact.address !== undefined) {
    throw new RuntimeError(
      "ERR_UI_SURFACE_COMPACT_ADDRESSED",
      `${owner}: names a compact surface that declares an address. The address of a compact surface is the one of the surface it stands in for: remove 'address' from it.`,
    );
  }
  if (compact.compact !== undefined) {
    throw new RuntimeError(
      "ERR_UI_SURFACE_COMPACT_NESTED",
      `${owner}: names a compact surface that declares a compact surface of its own. Only one level applies: remove 'compact' from it.`,
    );
  }
  return { ...spec, compact };
}
