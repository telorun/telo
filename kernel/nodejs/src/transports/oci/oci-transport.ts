import {
  DEFAULT_MANIFEST_FILENAME,
  IntegrityError,
  selectorKey,
  sha256Base64Url,
  verifyIntegrity,
  type ArtifactLayer,
  type ArtifactSelector,
  type ManifestCacheCoords,
  type ManifestSource,
} from "@telorun/analyzer";
import {
  computeFilesIntegrity,
  type PayloadFile,
} from "../../bundle/files-integrity.js";
import { readOwnerManifest, type OwnerManifest } from "../../bundle/module-manifest.js";
import { makeTarGz, readTarGz, toPayloadFiles } from "../../bundle/tar.js";
import type {
  PayloadLayer,
  PublishBundle,
  PublishOptions,
  PublishResult,
  Transport,
} from "../transport.js";
import {
  blobDigest,
  OciClient,
  OCI_MANIFEST_MEDIA_TYPE,
  TELO_LAYER_ROLE_ANNOTATION,
  TELO_LEGACY_LAYER_MEDIA_TYPE,
  TELO_LAYER_SELECTOR_ANNOTATION,
  TELO_MANIFEST_LAYER_MEDIA_TYPE,
  TELO_PAYLOAD_LAYER_MEDIA_TYPE,
  type OciDescriptor,
  type OciManifest,
} from "./oci-client.js";
import {
  OCI_SCHEME,
  isOciRef,
  parseOciRef,
  parseVersionedRef,
  withRefVersion,
} from "./oci-ref.js";

/** A layer's identity within one artifact: role plus, for a controller layer,
 *  its selector. Role alone is not it — there is one controller layer per
 *  selector. Same shape the release ledger keys on. */
function layerKey(role: string, selector?: ArtifactSelector): string {
  return selector ? `${role}/${selectorKey(selector)}` : role;
}

/** The `layers:` index the bundle's own manifest declares, keyed for lookup.
 *  Read back out of the text rather than passed alongside it, because the text
 *  is what ships — anything else would be a second copy to keep in agreement. */
function declaredLayerIndex(bundle: PublishBundle): Map<string, ArtifactLayer> {
  const declared = readOwnerManifest(bundle.manifest).layers ?? [];
  return new Map(declared.map((layer) => [layerKey(layer.role, layer.selector), layer]));
}

/**
 * Pull only the **manifest layer** and return its verified `telo.yaml` text.
 *
 * This is the one place the OCI manifest is load-bearing: it is fetched by a
 * reference that is usually a mutable tag and Telo never hashes it, so it is used
 * solely to locate the blob carrying `telo.yaml`. Those bytes are then checked
 * against the import's inline pin, which is what makes the rest of the artifact
 * safe to address from the `layers:` index inside them — tampering with the OCI
 * manifest can only change *which* blob is offered as the manifest, and a
 * substituted one fails the pin here.
 *
 * Payload layers are never pulled on this path, so reading a manifest no longer
 * downloads a payload it discards.
 *
 * A pre-layers single-blob artifact is still read here: it contains `telo.yaml`
 * too, which is all this path wants, so every already-published module keeps
 * resolving. What it cannot offer is a `layers:` index — so a module that ships a
 * payload gets a clear "republish" failure at the controller instead, while the
 * npm-backed majority, which ships none, is unaffected.
 */
async function pullManifestLayer(ref: string, client: OciClient): Promise<string> {
  const { reference, integrity } = parseOciRef(ref);
  const manifest = await client.pullManifest(reference);
  const layer =
    manifest.layers.find((l) => l.mediaType === TELO_MANIFEST_LAYER_MEDIA_TYPE) ??
    manifest.layers.find((l) => l.mediaType === TELO_LEGACY_LAYER_MEDIA_TYPE) ??
    manifest.layers[0];
  if (!layer) {
    throw new Error(`OCI artifact ${ref} has no layers`);
  }
  const entries = await readTarGz(await client.pullBlob(layer.digest));

  const teloEntry = entries.find((e) => e.name === DEFAULT_MANIFEST_FILENAME);
  if (!teloEntry) {
    throw new Error(
      `OCI artifact ${ref} manifest layer does not contain ${DEFAULT_MANIFEST_FILENAME}`,
    );
  }
  const manifestText =
    typeof teloEntry.content === "string" ? teloEntry.content : teloEntry.content.toString("utf-8");

  // Telo's inline hash is authoritative; the OCI content digest only corroborates.
  if (integrity) {
    await verifyIntegrity(new TextEncoder().encode(manifestText), integrity, ref);
  }
  return manifestText;
}

