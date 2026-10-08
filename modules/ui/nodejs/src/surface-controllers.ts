import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import {
  dialogSpec,
  drawerSpec,
  inlineSpec,
  pageSpec,
  panelSpec,
  popoverSpec,
  surfaceSpec,
  type SurfaceConfig,
  type SurfaceResource,
  type SurfaceSpec,
} from "./surface-spec.js";

/** A surface kind's controller: its own members filled, then its address and
 *  compact surface. */
const controller = (kind: string, own: (config: SurfaceConfig) => SurfaceSpec) => ({
  async create(resource: SurfaceResource, ctx: ResourceContext): Promise<ResourceInstance> {
    return { provide: () => surfaceSpec(own(resource), resource, ctx, kind) };
  },
});

export const DialogController = controller("Ui.Dialog", dialogSpec);
export const DrawerController = controller("Ui.Drawer", drawerSpec);
export const PopoverController = controller("Ui.Popover", popoverSpec);
export const InlineSurfaceController = controller("Ui.InlineSurface", inlineSpec);
export const PanelController = controller("Ui.Panel", panelSpec);
export const PageSurfaceController = controller("Ui.PageSurface", pageSpec);
