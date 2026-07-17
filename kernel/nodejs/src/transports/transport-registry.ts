import type { ManifestSource } from "@telorun/analyzer";

import { OciTransport } from "./oci/oci-transport.js";
import { RegistryTransport } from "./registry-transport.js";
import type {
  FetchedArtifact,
  PublishBundle,
  PublishOptions,
  PublishResult,
  Transport,
} from "./transport.js";

/** Dispatches ref-scheme-specific operations to the transport that owns a ref.
 *  The loader, cache source, `upgrade`, and `publish` consult this instead of
 *  branching on ref shape. `RegistryTransport` is always last so it is the
 *  fallback for bare / `https` refs, and a scheme-owning transport (OCI, later
 *  S3) claims its refs via `supports()` before the fallback is reached. */
export class TransportRegistry {
  constructor(private readonly transports: Transport[]) {}

  /** The transport that owns `ref`, or `undefined` if none does. */
  forRef(ref: string): Transport | undefined {
    return this.transports.find((t) => t.supports(ref));
  }

  /** The resolution `ManifestSource`s of every registered transport, in order —
   *  the browser-safe subset the loader appends to its source chain. */
  sources(): ManifestSource[] {
    return this.transports.map((t) => t.source);
  }

  /** Cache-path segments for `ref`, from its owning transport; `null` when no
   *  transport owns it or the ref is not cacheable. */
  cacheLocation(ref: string): string[] | null {
    return this.forRef(ref)?.cacheLocation(ref) ?? null;
  }

  /** Published versions for `ref` via its owning transport; `null` when the
   *  module is unpublished. Throws when no transport owns the ref. */
  listVersions(ref: string): Promise<string[] | null> {
    return this.require(ref).listVersions(ref);
  }

  /** Full artifact for `ref` via its owning transport. Throws when no transport
   *  owns the ref. */
  fetchArtifact(ref: string): Promise<FetchedArtifact> {
    return this.require(ref).fetchArtifact(ref);
  }

  /** Cheap content-identity digest for `ref` via its owning transport; `null`
   *  when the version does not exist. Throws when no transport owns the ref. */
  digest(ref: string): Promise<string | null> {
    return this.require(ref).digest(ref);
  }

  /** Publish `bundle` to `destination` via the transport its scheme selects.
   *  Throws when no transport owns the destination. */
  publish(
    destination: string,
    bundle: PublishBundle,
    opts?: PublishOptions,
  ): Promise<PublishResult> {
    return this.require(destination).publish(destination, bundle, opts);
  }

  private require(ref: string): Transport {
    const transport = this.forRef(ref);
    if (!transport) {
      throw new Error(`no transport owns ref '${ref}'`);
    }
    return transport;
  }
}

/** The default transport set. Scheme-owning transports come first; the
 *  `RegistryTransport` is last, the fallback for bare / `https` refs. OCI (and
 *  later S3) claim their `oci://` / `s3://` refs before the fallback is reached. */
export function defaultTransports(registryUrl?: string): Transport[] {
  return [new OciTransport(), new RegistryTransport(registryUrl)];
}

const defaultRegistryCache = new Map<string, TransportRegistry>();

/** A `TransportRegistry` seeded with {@link defaultTransports}, memoized per
 *  `registryUrl`. The default transports are stateless config (a fresh
 *  `OciClient` with its own token cache is created per OCI operation), so one
 *  shared instance per registry URL is safe — and avoids re-instantiating the
 *  whole set on hot paths like `cachePathForCanonical`. */
export function defaultTransportRegistry(registryUrl?: string): TransportRegistry {
  const key = registryUrl ?? "";
  let cached = defaultRegistryCache.get(key);
  if (!cached) {
    cached = new TransportRegistry(defaultTransports(registryUrl));
    defaultRegistryCache.set(key, cached);
  }
  return cached;
}
