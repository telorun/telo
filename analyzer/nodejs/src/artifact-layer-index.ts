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
  LAYER_ROLES,
  isLayerRole,
  normalizeSelector,
  roleCarriesSelector,
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
  /** Present on the code-bearing roles (`controller`, `library`) only. */
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
    if (typeof entry.role !== "string" || entry.role === "") {
      throw new LayerIndexError(
        `${where}: role is required and must be one of ${LAYER_ROLES.map((r) => `'${r}'`).join(", ")}; ` +
          `got ${entry.role === undefined ? "nothing" : `'${String(entry.role)}'`}.`,
      );
    }
    // A role this runtime does not know is SKIPPED, never rejected. Roles are
    // added over time, and a runtime that cannot name one cannot need it — while
    // throwing would make the whole manifest unreadable, so a module gaining a
    // layer for a newer runtime would stop loading on an older one entirely
    // rather than merely lacking that layer. The error stays for a structurally
    // invalid entry, which is a malformed index rather than a newer one.
    if (!isLayerRole(entry.role)) return;
    const role = entry.role;

    let selector: ArtifactSelector | undefined;
    if (roleCarriesSelector(role)) {
      if (entry.selector === undefined) {
        throw new LayerIndexError(`${where}: a ${role} layer must declare a selector.`);
      }
      selector = normalizeSelector(entry.selector, where);
      // Scoped by role: a module's `js` controller layer and its `js` library
      // layer are different layers with the same selector, and only a collision
      // *within* one role means two layers claim one address.
      const key = `${role}\0${selectorKey(selector)}`;
      if (seenSelectors.has(key)) {
        throw new LayerIndexError(
          `${where}: a second ${role} layer claims the selector ${selectorKey(selector)}. ` +
            `Each selector addresses exactly one layer of a role.`,
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
  role: Exclude<LayerRole, "controller" | "library">,
): ArtifactLayer | undefined {
  return layers.find((l) => l.role === role);
}

/** The layer of one code role carrying exactly `selector`, or undefined.
 *
 *  By exact key rather than by re-matching a host: the candidate being resolved
 *  already *is* one selector, and it is by construction the key of the layer
 *  that carries it. */
export function codeLayerFor(
  layers: readonly ArtifactLayer[],
  role: Extract<LayerRole, "controller" | "library">,
  selector: ArtifactSelector,
): ArtifactLayer | undefined {
  const key = selectorKey(selector);
  return layers.find(
    (l) => l.role === role && l.selector !== undefined && selectorKey(l.selector) === key,
  );
}

/** Every code layer — controller and library alike — matching `target`, in
 *  declaration order. Used by `telo install` to warm a cache for one platform:
 *  a library layer is as much a prerequisite of an offline run as the controller
 *  layer that imports it. */
export function matchCodeLayers(
  layers: readonly ArtifactLayer[],
  target: PlatformTarget,
): ArtifactLayer[] {
  return layers.filter(
    (l) =>
      (l.role === "controller" || l.role === "library") &&
      l.selector !== undefined &&
      selectorMatches(l.selector, target),
  );
}
