# Federated registries + inline integrity

## Problem

Today every third-party module (e.g. `aws/*`) lives in one central registry that the Telo team hosts and moderates. This concentrates hosting cost, invites namespace squatting, and makes Telo the party that gets blamed when a module misbehaves. We want anyone to **own and host their own registry**, while Telo hosts only a thin umbrella index for discovery (that index is a separate plan). Federation removes the single trusted server, so **integrity can no longer be enforced server-side** — the client must verify that the bytes it runs are the bytes the author published, or a compromised/expired third-party host becomes silent arbitrary code execution that reflects on Telo.

## Solution

Two coordinated changes, sharing one grammar change:

**Host-qualified source strings.** Extend the module ref grammar so the host can be part of the reference, Go-style: `registry.example.com/ns/name@1.2.0`. A ref whose first path segment contains a dot is a host; a ref without one (`std/console@0.9.0`) keeps meaning the default registry (`registry.telo.run`). Resolution, cache keying, and `telo upgrade`'s version-list fetch all derive the host from the ref instead of a single global constant. The registry protocol already exists as plain HTTP (`GET /<ns>/<name>/<ver>/telo.yaml`, version list `GET /<ns>/<name>`) and is dogfooded in [apps/registry/telo.yaml](apps/registry/telo.yaml) — self-hosting means standing up that protocol at your own host, no new server contract.

**Inline integrity hashes.** Each remote import carries a full SHA-256 content hash, `sha256-<base64url>` (~43 chars, tooling-written, never hand-typed): `Console: std/console@0.9.0#sha256-<base64url>` for the bare-string form, and an `integrity: sha256-<base64url>` sibling for the object form. **The import hash always covers the fetched `telo.yaml` bytes** — for every module, bundle or not. This is the security-critical artifact: `telo.yaml` declares the controller PURLs (the code that runs) and the module's own imports. It's verified on fetch **and re-verified on every cache read** — a single cheap file — in each source's `read()` ([RegistrySource](analyzer/nodejs/src/sources/registry-source.ts), [HttpSource](analyzer/nodejs/src/sources/http-source.ts), and the kernel [cache source](kernel/nodejs/src/manifest-sources/local-manifest-cache-source.ts)).

**Bundle payloads are pinned transitively, not by the import hash.** A module that ships assets (`files:` → `module.tar.gz`) embeds a `filesIntegrity: sha256-<base64url>` field in its `telo.yaml`. Because the import hash covers `telo.yaml`, and `telo.yaml` carries `filesIntegrity`, the payload is pinned through the manifest — a clean Merkle chain (`import hash → telo.yaml → filesIntegrity → payload`). `filesIntegrity` is a **canonical per-file content digest**: SHA-256 over the sorted `{path → sha256(content)}` map of the payload files, **excluding `telo.yaml`** (which the manifest hash already covers, and whose exclusion breaks the self-reference — `telo.yaml` embeds `filesIntegrity`). Hashing file *contents* rather than the tar/gzip bytes sidesteps archive-framing non-determinism, leaves the `module.tar.gz` format and the registry unchanged (`telo.yaml` stays the first entry), and makes the digest re-verifiable from the extracted files on disk. [extract.ts](cli/nodejs/src/bundle/extract.ts) recomputes it from the untarred entries and hard-fails on mismatch; per-file cache re-verification after unpack is a natural follow-up (post-extraction on-disk tampering is v1-out-of-scope, same trust level as extracted `node_modules`).

A **hash mismatch is always a terminal load error, never a cache miss** — the fetch aborts before any controller runs. There is no existing remote-artifact verification in the codebase to build on: the `// sha256:<hex>` header in [kernel/nodejs/src/schema-validator.ts](kernel/nodejs/src/schema-validator.ts) hashes a *locally* compiled validator and self-heals on mismatch (recompile + overwrite), which is the opposite semantics — this feature must not copy its cache-miss behavior.

Telo needs no lockfile: imports are already exact-version with no ranges to freeze, so the only job left — integrity — fits in the source string, preserving the single-file app.

**Merkle enforcement at publish (best-effort by default).** `telo publish` pins every remote import it can resolve — it fetches each dependency's published `telo.yaml`, hashes the bytes, and rewrites the import ref to `…@ver#sha256-…`. An import it *cannot* resolve (dependency not published yet, network blip, a relative sibling published later in the same batch) is a **warning, not a failure** — publish continues. This dissolves any release-ordering requirement: the batch script needs no topological order, and the chain fills in and self-heals over successive republishes. It fails only on a genuine error — an already-pinned import whose bytes no longer match (tamper), or a resolvable import whose bytes can't be read. `telo publish --frozen` (and a future CI `check --frozen`) flips this to strict: any unpinned remote import is a hard error, for teams that want the full-tree guarantee enforced. When every hop is pinned, an app's single root hash transitively pins the whole tree — any swap changes a hash up the chain. Relative/path imports (`source: ../lib`) are exempt: they're not fetched.

