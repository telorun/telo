import type { JSONSchema7 } from "json-schema";

/**
 * Session config for the local host runner.
 *
 * There is no image and no pull policy — that vocabulary belongs to a runner
 * that spawns containers. The one thing this runner has to be told is which
 * host runner it is, and even that is optional: empty means the executable Studio
 * ships, which is the answer that makes a run reproducible. A path here is the
 * explicit override, never a version comparison and never a `PATH` lookup.
 */
export interface LocalCliConfig {
  executable: string;
  [key: string]: unknown;
}

export const localCliDefaultConfig: LocalCliConfig = {
  executable: "",
};

export const localCliConfigSchema: JSONSchema7 = {
  type: "object",
  properties: {
    executable: {
      type: "string",
      default: localCliDefaultConfig.executable,
      title: "Host runner executable",
      description:
        "Leave empty to use the host runner bundled with Telo Studio, which is the version this editor was built against. Set a path to run your own build of it instead.",
    },
  },
};