/**
 * OCI transport: `oci://host/repo@reference` modules on any OCI distribution
 * registry (GHCR / ECR / Docker Hub / Harbor), over a hand-rolled minimal
 * client. A module is one OCI artifact whose layers are the module's layers —
 * `telo.yaml` in its own blob, then one blob per controller selector, plus the
 * `assets` and `common` blobs — so a client fetches only what it needs. A flat
 * layer list, not an image index: the manifest and asset layers are
 * platform-neutral, so a manifest list would duplicate them per platform entry
 * and add a round trip for a selection made from the pinned index anyway.
 *
 * Not browser-reachable (token handshake, Docker credentials, tar extraction),
 * so its resolution `source` is Node-only; the editor resolves `oci://` imports
 * through the discovery hub instead.
 */
export class OciTransport implements Transport {
  readonly source: ManifestSource;

  /** One read-side `OciClient` per `(host, repo)`, for this transport's lifetime.
   *
   *  The client caches bearer tokens per scope, but a client built per operation
   *  discards that cache immediately — so every manifest and every blob paid its
   *  own 401→challenge→token round trip, and with it a `~/.docker/config.json`
   *  read and possibly a credential-helper subprocess. Pooling collapses those
   *  to one handshake per repository. An expired token still self-heals:
   *  `authedFetch` re-runs the challenge on a 401 and replaces the entry.
   *
   *  Owned by the instance rather than the module, so a second transport — a
   *  test, or a second in-process kernel — never inherits another's credentials.
   *  `defaultTransportRegistry` memoizes per registry URL, so the production
   *  lifetime is unchanged. Publishing keeps its own client: it already reuses
   *  one across the whole push, and a push-scoped token has no reason to
   *  outlive the command. */
  private readonly readClients = new Map<string, OciClient>();

  constructor() {
    this.source = {
      supports: (url) => this.supports(url),
      read: async (url) => {
        const { host, repo, reference } = parseOciRef(url);
        const manifest = await pullManifestLayer(url, this.readClient(host, repo));
        return { text: manifest, source: `${OCI_SCHEME}${host}/${repo}@${reference}` };
      },
      resolveRelative: (base, relative) => this.resolveRelative(base, relative),
    };
  }

  private readClient(host: string, repo: string): OciClient {
    const key = `${host}/${repo}`;
    const existing = this.readClients.get(key);
    if (existing) return existing;
    const client = new OciClient(host, repo);
    this.readClients.set(key, client);
    return client;
  }

  supports(ref: string): boolean {
    return isOciRef(ref);
  }

  /** Keyed by the ref's reference — a tag, or a `sha256:` digest, or the
   *  implicit `latest` — so every resolvable ref stays cacheable. (The hub's
   *  `ociManifestCacheCoords` refuses everything but an explicit tag; that is a
   *  discovery-index rule, not a property of the key grammar.) */
  cacheCoords(ref: string): ManifestCacheCoords | null {
    let parsed: ReturnType<typeof parseOciRef>;
    try {
      parsed = parseOciRef(ref);
    } catch {
      return null;
    }
    return {
      transport: "oci",
      host: parsed.host,
      path: parsed.repo,
      version: parsed.reference,
    };
  }

  /** Resolve a relative import against an `oci://` base, normalizing the repo to
   *  a directory base so `../lib` under `oci://ghcr.io/aws/my-app` →
   *  `oci://ghcr.io/aws/lib` (never `oci://ghcr.io/lib`). Non-relative refs pass
   *  through. The reference/tag is dropped — the caller re-pins from the
   *  sibling's own version. */
  resolveRelative(base: string, relative: string): string {
    if (!relative.startsWith(".") && !relative.startsWith("/")) return relative;
    const { host, repo } = parseOciRef(base);
    // Resolve the repo path with standard URL semantics against a directory base.
    const resolved = new URL(relative, `https://${host}/${repo}/`);
    const newRepo = resolved.pathname.replace(/^\/+/, "");
    return `${OCI_SCHEME}${host}/${newRepo}`;
  }