**One canonical parser.** The four independent `ns/name@ver` parsers (analyzer [registry-source.ts](analyzer/nodejs/src/sources/registry-source.ts), kernel [local-manifest-cache-source.ts](kernel/nodejs/src/manifest-sources/local-manifest-cache-source.ts), cli [upgrade.ts](cli/nodejs/src/commands/upgrade.ts), cli [bundle/extract.ts](cli/nodejs/src/bundle/extract.ts)) collapse into one shared `parseModuleRef` that returns `{ host?, namespace, name, version, integrity? }`. It lives in `analyzer` (browser-safe, already owns the source classes; kernel already re-imports analyzer code), consumed by kernel and cli. The three duplicated `DEFAULT_REGISTRY_URL` constants collapse to one default the parser applies when no host is present.

**One verified-read choke point (prerequisite).** Remote bytes arrive through four independent fetch sites — `HttpSource.read`, `RegistrySource.read`, the local cache `read`, and the bundle `fetch()` in [extract.ts](cli/nodejs/src/bundle/extract.ts) that sits *entirely outside* the `ManifestSource` chain. Verification must not be bolted onto each or it will drift. Before adding hashing, funnel all remote reads through a single `verifiedFetch(url, expected)` helper: the three `read()` implementations call it; the bundle path calls it and hashes the decompressed tar. The canonical-parser step unifies parsing but not fetching — this is the separate, load-bearing consolidation.

## Decisions

- **Host-qualified refs over scheme-required URLs** — `host/ns/name@ver` keeps ns/name/ver structure for cache keying and `upgrade`, and keeps default-registry refs unchanged; a dot in the first segment is the host sniff. Rejected: forcing `https://…` (works today via `HttpSource` but is verbose and structureless).
- **Full SHA-256, base64url (~43 chars), never truncated** — the inline hash *is* the whole integrity check (unlike a git short SHA, which is a lookup prefix of a fuller stored digest), and the adversary chooses bytes and grinds a malleable tarball. Truncation trades away resistance directly; full 256-bit covers second-preimage *and* collision (malicious original author). Rejected: git-short (broken, ~40-bit) and 128-bit truncation (only covers second-preimage). The `sha256-` prefix allows a later algorithm migration without a grammar change.
- **The import hash always covers `telo.yaml`; bundle payloads pinned via a manifest-embedded `filesIntegrity`** — `telo.yaml` is the security-critical artifact (it names the controller code), so it must always be the hashed thing; a uniform meaning also keeps the verifier from branching on module shape. The payload rides the Merkle chain through `filesIntegrity`, a canonical per-file content digest (excludes `telo.yaml`, breaking the self-reference). Rejected: import hash covering the tar for bundles (leaves `telo.yaml` — the code declaration — unverified); hashing the decompressed-tar bytes (archive-framing non-determinism, and would force `telo.yaml` out of the tarball → a registry-protocol change).
- **`#sha256-<base64>` (SRI-style) in the ref, `integrity:` field in the object form** — algorithm prefix buys future migration; SRI base64 matches web precedent. `#` already means "subpath" in controller PURLs, but that's a different string type. Rejected: a novel delimiter like `!` (less familiar, no ecosystem precedent).
- **Tiered enforcement, best-effort default** — hash present + mismatch is always a hard load error; hash absent on a remote import is a dev-level gap, not a wall. `telo publish` pins what it can and warns on the rest (never fails on absence), so publishing is never blocked by an unpinnable dependency and adoption is incremental; `--frozen` (and a CI `check --frozen`) is the opt-in strict gate that hard-fails on any unpinned remote import. Rejected: hard-failing publish on any unpinned import (couples publish to dependency-first release ordering and blocks incremental adoption). Path imports exempt.
- **Controller npm integrity out of scope** — controllers are PURL-referenced and version-pinned inside the hashed manifest, and npm has its own integrity layer; pinning the manifest pins the controller version. A follow-up may add controller-tarball hashing.
- **Canonical parser in `analyzer`, not a new package** — analyzer is browser-safe and already owns resolution; kernel re-importing analyzer is established precedent (eval-path handling). Rejected: a new shared package (more boundary overhead for one function).
- **Umbrella marketplace is a separate plan** — it's a distinct service (registries self-register, Telo crawls metadata only). This plan makes federation *possible*; discovery across federated registries builds on it.

## Complete example after the change

A single-file app importing from the default registry and a self-hosted third-party registry, every remote import pinned:

```yaml
kind: Telo.Application
metadata:
  name: my-app
  version: 0.1.0
imports:
  Console: std/console@0.9.0#sha256-Yr4l2p...base64
  S3: registry.aws-telo.dev/aws/s3@1.2.0#sha256-9Qk1mZ...base64
  Local: ../my-lib            # path import, exempt from hashing
targets:
  - !ref Console.writeLine
```

`telo install` fetches each remote import from its host, verifies the artifact bytes against the hash before caching, and errors loudly on mismatch (`checksum mismatch: aws/s3@1.2.0 — recorded sha256-9Qk… , got sha256-…`). `telo upgrade S3` rewrites version and hash together. `telo publish` refuses if any remote import lacks a hash.
