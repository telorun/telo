import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import type { CloseSpec, EffectInstance, ToastDraft, ToastTone } from "./effect.js";
import { mutationPressSpec, type MutationPressConfig } from "./mutation-calls.js";
import { pressSpec, type PressConfig } from "./press.js";

type ToastResource = RuntimeResource & {
  text: unknown;
  tone?: ToastTone | null;
  link?: PressConfig | null;
  call?: MutationPressConfig | null;
};

/**
 * A notification: its text as written, an omitted tone left for the list that
 * holds it to fill, its link's destination and its call's mutation provided.
 */
export const ToastController = {
  async create(resource: ToastResource, ctx: ResourceContext): Promise<ResourceInstance & EffectInstance> {
    const owner = `Ui.Toast '${resource.metadata.name}'`;
    return {
      provide: async (): Promise<ToastDraft> => {
        const link = await pressSpec(resource.link, ctx, owner);
        const call = resource.call == null ? null : await mutationPressSpec(resource.call, ctx, owner, "call");
        return {
          type: "toast",
          text: resource.text,
          ...(resource.tone != null ? { tone: resource.tone } : {}),
          ...(link ? { link } : {}),
          ...(call ? { call } : {}),
        };
      },
    };
  },
};

/** The closing of the surface the call ran in. */
export const CloseController = {
  async create(): Promise<ResourceInstance & EffectInstance> {
    return { provide: async (): Promise<CloseSpec> => ({ type: "close" }) };
  },
};
