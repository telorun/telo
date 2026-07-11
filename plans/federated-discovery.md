# Federated discovery — umbrella metadata hub

Follow-up to [federated-registries.md](federated-registries.md) (federation + inline integrity) and [module-transports.md](module-transports.md) (OCI as a second transport). Those let anyone own and host their own modules — over the HTTP registry protocol or any OCI registry. This plan closes the gap they leave: **discovery fragments across hosts.** It builds on the *identity-is-the-ref* rule from those plans — the index keys off a module's location ref, never `metadata.name`.

## Problem

With modules scattered across `registry.telo.run`, `registry.aws-telo.dev`, `ghcr.io/aws`, and arbitrary hosts, there's no single place to search, and the MCP `search_modules` tool only sees one registry. Federation without discovery is a worse experience than centralization.

## Solution

**Umbrella marketplace (Artifact Hub shape).** An index at `telo.run` that **never hosts third-party artifact payloads** (the controller code / bundle `module.tar.gz`) — install/run resolution is always origin-direct. It stores search metadata, and — so the editor can analyze OCI imports (below) — caches each version's `telo.yaml`. Registries *self-register* by submitting their base ref; the hub periodically crawls each via a minimal **catalog feed** endpoint (`GET /catalog` → `{ modules: [{ transport, path, versions, description }] }`, added to the registry protocol and to [apps/registry/telo.yaml](apps/registry/telo.yaml)). `path` is the module's **location** on the host (the HTTP registry path or the OCI repo path), not `metadata.name` — per the ref-is-identity rule. The hub stores `{ transport, host, path, versions, description }` per module — enough to search *and* to reconstruct the exact install ref (never derived from metadata) — plus the cached `telo.yaml` per version, and points installs back at the origin host. This preserves the load-bearing Go property from the first plan: **the index can vanish and every install still works**, because resolution never routes through it. The existing MCP surface becomes federated — `search_modules` queries the hub's cross-registry index; `get_module_manifest` fetches from the module's own host over the recorded transport.

**OCI hosts self-register the same way — via a catalog feed, not registry-native crawl.** The OCI distribution API offers no usable enumeration for this: `_catalog` is unsupported on GHCR, ECR, and Docker Hub, and where it exists it is un-namespaced (returns every repo on the registry) and can't tell a Telo module artifact from an ordinary container image. So an OCI publisher opts into discoverability by publishing an explicit module list the hub can read — the **same `/catalog` feed shape**, served from a URL submitted at self-registration (or itself pushed as an OCI artifact and referenced by ref). The hub treats OCI and HTTP hosts identically: it only ever reads a catalog feed, never a registry-native API. Each feed entry carries `transport: "oci" | "http"` so a discovered OCI module round-trips back to its `oci://…` ref.

**The editor resolves OCI imports through the hub, never OCI directly.** A browser can't speak the OCI protocol at all — anonymous token handshake, `Accept` negotiation, no registry CORS, tar extraction — so the browser-safe `analyzer` has no `OciSource` (see [module-transports.md](module-transports.md)). Instead the hub exposes a manifest endpoint (`GET /manifest/<host>/<path>/<ver>` → the cached `telo.yaml`, keyed by the location ref) and the editor fetches OCI manifests from there with an ordinary GET. When the import is pinned, the editor **verifies the hub-served bytes against the `#sha256-…` hash**, so a compromised hub can't mislead analysis; an unpinned import is analyzed on trust, because the security boundary is install/run (origin-direct, re-verified), not edit time. HTTP-transport manifests stay direct-to-origin (browser-fetchable). Private OCI is never crawled, so it is simply unsupported in the editor.

Namespace ownership needs no central authority: it's a property of the host. `aws` on `registry.aws-telo.dev` (or `ghcr.io/aws`) is aws's by construction — the exact problem the first plan set out to fix. The hub indexes metadata and may surface provenance/verification badges, but **does not vouch for or gate** content; trust lives at the host + integrity-hash layer.

## Decisions

- **Hub caches manifests but never payloads, pull-based crawl + self-registration** — the hub stores search metadata plus each version's `telo.yaml` (for editor OCI analysis), but never the artifact payload (controller code / bundle), so discovery outages never break installs (install/run resolution is origin-direct). Rejected: a caching proxy/mirror of the *payloads* at the hub (would fix availability too, but recentralizes hosting and makes the hub load-bearing for installs — revisit only if origin availability becomes a real problem).
- **Catalog feed is a new registry-protocol endpoint, used for every transport** — enumeration is what an umbrella needs and the current protocol only offers per-registry search. Reference registry implements it; third-party HTTP *and* OCI hosts opt into discoverability by exposing the same `/catalog` feed. Rejected: crawling OCI registries via `_catalog` + tags-list (unsupported on GHCR/ECR/Docker Hub, un-namespaced where it exists, and can't distinguish a Telo module from any other image). The hub reads a catalog feed and nothing else, so the crawl path is uniform across transports.
- **The index keys off the location ref, not `metadata.name`** — the catalog feed and hub record carry the module's `path` (HTTP registry path or OCI repo path), so a discovered module reconstructs its exact install ref. This is the *identity-is-the-ref* rule from [module-transports.md](module-transports.md) applied to discovery; deriving a ref from `metadata.name` would produce a non-resolvable location whenever repo path ≠ name.
- **Transport is part of a module's index identity** — each catalog entry and hub record carries `transport` so a discovered OCI module reconstructs its `oci://…` ref and installs origin-direct. The explicit `oci://` scheme means transport can't be inferred from `host/path` alone; the index must record it.
- **Editor resolves OCI through the hub, not an OCI client** — browsers can't speak OCI (token handshake, no CORS, tar extraction), so the browser-safe `analyzer` gets no `OciSource`; the editor reads the hub's cached `telo.yaml` and verifies it against the pinned hash when present. Rejected: an in-editor OCI client (impossible in a browser) and injecting Node Docker-credential auth into `analyzer` (breaks its browser-safety invariant). Private OCI is out of scope for the editor.
- **No central namespace authority** — ownership derives from the host (host-qualified refs from the first plan); the hub is discovery, not identity. Removes the squatting/blame problem structurally.

## Complete example after the change

Aws has published `s3` to their own GHCR (see [module-transports.md](module-transports.md)) and registers `ghcr.io/aws`'s catalog feed once with the hub. From then on:

```
search_modules "s3"            # telo.run MCP surfaces ghcr.io/aws/telo-s3 across all registries
```

```yaml
imports:
  S3: oci://ghcr.io/aws/telo-s3@1.2.0#sha256-9Qk1mZ...   # editor resolves via the hub's cached telo.yaml
```

The editor autocompletes and type-checks `S3.*` from the hub-served, hash-verified manifest; `telo install` pulls the blob straight from GHCR — the hub never touches the payload bytes, and if `telo.run` is down every install still works.
