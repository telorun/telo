import {
  DEFAULT_MANIFEST_FILENAME,
  IntegrityError,
  nestedOciRef,
  selectorKey,
  sha256Base64Url,
  splitIntegrity,
  verifyIntegrity,
  type ArtifactLayer,
  type ArtifactSelector,
  type ManifestCacheCoords,
  type ManifestSource,
  type ParsedOciRef,
} from "@telorun/analyzer";
import { fileURLToPath } from "url";
import {
  computeFilesIntegrity,
  type PayloadFile,
} from "../../bundle/files-integrity.js";
import { readOwnerManifest } from "../../bundle/module-manifest.js";
import { makeTarGz, readTarGz, toPayloadFiles } from "../../bundle/tar.js";
import type {
  CachedModuleView,
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
  TELO_LAYER_MODULE_ANNOTATION,
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
import { nestedImportPath, nestedManifestEntry, nestedModuleDirectory } from "./nested-modules.js";

/** The `org.opencontainers.image.*` keys this transport projects from module
 *  `metadata` — one table for the projection and for refusing an author
 *  annotation that would shadow one. */
const METADATA_ANNOTATIONS: ReadonlyArray<{
  key: string;
  field: "name" | "version" | "description" | "repository" | "license" | "documentation";
}> = [
  { key: "org.opencontainers.image.title", field: "name" },
  { key: "org.opencontainers.image.version", field: "version" },
  { key: "org.opencontainers.image.description", field: "description" },
  { key: "org.opencontainers.image.source", field: "repository" },
  { key: "org.opencontainers.image.licenses", field: "license" },
  { key: "org.opencontainers.image.documentation", field: "documentation" },
];

/** A layer's identity within one artifact: role plus, for a controller layer,
 *  its selector. Role alone is not it — there is one controller layer per
 *  selector. Same shape the release ledger keys on. */
function layerKey(role: string, selector?: ArtifactSelector): string {
  return selector ? `${role}/${selectorKey(selector)}` : role;
}

/** The `layers:` index the bundle's own manifest declares, keyed for lookup.
 *  Read back out of the text rather than passed alongside it, because the text
 *  is what ships — anything else would be a second copy to keep in agreement. */
function declaredLayerIndex(manifest: string): Map<string, ArtifactLayer> {
  const declared = readOwnerManifest(manifest).layers ?? [];
  return new Map(declared.map((layer) => [layerKey(layer.role, layer.selector), layer]));
}

/**
 * Pull only the **manifest layer** and return its verified `telo.yaml` text,
 * the digest of the OCI manifest the reference resolved to, and every file the
 * layer carries — the manifests of the modules nested in the artifact among
 * them, each verified against its own import's pin when it is read.
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
async function pullManifestLayer(ref: string, client: OciClient): Promise<ManifestLayerRead> {
  const { reference, integrity } = parseOciRef(ref);
  const { manifest, digest } = await client.pullManifestDigested(reference);
  if (reference.startsWith("sha256:") && digest !== reference) {
    throw new IntegrityError(
      `OCI manifest digest mismatch reading ${ref}: requested ${reference}, received ${digest}. ` +
        `The registry returned a different manifest than the digest names.`,
    );
  }
  const layer =
    manifest.layers.find((l) => l.mediaType === TELO_MANIFEST_LAYER_MEDIA_TYPE) ??
    manifest.layers.find((l) => l.mediaType === TELO_LEGACY_LAYER_MEDIA_TYPE) ??
    manifest.layers[0];
  if (!layer) {
    throw new Error(`OCI artifact ${ref} has no layers`);
  }
  const blob = await client.pullBlob(layer.digest);
  // The manifest layer is what a nested module's manifest is read out of, so
  // its bytes are held to the descriptor that named them.
  const received = blobDigest(blob);
  if (received !== layer.digest) {
    throw new IntegrityError(
      `Blob digest mismatch reading the manifest layer of ${ref}: requested ${layer.digest}, ` +
        `received ${received}. The registry returned different bytes than were addressed.`,
    );
  }
  const entries = await readTarGz(blob);
  const files = new Map<string, string>();
  for (const entry of entries) {
    if ("link" in entry) continue;
    files.set(
      entry.name,
      typeof entry.content === "string" ? entry.content : entry.content.toString("utf-8"),
    );
  }

  const teloEntry = entries.find((e) => e.name === DEFAULT_MANIFEST_FILENAME);
  if (!teloEntry) {
    throw new Error(
      `OCI artifact ${ref} manifest layer does not contain ${DEFAULT_MANIFEST_FILENAME}`,
    );
  }
  if ("link" in teloEntry) {
    throw new Error(
      `OCI artifact ${ref} manifest layer carries ${DEFAULT_MANIFEST_FILENAME} as a symbolic link; ` +
        `it must be a regular file.`,
    );
  }
  const manifestText =
    typeof teloEntry.content === "string" ? teloEntry.content : teloEntry.content.toString("utf-8");

  // Telo's inline hash is authoritative; the OCI content digest only corroborates.
  if (integrity) {
    await verifyIntegrity(new TextEncoder().encode(manifestText), integrity, ref);
  }
  return { text: manifestText, digest, files };
}

/** One read of an artifact's manifest layer: its `telo.yaml`, the OCI manifest
 *  digest the reference resolved to, and every regular file the layer carries
 *  — the manifests of the modules shipped inside it among them. */
interface ManifestLayerRead {
  text: string;
  digest: string;
  files: ManifestLayerFiles;
}

/** An artifact's manifest layer, path → text. Immutable for a digest. */
type ManifestLayerFiles = ReadonlyMap<string, string>;

function artifactKey(host: string, repo: string, digest: string): string {
  return `${host}/${repo}@${digest}`;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
}

/**
 * OCI transport: `oci://host/repo@reference` modules on any OCI distribution
 * registry (GHCR / ECR / Docker Hub / Harbor), over a hand-rolled minimal
 * client. A module is one OCI artifact whose layers are the module's layers —
 * `telo.yaml` in its own blob, then one blob per controller, library and native selector, plus the
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

  /** Manifest layers by `host/repo@sha256:…`. Content-addressed, so holding one
   *  for the transport's lifetime can never serve a stale answer. A rejection is
   *  dropped so the next ask retries. */
  private readonly manifestLayers = new Map<string, Promise<ManifestLayerFiles>>();
  /** The same layers once read, for the synchronous questions (cache
   *  placement, a nested module's directory). */
  private readonly manifestLayersRead = new Map<string, ManifestLayerFiles>();
  /** The OCI manifest digest each read by tag was served, by canonical source.
   *  Overwritten by every read, so a load after a tag moved sees the digest the
   *  registry serves now. */
  private readonly servedDigests = new Map<string, string>();
  /** Digests learnt from the registry for a manifest-cache copy that had no
   *  recorded one, by cached file — asked once per copy. */
  private readonly learntDigests = new Map<string, Promise<{ text: string; digest: string }>>();
  /** The ref an artifact was last requested by as an import root, by artifact —
   *  how a message names a nested module's parent as written, never by digest. */
  private readonly parentsWritten = new Map<string, string>();

  constructor() {
    this.source = {
      supports: (url) => this.supports(url),
      read: async (url) => {
        const parsed = parseOciRef(url);
        if (parsed.path !== undefined) return this.readNested(parsed);
        const { host, repo, reference } = parsed;
        const read = await pullManifestLayer(url, this.readClient(host, repo));
        const source = `${OCI_SCHEME}${host}/${repo}@${reference}`;
        this.servedDigests.set(source, read.digest);
        this.rememberManifestLayer(host, repo, read.digest, read.files);
        return { text: read.text, source };
      },
      resolveRelative: (base, relative) => this.resolveRelative(base, relative),
      // Every `oci://` source a load holds was read by this transport; a copy the
      // manifest cache served is resolved through the cache source instead.
      resolveRelativeImport: async (fromSource, relative) =>
        isOciRef(fromSource) ? this.resolveRelativeImport(fromSource, relative) : undefined,
    };
  }

  /**
   * Read a nested module's manifest — `oci://host/repo@sha256:<digest>/<path>` —
   * out of the manifest layer of the artifact the digest names, and verify it
   * against the import's pin. Reads the manifest layer alone: no payload layer
   * is fetched to read a manifest, the parent's or the nested module's.
   */
  private async readNested(parsed: ParsedOciRef): Promise<{ text: string; source: string }> {
    const { host, repo, reference: digest, integrity } = parsed;
    const path = parsed.path!;
    const files = await this.manifestLayerOf(host, repo, digest);
    const entry = nestedManifestEntry(path, (e) => files.has(e));
    const label = this.describeNested(host, repo, digest, path);
    if (entry === undefined) {
      throw new Error(
        `${label}: the artifact's manifest layer carries no module there — neither ` +
          `'${path}/${DEFAULT_MANIFEST_FILENAME}' nor '${path}'.`,
      );
    }
    const text = files.get(entry)!;
    if (integrity) await verifyIntegrity(new TextEncoder().encode(text), integrity, label);
    return { text, source: nestedOciRef({ host, repo, digest }, path) };
  }

  /** A nested module named by its parent as written beside its path. */
  private describeNested(host: string, repo: string, digest: string, path: string): string {
    const parent =
      this.parentsWritten.get(artifactKey(host, repo, digest)) ??
      `${OCI_SCHEME}${host}/${repo}@${digest}`;
    return `${parent}, nested module '${path}'`;
  }

  private rememberManifestLayer(
    host: string,
    repo: string,
    digest: string,
    files: ManifestLayerFiles,
  ): void {
    const key = artifactKey(host, repo, digest);
    this.manifestLayersRead.set(key, files);
    if (!this.manifestLayers.has(key)) this.manifestLayers.set(key, Promise.resolve(files));
  }

  /** The manifest layer of the artifact `digest` names, pulled by digest when
   *  this transport has not read it yet. */
  private manifestLayerOf(host: string, repo: string, digest: string): Promise<ManifestLayerFiles> {
    const key = artifactKey(host, repo, digest);
    const known = this.manifestLayers.get(key);
    if (known) return known;
    const work = pullManifestLayer(`${OCI_SCHEME}${host}/${repo}@${digest}`, this.readClient(host, repo)).then(
      (read) => {
        this.manifestLayersRead.set(key, read.files);
        return read.files;
      },
    );
    this.manifestLayers.set(key, work);
    work.catch(() => this.manifestLayers.delete(key));
    return work;
  }

  /**
   * Resolve a relative import declared by the module `ref` names.
   *
   * It names a module shipped inside the same artifact when its path stays
   * inside the artifact root and the artifact's manifest layer carries a module
   * there; the result is that module's identity,
   * `oci://<host>/<repo>@sha256:<digest>/<path>`, carrying the import's pin —
   * built from the digest the artifact resolved to, never a tag. Anything else
   * resolves to a separate artifact exactly as before nested modules existed,
   * so an artifact published before them reads unchanged.
   *
   * `cached` is the manifest cache's copy when that is where `ref` was served
   * from: its digest is then the one recorded when it was cached, learnt from
   * the registry once when none was, and what it carries is answered from the
   * cache first.
   */
  async resolveRelativeImport(
    ref: string,
    relative: string,
    cached?: CachedModuleView,
  ): Promise<string> {
    const parsed = parseOciRef(ref);
    const { host, repo } = parsed;
    const { base, integrity } = splitIntegrity(relative);
    const digest = await this.artifactDigest(parsed, cached);
    const dir =
      parsed.path === undefined
        ? ""
        : cached
          ? nestedModuleDirectory(parsed.path, cached.file)
          : await this.nestedDirectoryFromLayer(host, repo, digest, parsed.path);
    const path = nestedImportPath(dir, base);
    const carried =
      path !== null &&
      (await this.artifactCarries(splitIntegrity(ref).base, parsed, digest, path, cached));
    if (carried) {
      if (parsed.path === undefined) {
        this.parentsWritten.set(artifactKey(host, repo, digest), splitIntegrity(ref).base);
      }
      const nested = nestedOciRef({ host, repo, digest }, path);
      return integrity ? `${nested}#${integrity}` : nested;
    }
    return this.resolveRelative(ref, relative);
  }

  /** The OCI manifest digest of the artifact `parsed` names. */
  private async artifactDigest(parsed: ParsedOciRef, cached?: CachedModuleView): Promise<string> {
    if (parsed.reference.startsWith("sha256:")) return parsed.reference;
    const source = `${OCI_SCHEME}${parsed.host}/${parsed.repo}@${parsed.reference}`;
    if (!cached) {
      const served = this.servedDigests.get(source);
      if (served) return served;
      const read = await pullManifestLayer(source, this.readClient(parsed.host, parsed.repo));
      this.servedDigests.set(source, read.digest);
      this.rememberManifestLayer(parsed.host, parsed.repo, read.digest, read.files);
      return read.digest;
    }
    const recorded = await cached.recordedDigest(source);
    if (recorded) return recorded;
    const learnt = await this.learnCachedDigest(source, parsed, cached);
    if (learnt.text !== cached.text) {
      throw new Error(
        `The manifest cache's copy of ${source} (${cached.file}) is not what the registry serves ` +
          `at that tag now, and nothing recorded which artifact it was cached from, so the modules ` +
          `shipped inside it cannot be identified. Run \`telo install\` to refresh the cache.`,
      );
    }
    return learnt.digest;
  }

  /** Ask the registry, once per cached copy, which artifact the tag resolves to. */
  private learnCachedDigest(
    source: string,
    parsed: ParsedOciRef,
    cached: CachedModuleView,
  ): Promise<{ text: string; digest: string }> {
    const known = this.learntDigests.get(cached.file);
    if (known) return known;
    const work = pullManifestLayer(source, this.readClient(parsed.host, parsed.repo)).then(
      (read) => {
        this.rememberManifestLayer(parsed.host, parsed.repo, read.digest, read.files);
        return { text: read.text, digest: read.digest };
      },
      (err: unknown) => {
        throw new Error(
          `${source} was served from the manifest cache (${cached.file}) with no record of the ` +
            `artifact it was cached from, and the registry could not be asked: ${errorText(err)}. ` +
            `The modules shipped inside it are identified by that artifact's digest — run ` +
            `\`telo install\` while the registry is reachable, which records it.`,
        );
      },
    );
    this.learntDigests.set(cached.file, work);
    work.catch(() => this.learntDigests.delete(cached.file));
    return work;
  }

  private async nestedDirectoryFromLayer(
    host: string,
    repo: string,
    digest: string,
    path: string,
  ): Promise<string> {
    const files = await this.manifestLayerOf(host, repo, digest);
    const entry = nestedManifestEntry(path, (e) => files.has(e));
    if (entry === undefined) {
      throw new Error(`${this.describeNested(host, repo, digest, path)} is not in its artifact's manifest layer.`);
    }
    return nestedModuleDirectory(path, entry);
  }

  /** Whether the artifact `digest` names carries a module at `path`; `from` is
   *  the module whose import asks, as requested. */
  private async artifactCarries(
    from: string,
    parsed: ParsedOciRef,
    digest: string,
    path: string,
    cached?: CachedModuleView,
  ): Promise<boolean> {
    const { host, repo } = parsed;
    if (cached?.holds(nestedOciRef({ host, repo, digest }, path))) return true;
    let files: ManifestLayerFiles;
    try {
      files = await this.manifestLayerOf(host, repo, digest);
    } catch (err) {
      if (!cached) throw err;
      throw new Error(
        `Cannot tell whether ${from} ships a module at '${path}': ` +
          `the manifest cache holds no copy of one, and the manifest layer of ` +
          `${OCI_SCHEME}${host}/${repo}@${digest} could not be read: ${errorText(err)}. Run ` +
          `\`telo install\` while the registry is reachable.`,
      );
    }
    return nestedManifestEntry(path, (e) => files.has(e)) !== undefined;
  }

  nestedModuleDirectory(ref: string, source: string): string | undefined {
    let parsed: ParsedOciRef;
    try {
      parsed = parseOciRef(ref);
    } catch {
      return undefined;
    }
    if (parsed.path === undefined) return undefined;
    if (source.startsWith("file://")) return nestedModuleDirectory(parsed.path, fileURLToPath(source));
    const files = this.manifestLayersRead.get(artifactKey(parsed.host, parsed.repo, parsed.reference));
    const entry = files && nestedManifestEntry(parsed.path, (e) => files.has(e));
    return entry === undefined ? undefined : nestedModuleDirectory(parsed.path, entry);
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
    if (parsed.path !== undefined) {
      // A nested module is cached where its manifest sits in the manifest layer,
      // under the artifact's digest: a mirror of the layer. Its exact entry is
      // known once the layer was read; before that the cache resolves the path
      // as a relative import resolves on disk.
      const files = this.manifestLayersRead.get(
        artifactKey(parsed.host, parsed.repo, parsed.reference),
      );
      const entry = files && nestedManifestEntry(parsed.path, (e) => files.has(e));
      return {
        transport: "oci",
        host: parsed.host,
        path: parsed.repo,
        version: parsed.reference,
        file: entry ?? parsed.path,
      };
    }
    return {
      transport: "oci",
      host: parsed.host,
      path: parsed.repo,
      version: parsed.reference,
    };
  }

  /** Resolve a relative path against an `oci://` base as a SEPARATE artifact,
   *  normalizing the repo to a directory base so `../lib` under
   *  `oci://ghcr.io/aws/my-app` → `oci://ghcr.io/aws/lib` (never
   *  `oci://ghcr.io/lib`). Non-relative refs pass through. The reference/tag is
   *  dropped — the caller re-pins from the sibling's own version. What a module
   *  loaded from an artifact imports is {@link resolveRelativeImport}'s, which
   *  falls back to this when the import names no module shipped inside it. */
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
    const parsed = parseOciRef(splitIntegrity(ref).base);
    const manifest =
      parsed.path !== undefined
        ? (await this.readNested(parsed)).text
        : (await pullManifestLayer(ref, this.readClient(parsed.host, parsed.repo))).text;
    return `sha256-${await sha256Base64Url(new TextEncoder().encode(manifest))}`;
  }

  checkAuthoredAnnotations(annotations: Readonly<Record<string, string>>): void {
    for (const key of Object.keys(annotations)) {
      const derived = METADATA_ANNOTATIONS.find((entry) => entry.key === key);
      if (derived) {
        throw new Error(
          `annotation '${key}' is written from the module's metadata.${derived.field} — ` +
            `set metadata.${derived.field} in telo.yaml instead of passing it as an annotation.`,
        );
      }
    }
  }

  /** The module's declared provenance on the standard `org.opencontainers.image.*`
   *  keys, plus exactly the author's annotations. Descriptive only — nothing
   *  addresses the artifact by these, and the pin does not cover them. Absent
   *  fields are omitted rather than written empty. */
  publishedAnnotations(
    manifest: string,
    annotations: Readonly<Record<string, string>>,
  ): Record<string, string> {
    this.checkAuthoredAnnotations(annotations);
    const identity = readOwnerManifest(manifest);
    const derived: Record<string, string> = {};
    for (const { key, field } of METADATA_ANNOTATIONS) {
      const value = identity[field];
      if (value) derived[key] = value;
    }
    return { ...derived, ...annotations };
  }

  /** The index as it will be published: `blob` over the gzipped tar this
   *  transport pushes, `integrity` over the layer's file contents. Both are
   *  computed from the files alone, which is what lets the payload builder
   *  write the index into `telo.yaml` before a single byte is pushed. */
  async layerIndex(layers: readonly PayloadLayer[]): Promise<ArtifactLayer[]> {
    const index: ArtifactLayer[] = [];
    for (const layer of layers) {
      if (layer.files.length === 0) continue;
      const tar = await makeTarGz(layer.files);
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
    opts: PublishOptions = {},
  ): Promise<PublishResult> {
    const identity = readOwnerManifest(bundle.manifest);
    if (!identity.version) {
      throw new Error("OCI publish requires metadata.version (used as the tag).");
    }
    // Before any push, so a refused annotation leaves the registry untouched.
    const annotations = this.publishedAnnotations(bundle.manifest, opts.annotations ?? {});

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
    const payloadDescriptors: OciDescriptor[] = [];
    const pushLayers = async (
      manifestText: string,
      layers: readonly PayloadLayer[],
      module?: string,
    ): Promise<void> => {
      const declared = declaredLayerIndex(manifestText);
      for (const layer of layers) {
        if (layer.files.length === 0) continue;
        const key = layerKey(layer.role, layer.selector);
        const owner = module ? `layer '${key}' of nested module '${module}'` : `layer '${key}'`;
        const tar = await makeTarGz(layer.files);
        const blob = await client.pushBlob(tar);
        const claim = declared.get(key);
        if (!claim) {
          throw new Error(
            `${owner} is being pushed but the manifest's 'layers:' index does not name it. ` +
              `The index is written by the payload builder before publish, so a layer missing ` +
              `from it would be unaddressable by any importer.`,
          );
        }
        if (claim.blob !== blob) {
          throw new Error(
            `${owner} framed to ${blob}, but the manifest's 'layers:' index claims ` +
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
            ...(module ? { [TELO_LAYER_MODULE_ANNOTATION]: module } : {}),
          },
        });
      }
    };
    await pushLayers(bundle.manifest, bundle.layers);
    for (const nested of bundle.nested ?? []) {
      await pushLayers(nested.manifest, nested.layers, nested.path);
    }

    // Push telo.yaml as its own layer so a manifest read never has to pull a
    // payload. Verbatim — these are the bytes importers pin.
    const manifestText = bundle.manifest;
    const manifestTar = await makeTarGz([
      { name: DEFAULT_MANIFEST_FILENAME, content: manifestText },
      ...(bundle.nested ?? []).map((nested) => ({ name: nested.path, content: nested.manifest })),
    ]);
    const manifestBlob = await client.pushBlob(manifestTar);

    const config = await client.pushEmptyConfig();
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
    const digest = await client.pushManifest(tag, manifest);

    return { label: `${repo}@${tag}`, url: `${OCI_SCHEME}${host}/${repo}@${tag}`, digest };
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
