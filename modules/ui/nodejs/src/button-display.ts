import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AssetRef } from "./browser-entry-assets.js";
import type { AssetFile } from "./composite.js";
import { servedIconFormat } from "./icon-format.js";
import { isIcon, type IconFile } from "./icon.js";

/** How a button is drawn, before an icon's file is addressed: by its text, or by a glyph. */
export type ButtonDisplay = { type: "text" } | { type: "icon"; icon: IconFile | null; label: "shown" | "hidden" };

export interface ButtonDisplayInstance {
  provide(): Promise<ButtonDisplay>;
}

export const isButtonDisplay = (candidate: unknown): candidate is ButtonDisplayInstance =>
  typeof (candidate as ButtonDisplayInstance | null)?.provide === "function";

export const TextButtonController = {
  async create(): Promise<ResourceInstance> {
    return { provide: async (): Promise<ButtonDisplay> => ({ type: "text" }) };
  },
};

type IconButtonResource = RuntimeResource & { icon?: unknown; label?: "shown" | "hidden" | null };

export const IconButtonController = {
  async create(resource: IconButtonResource, ctx: ResourceContext): Promise<ResourceInstance> {
    return {
      provide: async (): Promise<ButtonDisplay> => ({
        type: "icon",
        icon:
          resource.icon == null
            ? null
            : await ctx.resolveRef(resource.icon, isIcon, () => `'icon' of Ui.IconButton '${resource.metadata.name}'`, "Ui.Icon").provide(),
        label: resource.label ?? "hidden",
      }),
    };
  },
};

/** How a button is drawn on the wire: an icon's file addressed, not named by path. */
export type ButtonSpec = { type: "text" } | { type: "icon"; icon: AssetRef | null; label: "shown" | "hidden" };

/** A button's display as a renderer receives it, with the icon file it is drawn from, to be served. */
export async function buttonSpec(display: ButtonDisplay, owner: string, where: string): Promise<{ spec: ButtonSpec; assets: AssetFile[] }> {
  if (display.type === "text" || display.icon === null) return { spec: display as ButtonSpec, assets: [] };
  const { file } = display.icon;
  const bytes = await readFile(file);
  const format = servedIconFormat(bytes, file, owner, where);
  const slug = basename(file).replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const asset: AssetFile = {
    digest: createHash("sha256").update(bytes).digest("hex"),
    name: `${slug || "icon"}.${format.extension}`,
    file,
    mediaType: format.mediaType,
  };
  return { spec: { type: "icon", icon: { digest: asset.digest, name: asset.name }, label: display.label }, assets: [asset] };
}

/** The display a written `ButtonDisplay` reference provides. */
export const providedButton = (written: unknown, ctx: ResourceContext, describe: () => string): Promise<ButtonDisplay> =>
  ctx.resolveRef(written, isButtonDisplay, describe, "Ui.ButtonDisplay").provide();
