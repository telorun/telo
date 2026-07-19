import type { ManifestSource } from "@telorun/analyzer";

import type { PayloadFile } from "../bundle/files-integrity.js";

/** The full module artifact a transport delivers: the `telo.yaml` bytes plus
 *  the decompressed `files:` payload (empty for a manifest-only module). The
 *  manifest is already verified against the import's inline hash; the payload
 *  against the manifest-embedded `filesIntegrity`. */
export interface FetchedArtifact {
  manifest: string;
  files: PayloadFile[];
}

/** The module bundle handed to a transport for publishing: the final,
 *  already-analyzed / pinned / canonicalized `telo.yaml` bytes plus the `files:`
 *  payload (empty for a manifest-only module). The transport is responsible for
 *  pinning the payload (`filesIntegrity`) and for the artifact shape it writes
 *  (HTTP: `telo.yaml` + `module.tar.gz`; OCI: a single blob). */
export interface PublishBundle {
  manifest: string;
  files: PayloadFile[];
}

export interface PublishResult {
  /** Human-readable `<ns>/<name>@<version>` label of what was pushed. */
  label: string;
  /** The location the artifact was written to. */
  url: string;
}

/** Identity of a sibling library, read from its own manifest, that a relative
 *  import canonicalizes to. `version` is always required; `namespace`/`name` are
 *  used only by transports whose location is metadata-derived (HTTP registry). */
export interface SiblingIdentity {
  namespace?: string;
  name?: string;
  version: string;
}

export interface PublishOptions {
  /** Bearer token for registries that require auth. */
  token?: string;
  /** Notified before each backoff sleep on a transient push failure, so the
   *  caller can surface retry progress. */
  onRetry?: (info: {
    reason: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
  }) => void;
}

/** A Transport owns everything ref-scheme-specific about a module's lifecycle:
 *  resolution (through its `ManifestSource`), cache placement, version
 *  enumeration, full-artifact fetch, and publish. Registering a transport is
 *  the only thing needed to add a backend — the loader, cache, `upgrade`, and
 *  `publish` never branch on scheme again; they ask the {@link TransportRegistry}
 *  which transport owns a ref and delegate.
 *
 *  A Transport *composes* a resolution `ManifestSource`, it does not extend it:
 *  `ManifestSource` is the browser-safe resolution primitive (also implemented
 *  by the cache / local / memory sources, which have no versions and nothing to
 *  publish), so it stays in `analyzer`, while the Node-only management methods
 *  (`cacheLocation` and, in later phases, `listVersions` / `fetchArtifact` /
 *  `publish`) live on the Transport here in `kernel`. */
export interface Transport {
  /** True when this transport owns the given ref (or publish destination). */
  supports(ref: string): boolean;

  /** The resolution primitive: fetch + verify `telo.yaml`, resolve relatives.
   *  Browser-safe for a browser-reachable transport (HTTP/registry), so it can
   *  live in `analyzer`; a Node-only transport has no browser-safe source. */
  readonly source: ManifestSource;

  /** Deterministic cache-path segments for a ref, joined under the cache root by
   *  the cache source. Returns `null` when the ref is not cacheable here
   *  (unsupported scheme, malformed ref, or path-traversal in the ref). */
  cacheLocation(ref: string): string[] | null;

  /** The versions published for the module `ref` names, newest-first order not
   *  guaranteed (the caller sorts). Returns `null` when the module is not
   *  published (e.g. a 404), distinct from `[]` (published, no versions). Used
   *  by `telo upgrade`. */
  listVersions(ref: string): Promise<string[] | null>;

  /** Retrieve the full artifact for `ref` — the `telo.yaml` and its `files:`
   *  payload — verifying the manifest against the inline hash and the payload
   *  against the manifest's `filesIntegrity`. Used by `telo install`; subsumes
   *  the out-of-band bundle fetch that used to sit outside the source chain. */
  fetchArtifact(ref: string): Promise<FetchedArtifact>;

  /** Cheap content-identity digest of what `ref` currently resolves to — no
   *  payload download. Opaque and transport-specific (OCI: the image manifest's
   *  `sha256:<hex>` content digest; HTTP: `sha256-<base64url>` over the
   *  `telo.yaml` bytes), so compare for equality only, never across transports.
   *  Returns `null` when the version does not exist. Version content
   *  immutability is a convention no transport enforces — a tag can be
   *  re-pushed to different bytes — so the discovery tracker records this
   *  digest per version and re-checks it on every track. */
  digest(ref: string): Promise<string | null>;

  /** Telo's inline integrity hash (`sha256-<base64url>`) for the `telo.yaml`
   *  `ref` resolves to — the value written as a `#sha256-…` pin by `telo
   *  publish` and re-pinned by `telo upgrade`. Throws when the ref does not
   *  resolve; callers decide whether that is fatal (`--frozen`) or best-effort.
   *
   *  This is on the interface, not computed by the caller, because *what gets
   *  hashed* is transport-specific and must match exactly what that transport's
   *  own `source.read()` verifies — otherwise a pin written at publish fails
   *  verification at import. HTTP/registry hash the raw response bytes;
   *  OCI hashes the UTF-8 encoding of the `telo.yaml` extracted from the tar
   *  layer. A caller cannot know which, so a caller-side scheme branch silently
   *  degrades the moment a transport is added — which is exactly how `oci://`
   *  refs came to be published unpinned.
   *
   *  Distinct from `digest()`: that is an opaque transport-native content id for
   *  change detection, never written into a manifest or compared across
   *  transports. This is the portable, cross-transport hash Telo itself
   *  verifies. */
  manifestHash(ref: string): Promise<string>;

  /** Push `bundle` to `destination` (a base ref / repo whose scheme this
   *  transport owns), pinning the payload and writing the transport-native
   *  artifact shape. Throws on failure. Used by `telo publish`. */
  publish(
    destination: string,
    bundle: PublishBundle,
    opts?: PublishOptions,
  ): Promise<PublishResult>;

  /** Canonicalize a relative sibling import (`../lib`) declared in a module
   *  being published to `destination` into the absolute ref it will resolve to
   *  once published. Owns the scheme-specific "where does a sibling land" rule —
   *  OCI derives the repo from the destination, HTTP from the sibling's
   *  `<namespace>/<name>` — so `telo publish` delegates instead of branching on
   *  transport shape. */
  canonicalizeSiblingRef(
    destination: string,
    relativeSource: string,
    sibling: SiblingIdentity,
  ): string;
}
