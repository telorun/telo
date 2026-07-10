# Federated discovery + OCI transport

Follow-up to [federated-registries.md](federated-registries.md). That plan makes self-hosting *possible* (host-qualified refs + inline integrity). This plan closes the two gaps it leaves: publishers still have to **run** a registry server, and discovery **fragments** across hosts. Two independent tracks — ship either first.

## Problem

Once anyone can host their own registry, two frictions appear. **Hosting cost**: the reference registry is a full Telo app (S3 + Postgres + auth, [apps/registry/telo.yaml](apps/registry/telo.yaml)) — real infrastructure most third parties won't stand up just to publish a module. **Discovery**: with modules scattered across `registry.telo.run`, `registry.aws-telo.dev`, and arbitrary hosts, there's no single place to search, and the MCP `search_modules` tool only sees one registry. Federation without discovery is a worse experience than centralization.

## Solution

**Track A — OCI as an alternative artifact transport.** A Telo module is already a tarball of YAML plus controller PURLs; that maps cleanly onto an OCI artifact (a custom `application/vnd.telo.module.v1+tar` media type on a plain OCI manifest). Publishers push to any OCI registry they already operate — GHCR, ECR, Docker Hub, Harbor — via `telo publish`, needing **zero new infrastructure**. A new `OciSource` (`analyzer` source chain) speaks the OCI distribution API — pull manifest descriptor, pull blob — discriminated by an explicit `oci://` scheme so it's unambiguous against the plain-HTTP registry protocol: `oci://ghcr.io/aws/telo-s3@1.2.0`. Auth reuses the ambient Docker credential chain (credential helpers / `~/.docker/config.json`), so `docker login ghcr.io` is the only setup. Telo's inline `#sha256-…` integrity hash from the first plan stays authoritative and verifies the pulled blob bytes; OCI's own content digest is a redundant belt-and-suspenders, not the source of truth — one verification model across all transports.

**Track B — umbrella marketplace (Artifact Hub shape).** A metadata-only index at `telo.run` that **never hosts third-party artifacts**. Registries *self-register* by submitting their base URL; the hub periodically crawls each via a minimal **catalog feed** endpoint (`GET /catalog` → `{ modules: [{ ns, name, versions, description }] }`, added to the registry protocol and to [apps/registry/telo.yaml](apps/registry/telo.yaml)). The hub stores only `{ host, ns, name, versions, description }` — enough to search — and points installs back at the origin host. This preserves the load-bearing Go property from the first plan: **the index can vanish and every install still works**, because resolution never routes through it. The existing MCP surface becomes federated — `search_modules` queries the hub's cross-registry index; `get_module_manifest` fetches from the module's own host. OCI registries are crawled via their native `_catalog` + tags-list APIs, so an OCI-hosted module is discoverable without a Telo-protocol endpoint.

Namespace ownership needs no central authority: it's a property of the host. `aws` on `registry.aws-telo.dev` (or `ghcr.io/aws`) is aws's by construction — the exact problem the first plan set out to fix. The hub indexes metadata and may surface provenance/verification badges, but **does not vouch for or gate** content; trust lives at the host + integrity-hash layer.

## Decisions

- **OCI is additive, not a replacement** — the native HTTP registry protocol stays the reference/default; OCI is opt-in for publishers who already run a registry. Rejected: making OCI the only transport (forces OCI tooling on everyone; the plain-HTTP protocol is simpler for static hosting).
- **Explicit `oci://` scheme, not a bare host sniff** — OCI needs a distinct fetch path (distribution API, not `GET …/telo.yaml`), so the scheme is a clean discriminator for `OciSource`. Rejected: sniffing known OCI hosts (fragile allowlist; ambiguous against the plain-HTTP protocol on the same host).
- **Telo's inline hash stays authoritative across transports** — one integrity model regardless of OCI vs HTTP; the OCI content digest is corroborating, not primary. Avoids two divergent verification codepaths.
- **Metadata-only hub, pull-based crawl + self-registration** — the hub never proxies or stores artifacts, so discovery outages never break installs (resolution is origin-direct). Rejected: a caching proxy/mirror at the hub (would fix availability too, but recentralizes hosting and makes the hub load-bearing for installs — revisit only if origin availability becomes a real problem).
- **Catalog feed is a new registry-protocol endpoint** — enumeration is what an umbrella needs and the current protocol only offers per-registry search. Reference registry implements it; third-party registries opt into discoverability by exposing it. OCI hosts are covered via native `_catalog`.
- **No central namespace authority** — ownership derives from the host (host-qualified refs from the first plan); the hub is discovery, not identity. Removes the squatting/blame problem structurally.
- **Two independent tracks** — OCI (transport) and the hub (discovery) share no code and can ship in either order; neither blocks the other.

## Complete example after the change

Publishing to an existing GHCR registry, and an app mixing transports — all discoverable via `telo.run`, all installed origin-direct:

```yaml
kind: Telo.Application
metadata:
  name: my-app
  version: 0.1.0
imports:
  Console: std/console@0.9.0#sha256-Yr4l2p...            # default registry, HTTP protocol
  S3: oci://ghcr.io/aws/telo-s3@1.2.0#sha256-9Qk1mZ...   # OCI transport, publisher's own GHCR
targets:
  - !ref Console.writeLine
```

`telo publish --oci ghcr.io/aws/telo-s3 ./telo.yaml` pushes the module as an OCI artifact to GHCR using the ambient Docker credentials. Aws (or anyone) registers `ghcr.io/aws` once with the hub; from then on `search_modules "s3"` on the `telo.run` MCP surfaces it, and `telo install` pulls the blob straight from GHCR — the hub never touches the bytes.
