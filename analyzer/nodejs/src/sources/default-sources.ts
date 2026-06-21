import type { ManifestSource } from "../types.js";
import { HttpSource } from "./http-source.js";
import { RegistrySource } from "./registry-source.js";

/** The browser-safe built-in sources, in resolution order: HTTP fetch then
 *  registry. Node-specific sources (local filesystem) are supplied by the
 *  consuming package and passed alongside these into the `Loader` constructor.
 *  Callers that only want a subset (e.g. the editor, which brings its own
 *  registry adapters) construct the individual sources directly. */
export function defaultSources(registryUrl?: string): ManifestSource[] {
  return [new HttpSource(), new RegistrySource(registryUrl)];
}
