import {
  DEFAULT_MANIFEST_FILENAME,
  IntegrityError,
  verifyIntegrity,
  type ManifestSource,
} from "@telorun/analyzer";

import { computeFilesIntegrity, injectFilesIntegrity } from "../../bundle/files-integrity.js";
import { readOwnerManifest } from "../../bundle/module-manifest.js";
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

  async digest(ref: string): Promise<string | null> {
    const { host, repo, reference } = parseOciRef(ref);
    return new OciClient(host, repo).headManifest(reference);
  }

  async fetchArtifact(ref: string): Promise<FetchedArtifact> {
    return pullVerified(ref);
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

    // Destination is a full repo (`oci://host/repo`) or host-only
    // (`oci://host`), which defaults the repo to `<namespace>/<name>`.
    const afterScheme = destination.replace(/^oci:\/\//, "").replace(/\/+$/, "");
    const slash = afterScheme.indexOf("/");
    const host = slash > 0 ? afterScheme.slice(0, slash) : afterScheme;
    let repo = slash > 0 ? afterScheme.slice(slash + 1) : "";
    if (!repo) {
      if (!identity.namespace || !identity.name) {
        throw new Error(
          `OCI publish to host-only '${destination}' needs metadata.namespace and metadata.name to default the repo.`,
        );
      }
      repo = `${identity.namespace}/${identity.name}`;
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
    const manifest: OciManifest = {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      artifactType: TELO_LAYER_MEDIA_TYPE,
      config,
      layers: [{ mediaType: TELO_LAYER_MEDIA_TYPE, digest: layerDigest, size: tar.length }],
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
