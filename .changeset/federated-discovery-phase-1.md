---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Federated discovery, phase 1 — the ingest/search spine behind the telo hub.

- **analyzer**: browser-safe `manifestCacheKey` / `manifestCacheUrl` /
  `ociManifestCacheCoords` helpers plus `ManifestCacheSource`, resolving
  `oci://` imports against the hub's static manifest cache
  (`manifests.telo.sh`) with `#sha256-…` verification for pinned refs. The OCI
  ref grammar (`parseOciRef` / `isOciRef` / `OCI_SCHEME`) moves here from the
  kernel so the tracker's write key and the editor's read key share one source
  of truth. The throws-coverage check now reads `when:` clauses written with
  the `!cel` tag (previously only the inline `${{ }}` string form parsed).
- **kernel**: `Transport.digest(ref)` — a cheap content-identity digest per
  version (OCI: `Docker-Content-Digest` via HEAD; HTTP: hash of the
  `telo.yaml` bytes) so the discovery tracker can detect re-pushed tags
  without re-downloading. OCI `tags/list` now follows pagination `Link`
  headers. New `TELO_EGRESS=public-only` egress guard refuses transport
  fetches to private/loopback/link-local/CGNAT hosts (SSRF guard for
  deployments that fetch registered, attacker-suppliable refs).
- **cli**: `telo module digest <ref>` (the digest verb the tracker records and
  re-checks), `telo module manifest --json` (emits `{ ref, cacheKey,
  manifest }` with the shared cache key), and `telo search "<query>"` /
  `telo search --kinds` — a thin client of the hub's `/search/*` endpoints
  (`TELO_HUB_URL`, default `https://telo.sh`).
