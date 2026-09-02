import type { ManifestSource } from "../types.js";
import { HttpSource } from "./http-source.js";

/** The browser-safe built-in sources. Node-specific sources (local filesystem)
 *  are supplied by the consuming package and passed alongside these into the
 *  `Loader` constructor. Callers that only want a subset (e.g. the editor, which
 *  brings its own manifest-cache adapter) construct the individual sources
 *  directly. */
export function defaultSources(): ManifestSource[] {
  return [new HttpSource()];
}
