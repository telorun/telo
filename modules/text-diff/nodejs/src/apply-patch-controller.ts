import type { FunctionController, ResourceManifest } from "@telorun/sdk";
import { applyPatch, type ApplyPatchResult } from "./apply-patch.js";

interface ApplyPatchResource extends ResourceManifest {
  maxInputBytes?: number;
}

export const ApplyPatch: FunctionController<
  ApplyPatchResource,
  { text: string; patch: string },
  ApplyPatchResult
> = {
  create(resource) {
    const options = { maxInputBytes: resource.maxInputBytes ?? 262144 };
    return { call: ({ text, patch }) => applyPatch(text, patch, options) };
  },
};
