/**
 * The `docker` ecosystem's pure half: an anchor holding a `Dockerfile` is one
 * image. An image keeps no version of its own — it is tagged with its unit's.
 * Its settings say where it is pushed (`registry`, `name`) and which directory
 * it is built from (`context`).
 */

import type { EcosystemAdapter } from "../adapter.js";

export const DOCKERFILE = "Dockerfile";

export const dockerAdapter: EcosystemAdapter = {
  ecosystem: "docker",
  anchorDescription: "a directory holding a Dockerfile",
  keys: {
    registry: {
      type: "string",
      description: "Image repository base the image is pushed under, as `<registry>/<name>`.",
      examples: ["ghcr.io/acme"],
    },
    name: {
      type: "string",
      description: "The image's name under its registry. Omitted: the anchor directory's own name.",
    },
    context: {
      type: "directory",
      description:
        "The build context, a workspace-relative directory ('.' the workspace root). Omitted: the anchor directory. Its ignore file is <Dockerfile>.dockerignore beside the Dockerfile, else the context's .dockerignore.",
      examples: ["."],
    },
  },
  recognize(probe) {
    return probe.readFile(DOCKERFILE) === undefined ? undefined : { contributesLayer: true };
  },
};
