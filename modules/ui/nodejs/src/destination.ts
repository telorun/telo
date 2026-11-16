import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { AddressSpec } from "./address-expansion.js";
import { addressSpec, type AddressConfig } from "./address-spec.js";
import type { Binding } from "./row-binding.js";
import { dialogSpec, isSurface, type SurfaceSpec } from "./surface-spec.js";

/** Where a press goes, as a renderer receives it: one branch per kind. */
export type DestinationSpec =
  | { type: "navigate"; href: AddressSpec }
  | { type: "openPage"; href: AddressSpec; surface: SurfaceSpec; keepsSurface: boolean };

export interface DestinationInstance {
  provide(): Promise<DestinationSpec>;
}

export function isDestination(candidate: unknown): candidate is DestinationInstance {
  return typeof (candidate as DestinationInstance | null)?.provide === "function";
}

/** The spec of the destination a `to` slot holds. */
export function destinationAt(value: unknown, ctx: ResourceContext, describe: () => string): Promise<DestinationSpec> {
  return ctx.resolveRef(value, isDestination, describe, "Ui.Destination").provide();
}

type NavigateResource = RuntimeResource & { href: AddressConfig };

type OpenPageResource = RuntimeResource & {
  page: unknown;
  pathParams?: Record<string, Binding> | null;
  queryParams?: Record<string, Binding> | null;
  surface?: unknown;
};

export const NavigateController = {
  async create(resource: NavigateResource, ctx: ResourceContext): Promise<ResourceInstance & DestinationInstance> {
    const owner = `Ui.Navigate '${resource.metadata.name}'`;
    return { provide: async () => ({ type: "navigate", href: addressSpec(resource.href, ctx, `${owner} href`) }) };
  },
};

/**
 * A page opened over the current one: its own address, and the surface it
 * opens in — the one written, or, when none is, a dialog with its defaults and
 * `keepsSurface`, so a press inside an opened page keeps that page's surface
 * and a renderer reads no default of its own.
 */
export const OpenPageController = {
  async create(resource: OpenPageResource, ctx: ResourceContext): Promise<ResourceInstance & DestinationInstance> {
    const owner = `Ui.OpenPage '${resource.metadata.name}'`;
    return {
      provide: async () => {
        const href = addressSpec(
          { path: resource.page, pathParams: resource.pathParams, queryParams: resource.queryParams },
          ctx,
          `${owner} page`,
        );
        if (resource.surface == null) return { type: "openPage", href, surface: dialogSpec(), keepsSurface: true };
        const surface = await ctx
          .resolveRef(resource.surface, isSurface, () => `'surface' of ${owner}`, "Ui.ViewportOverlay")
          .provide();
        return { type: "openPage", href, surface, keepsSurface: false };
      },
    };
  },
};
