/**
 * A module's payload, reduced to one digest per layer — the exact answer to
 * "did this module's artifact change?".
 *
 * It is exact because it is taken from the bytes: it fires for an inlined
 * sibling's edit, for a shared-library fix, and for a transitive bump the
 * lockfile alone moved, none of which touch a file under the module's own
 * directory. No path-scoped rule and no declared-dependency graph can see any of
 * them.
 *
 * The digest itself is `computeFilesIntegrity`, the same framing-independent
 * content digest the published `layers:` index carries — which is what makes the
 * ledger's recorded number and the registry's the same number, comparable
 * without fetching a blob.
 */

import { PLATFORM_AXES, type ArtifactSelector, type LayerRole } from "../artifact-selector.js";

/** Per-layer integrity, keyed by `layerDigestKey`. */
export type LayerDigests = Readonly<Record<string, string>>;

/** The ledger key for the module's `telo.yaml` layer. */
export const MANIFEST_LAYER = "manifest";

/**
 * Ledger keys the registry cannot answer for, and so the ones `telo release
 * verify` reconciles nothing about and must preserve.
 *
 * Exactly one today, and for a structural reason rather than an omission: the
 * published `layers:` index lives *inside* `telo.yaml`, so it cannot carry that
 * file's own digest — the entry would have to be computed over bytes containing
 * it. Nor can the digest be recovered by hashing what the registry serves, since
 * the transport injects the index at push time and the published text is
 * therefore not the text the payload builder produced.
 *
 * It stays in the ledger regardless, because it is the only thing that sees a
 * **manifest-only change**: a schema edit, a new kind, a description, a
 * dependency's version moving into a pin. None of those touch a controller byte,
 * so without this key such a module would report no drift and its fix would ship
 * to nobody — the exact failure the digest exists to prevent.
 */
export const LOCALLY_DERIVED_LAYERS: ReadonlySet<string> = new Set([MANIFEST_LAYER]);

/**
 * A layer's identity within an artifact, as a stable, readable, YAML-plain key.
 *
 * A role alone is not the identity — there is one controller layer per selector
 * — so a selector's axes join the key. Rendered as `controller/js` and
 * `controller/napi+linux+amd64+gnu` rather than through `selectorKey`'s
 * `axis=value;…` form, because this string is read by a human in a ledger diff
 * and written into a plain YAML key; the axis order is `PLATFORM_AXES`, so the
 * rendering is deterministic rather than dependent on how the selector was
 * built.
 */
export function layerDigestKey(role: LayerRole | string, selector?: ArtifactSelector): string {
  if (!selector) return role;
  const parts = [selector.format, ...PLATFORM_AXES.map((axis) => selector[axis])].filter(
    (value): value is string => value !== undefined,
  );
  return `${role}/${parts.join("+")}`;
}

/** A layer whose digest differs between two readings, or that exists in only
 *  one of them. `before` / `after` are absent when the layer is absent there —
 *  a payload that gained or lost a layer changed just as much as one whose
 *  bytes moved. */
export interface LayerChange {
  readonly layer: string;
  readonly before?: string;
  readonly after?: string;
}

/** Every layer on which two readings disagree, in key order. Empty means the
 *  payloads are byte-identical. */
export function diffLayerDigests(before: LayerDigests, after: LayerDigests): LayerChange[] {
  const changes: LayerChange[] = [];
  for (const layer of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[layer];
    const b = after[layer];
    if (a !== b) changes.push({ layer, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  return changes;
}
