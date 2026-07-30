/**
 * The **layer index** of `kernel/specs/module-artifact.md` — the `layers:` block
 * a published `telo.yaml` carries, listing every layer of the module artifact
 * except the manifest layer itself.
 *
 * Why it lives in `telo.yaml` rather than in the OCI manifest, which has layers
 * natively: a Telo import is pinned to a hash of `telo.yaml` and nothing else.
 * The OCI manifest sits one level up, is fetched by a reference that is usually
 * a mutable tag, and is never hashed by Telo — so digests held only there would
 * leave the pin proving nothing about the payload. Pinning the OCI manifest
 * instead is circular: `telo.yaml` is one of its layers.
 *
 * The manifest layer therefore has no entry — a hash of `telo.yaml` cannot sit
 * inside `telo.yaml`. It is pinned by the importer's `#sha256-...` instead, so
 * the chain reads `import pin -> telo.yaml -> blob digest -> layer contents`.
 *
 * Each entry carries two digests, answering different questions:
 *  - `blob` — the OCI blob digest over the pushed bytes. It *addresses* the
 *    layer, so a client pulls by digest and never reads the OCI layer list, and
 *    it verifies the transfer. Publish pushes payload blobs first and injects
 *    their digests here, then pushes the manifest blob, so nothing is circular.
 *  - `integrity` — the content digest (`computeFilesIntegrity`) over that
 *    layer's own files, independent of tar/gzip framing. It verifies what is
 *    already extracted on disk and can be re-derived from it without re-tarring,
 *    which is what makes a per-layer cache marker checkable.
 *
 * Browser-safe: `telo check`, the editor and the hub validate an index through
 * this module; only the kernel fetches and extracts.
 */

import {
  isLayerRole,
  normalizeSelector,
  selectorKey,
  selectorMatches,
  type ArtifactSelector,
  type LayerRole,
  type PlatformTarget,
} from "./artifact-selector.js";

/** OCI content digest: `sha256:` + 64 lowercase hex. */
const BLOB_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Telo content digest: `sha256-` + unpadded base64url of 32 bytes. */
const CONTENT_DIGEST = /^sha256-[A-Za-z0-9_-]{43}$/;

export interface ArtifactLayer {
  role: LayerRole;
  /** Present on `controller` layers only. */
  selector?: ArtifactSelector;
  /** OCI blob digest — addresses the layer and verifies the transfer. */
  blob: string;
  /** Content digest over the layer's files — verifies what is on disk. */
  integrity: string;
}

export class LayerIndexError extends Error {
  readonly code = "INVALID_LAYER_INDEX";

  constructor(detail: string) {
    super(detail);
    this.name = "LayerIndexError";
  }
}

function digest(field: "blob" | "integrity", raw: unknown, describe: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new LayerIndexError(`${describe}: ${field} is required and must be a string.`);
  }
  const pattern = field === "blob" ? BLOB_DIGEST : CONTENT_DIGEST;
  if (!pattern.test(raw)) {
    throw new LayerIndexError(
      field === "blob"
        ? `${describe}: blob '${raw}' is not an OCI digest (expected 'sha256:' + 64 hex characters).`
        : `${describe}: integrity '${raw}' is not a content digest (expected 'sha256-' + 43 base64url characters).`,
    );
  }
  return raw;
}

/**
 * Parse and validate a `layers:` value off an owner document. Order is
 * preserved — when several controller layers match a target, precedence is
 * declaration order, so the author controls it.
 */
export function parseLayerIndex(value: unknown, describe = "layers"): ArtifactLayer[] {
  if (!Array.isArray(value)) {
    throw new LayerIndexError(`${describe}: expected an array of layer entries.`);
  }
  const layers: ArtifactLayer[] = [];
  const seenSelectors = new Set<string>();
  const seenSingletons = new Set<LayerRole>();

  value.forEach((raw, index) => {
    const where = `${describe}[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new LayerIndexError(`${where}: expected an object.`);
    }
    const entry = raw as Record<string, unknown>;
    if (!isLayerRole(entry.role)) {
      throw new LayerIndexError(
        `${where}: role must be one of 'controller', 'assets', 'common'; got ` +
          `${entry.role === undefined ? "nothing" : `'${String(entry.role)}'`}.`,
      );
    }
    const role = entry.role;

    let selector: ArtifactSelector | undefined;
    if (role === "controller") {
      if (entry.selector === undefined) {
        throw new LayerIndexError(`${where}: a controller layer must declare a selector.`);
      }
      selector = normalizeSelector(entry.selector, where);
      const key = selectorKey(selector);
      if (seenSelectors.has(key)) {
        throw new LayerIndexError(
          `${where}: a second controller layer claims the selector ${key}. ` +
            `Each selector addresses exactly one layer.`,
        );
      }
      seenSelectors.add(key);
    } else {
      if (entry.selector !== undefined) {
        throw new LayerIndexError(
          `${where}: a '${role}' layer must not declare a selector — it is a singleton.`,
        );
      }
      if (seenSingletons.has(role)) {
        throw new LayerIndexError(`${where}: a second '${role}' layer is declared.`);
      }
      seenSingletons.add(role);
    }

    layers.push({
      role,
      ...(selector ? { selector } : {}),
      blob: digest("blob", entry.blob, where),
      integrity: digest("integrity", entry.integrity, where),
    });
  });

  return layers;
}

/** The singleton layer for a role, or undefined when the artifact has none. */
export function singletonLayer(
  layers: readonly ArtifactLayer[],
  role: Exclude<LayerRole, "controller">,
): ArtifactLayer | undefined {
  return layers.find((l) => l.role === role);
}

/** Every controller layer matching `target`, in declaration order. Used by
 *  `telo install` to warm a cache for one platform. */
export function matchControllerLayers(
  layers: readonly ArtifactLayer[],
  target: PlatformTarget,
): ArtifactLayer[] {
  return layers.filter(
    (l) => l.role === "controller" && l.selector !== undefined && selectorMatches(l.selector, target),
  );
}
