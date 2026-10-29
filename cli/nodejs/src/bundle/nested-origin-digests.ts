import { nestedModuleOrigin, parseOciRef, type LoadedGraph } from "@telorun/analyzer";
import { originKey, writeOriginDigests } from "../manifest-freshness.js";

/**
 * Record, for every artifact a nested module was read out of, the OCI manifest
 * digest that artifact was served at — `host/repo@tag` → digest, the record the
 * runtime reads to identify a cached parent's nested modules without the
 * registry. The digest is the one the nested identity carries
 * (`oci://h/r@sha256:X/<path>`), taken from this very load rather than asked of
 * the registry again, which a moving tag would answer differently.
 */
export async function writeNestedOriginDigests(
  graph: LoadedGraph,
  manifestsDir: string,
): Promise<number> {
  const digests = new Map<string, string>();
  for (const module of graph.modules.values()) {
    const origin = nestedModuleOrigin(graph, module.owner.source);
    if (!origin) continue;
    // The record holds mutable tags only; a digest reference is its own identity.
    if (parseOciRef(origin.parent).reference.startsWith("sha256:")) continue;
    const digest = parseOciRef(module.owner.requestedUrl).reference;
    const key = originKey(origin.parent);
    const known = digests.get(key);
    if (known !== undefined && known !== digest) {
      throw new Error(
        `${origin.parent} was read at two different digests (${known}, ${digest}) in one load; its tag moved while loading. Run the command again.`,
      );
    }
    digests.set(key, digest);
  }
  await writeOriginDigests(manifestsDir, digests);
  return digests.size;
}
