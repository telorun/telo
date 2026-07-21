import {
  DEFAULT_MANIFEST_FILENAME,
  IntegrityError,
  sha256Base64Url,
  splitIntegrity,
  verifyIntegrity,
  type ManifestSource,
} from "@telorun/analyzer";

import { computeFilesIntegrity, injectFilesIntegrity } from "../../bundle/files-integrity.js";
import { readOwnerManifest, type OwnerManifest } from "../../bundle/module-manifest.js";
import { makeTarGz, readTarGz, toPayloadFiles } from "../../bundle/tar.js";
import type {
  FetchedArtifact,
  PublishBundle,
  PublishOptions,
  PublishResult,
  SiblingIdentity,
  Transport,
} from "../transport.js";
import {
  OciClient,
  OCI_MANIFEST_MEDIA_TYPE,
  TELO_LAYER_MEDIA_TYPE,
  type OciManifest,
} from "./oci-client.js";
import { OCI_SCHEME, isOciRef, parseOciRef } from "./oci-ref.js";

/** Pull the module blob, returning its extracted entries and the `telo.yaml`
 *  bytes, verified against the ref's inline hash and its own `filesIntegrity`. */
async function pullVerified(ref: string): Promise<FetchedArtifact> {
  const { host, repo, reference, integrity } = parseOciRef(ref);
  const client = new OciClient(host, repo);
  const manifest = await client.pullManifest(reference);
  const layer =
    manifest.layers.find((l) => l.mediaType === TELO_LAYER_MEDIA_TYPE) ?? manifest.layers[0];
  if (!layer) {
    throw new Error(`OCI artifact ${ref} has no layers`);
  }
  const tar = await client.pullBlob(layer.digest);
  const entries = await readTarGz(tar);

  const teloEntry = entries.find((e) => e.name === DEFAULT_MANIFEST_FILENAME);
  if (!teloEntry) {
    throw new Error(`OCI artifact ${ref} blob does not contain ${DEFAULT_MANIFEST_FILENAME}`);
  }
  const manifestText =
    typeof teloEntry.content === "string" ? teloEntry.content : teloEntry.content.toString("utf-8");

  // Telo's inline hash is authoritative; the OCI content digest only corroborates.
  if (integrity) {
    await verifyIntegrity(new TextEncoder().encode(manifestText), integrity, ref);
  }

  const files = toPayloadFiles(entries);

  const { filesIntegrity } = readOwnerManifest(manifestText);
  if (filesIntegrity) {
    const actual = await computeFilesIntegrity(files);
    if (actual !== filesIntegrity) {
      throw new IntegrityError(
        `Integrity check failed for ${ref}: filesIntegrity expected ${filesIntegrity}, ` +
          `got ${actual}. The payload does not match the recorded hash.`,
      );
    }
  }

  return { manifest: manifestText, files };
}

/**
 * OCI transport: `oci://host/repo@reference` modules on any OCI distribution
 * registry (GHCR / ECR / Docker Hub / Harbor), over a hand-rolled minimal
 * client. A module is a single artifact — one tar blob carrying `telo.yaml`
 * and the `files:` payload — pushed under a standard OCI artifact manifest.
 *
 * Not browser-reachable (token handshake, Docker credentials, tar extraction),
 * so its resolution `source` is Node-only; the editor resolves `oci://` imports
 * through the discovery hub instead.
 */
export class OciTransport implements Transport {
  readonly source: ManifestSource;

  constructor() {
    this.source = {
      supports: (url) => this.supports(url),
      read: async (url) => {
        const { manifest } = await pullVerified(url);
        const { host, repo, reference } = parseOciRef(url);
        return { text: manifest, source: `${OCI_SCHEME}${host}/${repo}@${reference}` };
      },
      resolveRelative: (base, relative) => this.resolveRelative(base, relative),
    };
  }

  supports(ref: string): boolean {
    return isOciRef(ref);
  }

  cacheLocation(ref: string): string[] | null {
    let parsed: ReturnType<typeof parseOciRef>;
    try {
      parsed = parseOciRef(ref);
    } catch {
      return null;
    }
    return ["__oci", parsed.host, ...parsed.repo.split("/"), parsed.reference];
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
    const tags = await new OciClient(host, repo).listTags();
    return tags;
  }

  refVersion(ref: string): string | null {
    // The reference (tag or `sha256:` digest) is what `@` separates. An implicit
    // `latest` (no `@`) is not an upgradeable pin, so return null there; a digest
    // reference flows through raw and the caller's SemVer check skips it.
    const { base } = splitIntegrity(ref);
    if (!base.startsWith(OCI_SCHEME)) return null;
    const at = base.lastIndexOf("@");
    return at > 0 ? base.slice(at + 1) : null;
  }

  withVersion(ref: string, version: string): string {
    const { host, repo } = parseOciRef(ref);
    return `${OCI_SCHEME}${host}/${repo}@${version}`;
  }

  async digest(ref: string): Promise<string | null> {
    const { host, repo, reference } = parseOciRef(ref);
    return new OciClient(host, repo).headManifest(reference);
  }

  async fetchArtifact(ref: string): Promise<FetchedArtifact> {
    return pullVerified(ref);
  }

  /** Hashes the **UTF-8 encoding of the extracted `telo.yaml`**, which is what
   *  `pullVerified` checks an inline `#sha256-…` pin against on the read path.
   *
   *  Cost note: a module is one tar blob, so there is no way to read `telo.yaml`
   *  without pulling the whole artifact — including any `files:` payload — and
   *  this path is deliberately uncached (a pin must hash what is published
   *  *now*, not a cached copy). Two consequences for callers: pinning N imports
   *  costs N full artifact pulls, and `pullVerified` also re-checks the
   *  dependency's `filesIntegrity`, so a corrupt *payload* upstream surfaces
   *  here as a pinning failure rather than a payload error. Both are acceptable
   *  for publish-time pinning, where correctness beats latency and refusing to
   *  pin against a corrupt dependency is the right outcome. */
  async manifestHash(ref: string): Promise<string> {
    const { manifest } = await pullVerified(ref);
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

    // Pin the payload, then pack telo.yaml + files into the single module blob.
    let manifestText = bundle.manifest;
    if (bundle.files.length > 0) {
      manifestText = injectFilesIntegrity(manifestText, await computeFilesIntegrity(bundle.files));
    }
    const tar = await makeTarGz([
      { name: DEFAULT_MANIFEST_FILENAME, content: manifestText },
      ...bundle.files.map((f) => ({ name: f.name, content: Buffer.from(f.content) })),
    ]);

    const client = new OciClient(host, repo);
    const layerDigest = await client.pushBlob(tar);
    const config = await client.pushEmptyConfig();
    const annotations = OciTransport.annotationsFor(identity);
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      artifactType: TELO_LAYER_MEDIA_TYPE,
      config,
      layers: [{ mediaType: TELO_LAYER_MEDIA_TYPE, digest: layerDigest, size: tar.length }],
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    await client.pushManifest(tag, manifest);

    return { label: `${repo}@${tag}`, url: `${OCI_SCHEME}${host}/${repo}@${tag}` };
  }

  canonicalizeSiblingRef(
    destination: string,
    relativeSource: string,
    sibling: SiblingIdentity,
  ): string {
    // The sibling's repo is the destination repo with the relative applied; the
    // version is its own (identity is the ref, not metadata).
    return `${this.resolveRelative(destination, relativeSource)}@${sibling.version}`;
  }
}
