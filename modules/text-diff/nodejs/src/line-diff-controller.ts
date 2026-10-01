import type { FunctionController, ResourceManifest } from "@telorun/sdk";
import { lineDiff, type LineDiffResult } from "./line-diff.js";

interface LineDiffResource extends ResourceManifest {
  contextLines?: number;
  maxInputBytes?: number;
}

export const LineDiff: FunctionController<
  LineDiffResource,
  { before: string; after: string },
  LineDiffResult
> = {
  create(resource) {
    const options = {
      contextLines: resource.contextLines ?? 3,
      maxInputBytes: resource.maxInputBytes ?? 262144,
    };
    return { call: ({ before, after }) => lineDiff(before, after, options) };
  },
};
