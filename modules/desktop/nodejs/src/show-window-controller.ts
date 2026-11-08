import type { ResourceContext, ResourceManifest } from "@telorun/sdk";

interface Showable {
  show(): Promise<void>;
}

const isShowable = (candidate: unknown): candidate is Showable =>
  typeof (candidate as Showable | undefined)?.show === "function";

interface ShowWindowResource extends ResourceManifest {
  window: unknown;
}

export const ShowWindow = {
  schema: { type: "object", additionalProperties: true },
  async create(resource: ShowWindowResource, ctx: ResourceContext) {
    return {
      async invoke() {
        const window = ctx.resolveRef(
          resource.window,
          isShowable,
          () => `Desktop.ShowWindow/${resource.metadata.name}: 'window'`,
          "Desktop.Window",
        );
        await window.show();
        return {};
      },
      snapshot: () => ({}),
    };
  },
};
