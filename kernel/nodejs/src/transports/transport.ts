import type {
  ArtifactSelector,
  LayerRole,
  ManifestCacheCoords,
  ManifestSource,
} from "@telorun/analyzer";

import type { PayloadFile } from "../bundle/files-integrity.js";

/** One layer of a module artifact as the CLI partitioned it, before publish
 *  assigns digests. `role` / `selector` become the layer's entry in the
 *  published `layers:` index. */
export interface PayloadLayer {
  role: LayerRole;
  /** Present on `controller` layers only. */
  selector?: ArtifactSelector;
  files: PayloadFile[];
}

/** The module bundle handed to a transport for publishing: the final,
 *  already-analyzed / pinned / canonicalized `telo.yaml` bytes plus the payload
 *  partitioned into layers (empty for a manifest-only module). The transport
 *  pushes each layer as its own blob, injects the resulting `layers:` index into
 *  the manifest, and only then pushes the manifest layer — the order that keeps
 *  the index non-circular. */
export interface PublishBundle {
  manifest: string;
  layers: PayloadLayer[];
}

export interface PublishResult {
  /** Human-readable `<ns>/<name>@<version>` label of what was pushed. */
  label: string;
  /** The location the artifact was written to. */
  url: string;
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
 *  (`cacheCoords`, `listVersions`, `fetchLayer`, `publish`) live on the Transport
 *  here in `kernel`. */
export interface Transport {
  /** True when this transport owns the given ref (or publish destination). */
  supports(ref: string): boolean;

  /** The resolution primitive: fetch + verify `telo.yaml`, resolve relatives.
   *  Browser-safe for a browser-reachable transport (HTTP/registry), so it can
   *  live in `analyzer`; a Node-only transport has no browser-safe source. */
  readonly source: ManifestSource;

  /** Where a ref's `telo.yaml` is cached, as the transport-neutral
   *  `{ transport, host, path, version, file }` coordinates the analyzer's
   *  `manifestCacheKey` renders into a path. One grammar serves the local
   *  install cache, the hub's static manifest bucket, and the editor's read
   *  path, so the three cannot drift on the *shape* of a cache key.
   *
   *  They do differ on coordinates, deliberately, for a `url` ref: the hub reads
   *  the version out of the fetched manifest and keys by it, while this cache
   *  maps a ref to a path before any fetch and so has no version to supply —
   *  it names the file instead, since it also stores each `include:` partial.
   *  Same grammar, different coordinates; not a drift to reconcile.
   *
   *  Returns `null` when the ref is not cacheable here (unsupported scheme,
   *  malformed ref, or path-traversal in the ref). */
  cacheCoords(ref: string): ManifestCacheCoords | null;

  /** The versions published for the module `ref` names, newest-first order not
   *  guaranteed (the caller sorts). Returns `null` when the module is not
   *  published (e.g. a 404), distinct from `[]` (published, no versions). Used
   *  by `telo upgrade`. */
  listVersions(ref: string): Promise<string[] | null>;

  /** The version segment currently named in `ref` — a registry `@version`, an
   *  OCI tag, or an OCI digest reference (`sha256:…`), returned raw (the caller
   *  applies its own SemVer validation). Returns `null` when the ref carries no
   *  upgradeable version at all — a bare `https://` URL, or an OCI ref with no
   *  explicit reference. The integrity fragment is ignored. Used by `telo
   *  upgrade` to read the current pin. Paired with {@link withVersion}, which
   *  owns the scheme-specific reconstruction, so `upgrade` never branches on
   *  ref shape. */
  refVersion(ref: string): string | null;

  /** `ref` rewritten to name `version`, dropping any integrity fragment (the
   *  caller re-pins the result). Scheme-specific reconstruction — registry
   *  `<ns>/<name>@version`, OCI `oci://host/repo@version`. Only called for refs
   *  {@link refVersion} classified as versioned, so it may assume a parseable
   *  ref. Used by `telo upgrade`. */
  withVersion(ref: string, version: string): string;

  /** Pull **one** layer of `ref`'s artifact, addressed by the `blob` digest its
   *  entry in the pinned `layers:` index carries, and return its decompressed
   *  files. Addressing by digest is what keeps the untrusted OCI manifest out of
   *  the path: only the *manifest* layer is located through it, and those bytes
   *  are then checked against the import pin, so tampering is caught before any
   *  index is read. Content verification against the entry's `integrity` is the
   *  caller's (the artifact handle's), since only it knows the expected value.
   *
   *  Throws when the transport cannot deliver payload layers at all — a module
   *  with a payload is an OCI artifact, and no other transport publishes one. */
  fetchLayer(ref: string, blobDigest: string): Promise<PayloadFile[]>;

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
   *  once published.
   *
   *  The sibling lands beside the destination: the destination's last segment is
   *  the module's own directory, so the relative path resolves against it
   *  exactly as it does on the publisher's disk — publishing `…/telorun/foo`
   *  with an import of `../bar` yields `…/telorun/bar`. Only the version comes
   *  from the sibling's own manifest; nothing is read from its metadata to
   *  decide where it lives. Each transport owns the join for its ref grammar, so
   *  `telo publish` delegates instead of branching on transport shape. */
  canonicalizeSiblingRef(
    destination: string,
    relativeSource: string,
    version: string,
  ): string;
}
