# Telo Hub

Federated discovery over Telo modules — the umbrella metadata index behind
`telo.sh`, `manifests.telo.sh`, and the `search_resources` MCP tool. A single
declarative Telo application ([telo.yaml](telo.yaml)): the ingest tracker, the
search API, and the MCP endpoint are all resources in one manifest.

## What it does

- **Tracks registered module refs** across transports (HTTP registry, OCI).
  A pull tracker periodically enumerates each registered module's versions by
  shelling out to the generic CLI verbs — `telo module versions <ref>`,
  `telo module digest <ref@version>`, `telo module manifest <ref@version> --json`
  — so the transport protocol stays encapsulated behind the CLI and no
  discovery-specific resource kind exists.
- **Digest-reconciles every version on every track.** Version content
  immutability is a convention no transport enforces; an unchanged digest is
  skipped (cheap read), a moved digest re-ingests that version.
- **Caches each version's `telo.yaml`** to an S3-compatible bucket at the
  deterministic key `<transport>/<host>/<path…>/<version>/telo.yaml` — the key
  the CLI computes with the analyzer's shared `manifestCacheKey` helper, so the
  tracker's write key and the editor's read key never drift. In production the
  bucket is Cloudflare R2 bound directly to `manifests.telo.sh` (no compute in
  the read path). The hub **never stores artifact payloads** — install/run
  resolution is origin-direct, so the hub can vanish and every install still
  works.
- **Indexes one row per `(module-version, resource-kind)`** — the unit an LLM
  (or a human) searches for is a resource kind it can import, not a package. A
  kind's identity is `(location ref + suffix)`; the prefix in a manifest's
  `kind:` field is the importer's own alias, so hits carry the bare suffix plus
  the exact module ref.
- **Serves discovery** over HTTP (the `telo.sh` verbs) and MCP. Ranking is
  lexical (Postgres full-text + trigram); the semantic (vector) arm lands in a
  later phase behind the same endpoints.

## HTTP surface

| Verb | Path |
| --- | --- |
| `telo search "<query>"` | `GET /search/modules?q=…` (grouped by module) |
| `telo search --kinds "<query>"` | `GET /search/resources?q=…` (flat kind hits) |
| ref autocomplete | `GET /refs?q=…` (pg_trgm fuzzy, lexical) |
| `telo module versions <ref>` | `GET /module/versions?ref=…` |
| MCP (`search_resources`, `get_module_manifest`) | `POST /mcp` |
| liveness | `GET /health` |

Search returns a fixed top-20 — no pagination. The static manifest read
(`GET manifests.telo.sh/<transport>/<host>/<path…>/<version>/telo.yaml`) never
touches this app.

## Configuration

| Env | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 8040) |
| `DB_CONNECTION` | Postgres connection string (needs `pg_trgm`, available in stock Postgres) |
| `MANIFEST_BUCKET_NAME` / `MANIFEST_BUCKET_ENDPOINT` | S3-compatible manifest cache (R2 / MinIO / RustFS) |
| `MANIFEST_BUCKET_ACCESS_KEY_ID` / `MANIFEST_BUCKET_SECRET_ACCESS_KEY` | Bucket credentials |
| `MANIFEST_BUCKET_FORCE_PATH_STYLE` | `true` for MinIO/RustFS (default `false`) |
| `SEED_REFS` | JSON array of module refs registered idempotently on boot (the curated seed; public registration is a later phase) |
| `TRACK_INTERVAL` | Delay between tracking passes (default `15m`) |
| `TRACK_LOOP` | `false` disables the periodic tracker (tests drive `TrackAll` directly) |
| `TELO_BIN` | Path of the telo CLI the tracker shells out to (default `telo`) |
| `TELO_EGRESS` | `public-only` refuses tracker fetches to private/loopback/link-local hosts (set in the production image) |

## Run locally

The compose stack wires everything (hub, its Postgres, shared object storage):

```sh
pnpm --filter @telorun/cli build   # the dev image shells out to the workspace CLI
docker compose up -d hub
curl "http://localhost:8040/search/resources?q=delay"
```

Or directly against your own infra:

```sh
DB_CONNECTION=postgres://… MANIFEST_BUCKET_NAME=… MANIFEST_BUCKET_ENDPOINT=… \
MANIFEST_BUCKET_ACCESS_KEY_ID=… MANIFEST_BUCKET_SECRET_ACCESS_KEY=… \
SEED_REFS='["std/console","std/timer"]' \
pnpm run telo apps/hub/telo.yaml
```

## Phase 1 limitations

- **Re-exported kinds are not indexed.** A library's `exports.kinds` may
  re-export an imported kind (`Alias.Kind`, transitive); those entries name
  another module's definition, so they produce no `resource_kinds` row for the
  re-exporting library — the kind surfaces only under its defining module. A
  chain-following indexer is a follow-up.
- **Ranking is lexical only.** The semantic (vector) arm and RRF fusion land
  in Phase 2 behind the same endpoints.
- **No public registration.** Modules enter via the curated `SEED_REFS` list;
  the self-service `/register` flow with moderation is Phase 3.

## Tests

End-to-end suite (needs the compose `hub` up and its first tracking pass done):

```sh
pnpm run telo apps/hub/test-suite-e2e.yaml
```
