import type { ResourceInstance, RuntimeResource } from "@telorun/sdk";

/** What every `Ui.Icon` provides: the image file its glyph is drawn from. */
export interface IconFile {
  /** An absolute path on this host. */
  file: string;
}

export interface IconInstance {
  provide(): Promise<IconFile>;
}

export const isIcon = (candidate: unknown): candidate is IconInstance =>
  typeof (candidate as IconInstance | null)?.provide === "function";

export const FileIconController = {
  async create(resource: RuntimeResource & { file: string }): Promise<ResourceInstance> {
    return { provide: async (): Promise<IconFile> => ({ file: resource.file }) };
  },
};