  async listVersions(ref: string): Promise<string[] | null> {
    const { host, repo } = parseOciRef(ref);
    const tags = await this.readClient(host, repo).listTags();
    return tags;
  }

  refVersion(ref: string): string | null {
    // The reference (tag or `sha256:` digest) is what `@` separates. An implicit
    // `latest` (no `@`) is not an upgradeable pin, so return null there; a digest
    // reference flows through raw and the caller's SemVer check skips it. The
    // split itself is the shared grammar — the editor reads the same pin from a
    // browser, where no transport exists.
    return isOciRef(ref) ? (parseVersionedRef(ref)?.version ?? null) : null;
  }

  withVersion(ref: string, version: string): string {
    return withRefVersion(ref, version);
  }

  async digest(ref: string): Promise<string | null> {
    const { host, repo, reference } = parseOciRef(ref);
    return this.readClient(host, repo).headManifest(reference);
  }

  /** Pull one payload layer by the `blob` digest the pinned index supplies. The
   *  OCI layer list is not consulted — a digest addresses a blob directly, so a
   *  republish that reorders layers is simply invisible here rather than a
   *  failure. Content verification is the artifact handle's, which holds the
   *  expected `integrity`. */
  async fetchLayer(ref: string, digest: string): Promise<PayloadFile[]> {
    const { host, repo } = parseOciRef(ref);
    const tar = await this.readClient(host, repo).pullBlob(digest);
    // Verify the transfer against the digest that addressed it. A registry is
    // not trusted to return the blob that was asked for, and this is the only
    // place the pushed bytes exist — the content digest checked after extraction
    // covers the file set, not the archive that carried it.
    const actual = blobDigest(tar);
    if (actual !== digest) {
      throw new IntegrityError(
        `Blob digest mismatch fetching a layer of ${ref}: requested ${digest}, ` +
          `received ${actual}. The registry returned different bytes than were addressed.`,
      );
    }
    return toPayloadFiles(await readTarGz(tar));
  }

  /** Hashes the **UTF-8 encoding of the extracted `telo.yaml`**, which is what
   *  `pullManifestLayer` checks an inline `#sha256-…` pin against on the read
   *  path.
   *
   *  Deliberately uncached — a pin must hash what is published *now*, not a
   *  cached copy — but since `telo.yaml` is its own layer this costs one small
   *  blob per import rather than a full artifact pull, and a corrupt payload
   *  upstream no longer surfaces here as a pinning failure. */
  async manifestHash(ref: string): Promise<string> {
    const { host, repo } = parseOciRef(ref);
    const manifest = await pullManifestLayer(ref, this.readClient(host, repo));
    return `sha256-${await sha256Base64Url(new TextEncoder().encode(manifest))}`;
  }

  /** Project a module's declared provenance onto the standard
   *  `org.opencontainers.image.*` annotation keys. Descriptive only — nothing
   *  addresses the artifact by these. Absent fields are omitted rather than
   *  written empty, so the manifest carries only what the module declared. */
  private static annotationsFor(identity: OwnerManifest): Record<string, string> {
    const mapped: Array<[string, string | undefined]> = [
      ["org.opencontainers.image.title", identity.name],
      ["org.opencontainers.image.version", identity.version],
      ["org.opencontainers.image.description", identity.description],
      ["org.opencontainers.image.source", identity.repository],
      ["org.opencontainers.image.licenses", identity.license],
      ["org.opencontainers.image.documentation", identity.documentation],
    ];
    return Object.fromEntries(mapped.filter((e): e is [string, string] => Boolean(e[1])));
  }

  /** The index as it will be published: `blob` over the gzipped tar this
   *  transport pushes, `integrity` over the layer's file contents. Both are
   *  computed from the files alone, which is what lets the payload builder
   *  write the index into `telo.yaml` before a single byte is pushed. */
  async layerIndex(layers: readonly PayloadLayer[]): Promise<ArtifactLayer[]> {
    const index: ArtifactLayer[] = [];
    for (const layer of layers) {
      if (layer.files.length === 0) continue;
      const tar = await makeTarGz(
        layer.files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
      );
      index.push({
        role: layer.role,
        ...(layer.selector ? { selector: layer.selector } : {}),
        blob: blobDigest(tar),
        integrity: await computeFilesIntegrity(layer.files),
      });
    }
    return index;
  }

