import {
  describeSelector,
  layerDigestKey,
  parseLayerIndex,
  selectorKey,
  type ArtifactLayer,
  type ArtifactSelector,
  type LayerDigests,
} from "@telorun/analyzer";
import { computeFilesIntegrity, defaultTransportRegistry } from "@telorun/kernel";
import { parseAllDocuments } from "yaml";

/**
 * Does the payload we are about to publish differ from what is already published
 * at this `metadata.version`?
 *
 * Bundling moves a module's dependency coupling from load time to build time. It
 * does not remove it: once `codec` — or `fastify`, or a transitive dependency the
 * lockfile alone moved — is copied into a module's bundle, that module's bytes
 * have changed while nothing under its own directory has. No path-scoped rule and
 * no version ledger can see that, so a fix silently ships to nobody.
 *
 * The artifact already carries the exact answer. Each layer's `integrity` is a
 * framing-independent digest of its contents, so comparing the layer we just
 * built against the one published under the same version decides the question
 * from the bytes themselves — it fires for a shared-library fix, a lockfile bump
 * and a sibling source edit alike, and it cannot fire spuriously, because
 * identical bytes hash identically.
 */
export interface LayerDrift {
  role: string;
  selector?: string;
  /** `integrity` recorded in the published `layers:` index, or `undefined` when
   *  the published artifact ships no layer for this role/selector at all. */
  published?: string;
  /** `integrity` of the layer built from the working copy, or `undefined` when
   *  the build no longer produces this layer. */
  built?: string;
}

// The shape of a layer built from a working copy is the payload builder's, not
// this gate's: both this and `telo release` digest exactly what `telo publish`
// pushes, and two declarations of it would be two chances to disagree.
import type { BuiltLayer } from "./module-payload.js";
export type { BuiltLayer };

/** Identity of a layer within an artifact: its role, plus its selector for the
 *  controller layers, of which there is one per selector. */
function layerKey(role: string, selector?: ArtifactSelector): string {
  return selector ? `${role}\0${selectorKey(selector)}` : role;
}

function describeKey(role: string, selector?: ArtifactSelector): string {
  return selector ? `${role} (${describeSelector(selector)})` : role;
}

/** A published version genuinely absent from the registry — the normal case on
 *  every release, and the ONLY reason this gate is allowed to pass without
 *  comparing anything. */
const NOT_FOUND = /\b404\b|not found|MANIFEST_UNKNOWN|NAME_UNKNOWN/i;

/**
 * Read the `layers:` index off an already-published manifest, or `null` when
 * nothing is published at that ref.
 *
 * A ref that does not resolve is not an error: a new version has no predecessor.
 * **Anything else is.** A 401, a 5xx or a DNS failure says nothing about whether
 * the payload changed, and answering "no drift" to a question the registry
 * refused to answer would turn a byte-equality gate into a no-op during exactly
 * the kind of incident where a release is most likely to ship something wrong.
 * Those propagate and fail the publish.
 */
async function readPublishedLayers(ref: string): Promise<ArtifactLayer[] | null> {
  const transport = defaultTransportRegistry().forRef(ref);
  if (!transport) {
    throw new Error(
      `Cannot verify the published payload of '${ref}': no transport owns that ref.`,
    );
  }
  let text: string;
  try {
    ({ text } = await transport.source.read(ref));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NOT_FOUND.test(message)) return null;
    throw new Error(
      `Cannot verify whether '${ref}' is already published with a different payload: ${message}. ` +
        `Publishing without that answer could ship changed bytes at an unchanged version — ` +
        `resolve the registry error and retry.`,
    );
  }
  for (const doc of parseAllDocuments(text)) {
    const json = doc.toJSON() as { kind?: string; layers?: unknown } | null;
    if (json?.kind !== "Telo.Application" && json?.kind !== "Telo.Library") continue;
    if (json.layers === undefined) return [];
    return parseLayerIndex(json.layers, `${ref} layers`);
  }
  return [];
}

/**
 * The per-layer integrity the registry serves at `<destination>@<version>`, or
 * `null` when nothing is published there.
 *
 * The **registry's own numbers**, read off the published `layers:` index rather
 * than recomputed from anything local. That is what makes it the authority half
 * of the ledger's cache: `telo release verify` compares the committed digests
 * against these, and `--write` records these.
 */
export async function readPublishedDigests(
  destination: string,
  version: string,
): Promise<LayerDigests | null> {
  const published = await readPublishedLayers(`${destination}@${version}`);
  if (published === null) return null;
  const digests: Record<string, string> = {};
  for (const layer of published) {
    digests[layerDigestKey(layer.role, layer.selector)] = layer.integrity;
  }
  return digests;
}

/**
 * Compare the built payload against the published one at the same version.
 *
 * Returns `null` when nothing is published at that ref — a new version, so there
 * is nothing to disagree with. Returns an empty array when the payloads match.
 */
export async function findPayloadDrift(
  destination: string,
  version: string,
  built: readonly BuiltLayer[],
): Promise<LayerDrift[] | null> {
  const published = await readPublishedLayers(`${destination}@${version}`);
  if (published === null) return null;

  const publishedByKey = new Map<string, ArtifactLayer>();
  for (const layer of published) publishedByKey.set(layerKey(layer.role, layer.selector), layer);

  const drift: LayerDrift[] = [];
  const seen = new Set<string>();
  for (const layer of built) {
    const key = layerKey(layer.role, layer.selector);
    seen.add(key);
    const integrity = await computeFilesIntegrity(layer.files);
    const before = publishedByKey.get(key);
    if (before?.integrity !== integrity) {
      drift.push({
        role: describeKey(layer.role, layer.selector),
        published: before?.integrity,
        built: integrity,
      });
    }
  }
  // A layer that was published and is no longer built is drift too — the payload
  // shrank, which changes what a consumer receives just as much as a byte edit.
  for (const [key, layer] of publishedByKey) {
    if (seen.has(key)) continue;
    drift.push({ role: describeKey(layer.role, layer.selector), published: layer.integrity });
  }
  return drift;
}

/** The message shown when the gate fires. It names the version to bump, because
 *  that — not a re-push — is the fix: overwriting a published tag would change
 *  what an existing pinned import resolves to. */
export function describeDrift(moduleRef: string, version: string, drift: LayerDrift[]): string {
  const lines = drift.map((entry) => {
    if (!entry.built) return `  ${entry.role}: published, no longer built`;
    if (!entry.published) return `  ${entry.role}: newly built, not in the published artifact`;
    return `  ${entry.role}: ${entry.published} → ${entry.built}`;
  });
  return (
    `${moduleRef} is already published at ${version}, but its payload has changed:\n` +
    lines.join("\n") +
    `\nA bundle inlines its dependencies, so a change in a shared library or the ` +
    `lockfile alters these bytes without touching this module's own files. ` +
    `Run \`telo release status\` to see what would bump and why, then ` +
    `\`telo release apply\` to move metadata.version — republishing over the ` +
    `existing tag would change what an already-pinned import resolves to.`
  );
}
