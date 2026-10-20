import type { TeloStatusHost } from "@telorun/language-host";

/** How studio names itself and its version setting in language-host's status
 *  sentences — one wording for the version control and the structured views. */
export const STUDIO_TELO_STATUS_HOST: TeloStatusHost = {
  product: "studio",
  setting: "this workspace's telo version setting",
};
