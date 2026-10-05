import {
  describeSelector,
  layerDigestKey,
  parseLayerIndex,
  selectorKey,
  sha256Base64Url,
  type ArtifactLayer,
  type ArtifactSelector,
  type LayerDigests,
} from "@telorun/analyzer";
import { computeFilesIntegrity, defaultTransportRegistry } from "@telorun/kernel";
import { parseAllDocuments } from "yaml";

/**
 * Would publishing move the pin of a version that is already published?
 *
 * A consumer's import pin is a hash of `telo.yaml` and nothing else, so the
 * question is decided by that hash: identical bytes pass (a re-push), anything
 * else is refused. The payload layers are compared only to say WHAT moved — a
 * bundle inlines its dependencies, so a shared-library fix or a lockfile bump
 * moves a layer's `integrity` while touching nothing under the module's own
 * directory, and naming that layer is what points the author at the cause.
 */
/** One payload layer whose `integrity` differs from the published index. */
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
import type { BuiltLayer } from "./built-layers.js";
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
 * The `telo.yaml` published at `ref`, read from the registry itself (never a
 * cache), or `null` when nothing is published there.
 *
 * A ref that does not resolve is not an error: a new version has no predecessor.
 * **Anything else is.** A 401, a 5xx or a DNS failure says nothing about whether
 * the published version would change, and answering "unchanged" to a question
 * the registry refused to answer would turn the gate into a no-op during exactly
 * the kind of incident where a release is most likely to ship something wrong.
 * Those propagate and fail the publish.
 */
async function readPublishedManifest(ref: string): Promise<string | null> {
  const transport = defaultTransportRegistry().forRef(ref);
  if (!transport) {
    throw new Error(`Cannot read the published manifest of '${ref}': no transport owns that ref.`);
  }
  try {
    return (await transport.source.read(ref)).text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NOT_FOUND.test(message)) return null;
    throw new Error(
      `Cannot verify whether '${ref}' is already published with a different pin: ${message}. ` +
        `Publishing without that answer could move the pin of a published version — ` +
        `resolve the registry error and retry.`,
    );
  }
}

/** The `layers:` index a manifest's module doc declares; `[]` when none. */
function layerIndexOf(text: string, ref: string): ArtifactLayer[] {
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
  const ref = `${destination}@${version}`;
  const text = await readPublishedManifest(ref);
  if (text === null) return null;
  const digests: Record<string, string> = {};
  for (const layer of layerIndexOf(text, ref)) {
    digests[layerDigestKey(layer.role, layer.selector)] = layer.integrity;
  }
  return digests;
}

/** What the built payload's layers change against a published index. */
async function layerDrift(
  published: readonly ArtifactLayer[],
  built: readonly BuiltLayer[],
): Promise<LayerDrift[]> {
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
  // A layer that was published and is no longer built moved too — the payload
  // shrank, which changes what a consumer receives just as much as a byte edit.
  for (const [key, layer] of publishedByKey) {
    if (seen.has(key)) continue;
    drift.push({ role: describeKey(layer.role, layer.selector), published: layer.integrity });
  }
  return drift;
}

/** The integrity pin of a `telo.yaml`: what an import of it is verified against. */
export async function manifestPin(text: string): Promise<string> {
  return `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;
}

/** How the manifest about to be pushed relates to the one already published at
 *  its `metadata.version`. */
export type PublishedPinCheck =
  | { status: "unpublished" }
  | { status: "identical"; pin: string }
  | { status: "moved"; publishedPin: string; builtPin: string; drift: LayerDrift[] };

/**
 * Compare the pin of the `telo.yaml` about to be pushed against the pin of the
 * one published at the same version.
 *
 * The pin is what every consumer verifies, so it is the thing that must not
 * move: comparing payload layers alone let a manifest-only change (a
 * description, an import, a re-serialization) republish a version under a new
 * pin, and a module with no payload was never compared at all. The layers are
 * compared only to explain what moved.
 */
export async function checkPublishedPin(
  destination: string,
  version: string,
  manifest: string,
  built: readonly BuiltLayer[],
): Promise<PublishedPinCheck> {
  const ref = `${destination}@${version}`;
  const published = await readPublishedManifest(ref);
  if (published === null) return { status: "unpublished" };
  const [publishedPin, builtPin] = await Promise.all([manifestPin(published), manifestPin(manifest)]);
  if (publishedPin === builtPin) return { status: "identical", pin: builtPin };
  return {
    status: "moved",
    publishedPin,
    builtPin,
    drift: await layerDrift(layerIndexOf(published, ref), built),
  };
}

/** The refusal shown when the pin would move. It names the version to publish
 *  under instead, because a re-push is exactly what must not happen: every
 *  import pinned to the published version would stop verifying. */
export function describePinMove(
  destination: string,
  version: string,
  moved: Extract<PublishedPinCheck, { status: "moved" }>,
): string {
  const layers =
    moved.drift.length === 0
      ? ["  no payload layer moved — the manifest itself changed (metadata, imports, or how this telo serializes it)"]
      : moved.drift.map((entry) => {
          if (!entry.built) return `  ${entry.role}: published, no longer built`;
          if (!entry.published) return `  ${entry.role}: newly built, not in the published artifact`;
          return `  ${entry.role}: ${entry.published} → ${entry.built}`;
        });
  return (
    `${destination}@${version} is already published with pin ${moved.publishedPin}, ` +
    `but the telo.yaml built now pins ${moved.builtPin}:\n` +
    layers.join("\n") +
    `\nA published version's pin never moves — every import pinned to it verifies against it. ` +
    `Publish under a new metadata.version (in a release workspace, \`telo release status\` shows ` +
    `what would bump and \`telo release apply\` moves it).`
  );
}
