import type { ManifestSource } from "@telorun/analyzer";

import { reportPhase } from "./phase-progress.js";

/** A source address as printed: userinfo, query and fragment can hold credentials and are dropped. */
export function printableSourceUrl(url: string): string {
  const withoutTail = url.replace(/[?#].*$/s, "");
  return withoutTail.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
}

/**
 * A network manifest source that reports each read it makes. It is placed
 * after the manifest cache in the source chain, so it is only reached on a
 * cache miss — a warm start reads nothing through it and prints nothing.
 * Everything but `read` is the wrapped source's own.
 */
export function withFetchProgress(source: ManifestSource): ManifestSource {
  const reporting: ManifestSource = Object.create(source);
  reporting.read = (url) =>
    reportPhase(printableSourceUrl(url), { doing: "fetching", done: "fetched" }, () => source.read(url));
  return reporting;
}