  async publish(
    destination: string,
    bundle: PublishBundle,
    _opts: PublishOptions = {},
  ): Promise<PublishResult> {
    const identity = readOwnerManifest(bundle.manifest);
    if (!identity.version) {
      throw new Error("OCI publish requires metadata.version (used as the tag).");
    }

    // Destination must be a full repo (`oci://host/repo`). Identity is the ref,
    // so the repo is never derived from `metadata.namespace`/`name` — a
    // metadata-derived path is wrong whenever the repo differs from the name,
    // and would silently push to a namespace the publisher may not own.
    const afterScheme = destination.replace(/^oci:\/\//, "").replace(/\/+$/, "");
    const slash = afterScheme.indexOf("/");
    const host = slash > 0 ? afterScheme.slice(0, slash) : afterScheme;
    const repo = slash > 0 ? afterScheme.slice(slash + 1) : "";
    if (!repo) {
      throw new Error(
        `OCI publish destination '${destination}' is host-only — it must name a full repository, ` +
          `e.g. 'oci://${host || "ghcr.io"}/<org>/<name>'.`,
      );
    }
    const tag = identity.version;
    const client = new OciClient(host, repo);

    // Push every payload layer first. This ordering is what keeps the index
    // non-circular: the manifest layer is pushed last and names only the layers
    // pushed before it, never itself.
    //
    // The index is NOT written here — `bundle.manifest` already carries it, and
    // rewriting the manifest at this point is precisely the bug this replaced:
    // the bytes a dependent hashed to derive its pin would then never be the
    // bytes pushed. So each pushed blob is CHECKED against what the manifest
    // already claims, which is also the standing test that framing stayed
    // deterministic — a claim nobody can satisfy is a hard failure, not a
    // silently corrected index.
    const declared = declaredLayerIndex(bundle);
    const payloadDescriptors: OciDescriptor[] = [];
    for (const layer of bundle.layers) {
      if (layer.files.length === 0) continue;
      const key = layerKey(layer.role, layer.selector);
      const tar = await makeTarGz(
        layer.files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
      );
      const blob = await client.pushBlob(tar);
      const claim = declared.get(key);
      if (!claim) {
        throw new Error(
          `layer '${key}' is being pushed but the manifest's 'layers:' index does not name it. ` +
            `The index is written by the payload builder before publish, so a layer missing ` +
            `from it would be unaddressable by any importer.`,
        );
      }
      if (claim.blob !== blob) {
        throw new Error(
          `layer '${key}' framed to ${blob}, but the manifest's 'layers:' index claims ` +
            `${claim.blob}. The published telo.yaml is hashed into every dependent's import ` +
            `pin, so it cannot be corrected here — the archive framing must be a pure ` +
            `function of the layer's files.`,
        );
      }
      payloadDescriptors.push({
        mediaType: TELO_PAYLOAD_LAYER_MEDIA_TYPE,
        digest: blob,
        size: tar.length,
        annotations: {
          [TELO_LAYER_ROLE_ANNOTATION]: layer.role,
          ...(layer.selector
            ? { [TELO_LAYER_SELECTOR_ANNOTATION]: selectorKey(layer.selector) }
            : {}),
        },
      });
    }

    // Push telo.yaml as its own layer so a manifest read never has to pull a
    // payload. Verbatim — these are the bytes importers pin.
    const manifestText = bundle.manifest;
    const manifestTar = await makeTarGz([
      { name: DEFAULT_MANIFEST_FILENAME, content: manifestText },
    ]);
    const manifestBlob = await client.pushBlob(manifestTar);

    const config = await client.pushEmptyConfig();
    const annotations = OciTransport.annotationsFor(identity);
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      artifactType: TELO_MANIFEST_LAYER_MEDIA_TYPE,
      config,
      layers: [
        {
          mediaType: TELO_MANIFEST_LAYER_MEDIA_TYPE,
          digest: manifestBlob,
          size: manifestTar.length,
        },
        ...payloadDescriptors,
      ],
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    await client.pushManifest(tag, manifest);

    return { label: `${repo}@${tag}`, url: `${OCI_SCHEME}${host}/${repo}@${tag}` };
  }

  canonicalizeSiblingRef(
    destination: string,
    relativeSource: string,
    version: string,
  ): string {
    // The sibling's repo is the destination repo with the relative applied; the
    // version is its own (identity is the ref, not metadata).
    return `${this.resolveRelative(destination, relativeSource)}@${version}`;
  }
}
