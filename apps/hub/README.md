# Telo Hub

Federated discovery over Telo modules — the umbrella metadata index behind
`telo.sh`, `manifests.telo.sh`, and the `search_resources` MCP tool. A single
declarative Telo application ([telo.yaml](telo.yaml)): the ingest tracker, the
search API, and the MCP endpoint are all resources in one manifest.

## What it does

- **Tracks registered module refs** across transports — the HTTP registry
  (`<ns>/<name>`), OCI (`oci://<host>/<repo>`), and a direct manifest URL
  (`https://<host>/<path>/telo.yaml`, transport `url`).
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
  the exact module ref. Only **exported** kinds are searchable — a kind a library
  gates out of `exports.kinds` is not importable, so it is never returned.
- **Indexes a library's exported instances too** (`module_resources`). A public
  surface is two lists: `exports.kinds` (kinds you may instantiate) and
  `exports.resources` (ready-made singletons referenced as
  `!ref <Alias>.<name>`). A library may offer either or both — a library that
  exports only ready-made singletons and no kinds at all is legitimate, so a
  kinds-only index showed none of its actual entry points. Surfaced as
  `exportedResources` on a module hit; not independently searchable yet
  (display-only).
- **Serves discovery** over HTTP (the `telo.sh` verbs) and MCP. Ranking is
  **hybrid**: a semantic (vector) arm and the lexical (Postgres full-text +
  trigram) arm fused by Reciprocal Rank Fusion. At ingest each module's latest
  version has its kinds embedded (a self-hosted embeddinggemma-300m model via
  the `std/embedding` stack) into a pgvector index (`std/vector-store-pgvector`,
  same database); at query the vector arm returns the nearest kind ids and one
  `Sql.Query` RRF-fuses them with the lexical rank. Intent-shaped queries
  ("store files in object storage") resolve even without a substring match.

## HTTP surface

| Verb | Path |
| --- | --- |
| `telo search "<query>"` | `GET /search/modules?q=…` (grouped by module) |
| `telo search --kinds "<query>"` | `GET /search/resources?q=…` (flat kind hits) |
| ref autocomplete | `GET /refs?q=…` (pg_trgm fuzzy, lexical) |
| `telo module versions <ref>` | `GET /module/versions?ref=…` |
| register a module | `POST /register` (`{ ref }` → validate + index; open, no auth) |
| MCP (`search_resources`, `get_module_manifest`) | `POST /mcp` |
| liveness | `GET /health` |

Search returns a fixed top-20 — no pagination. The static manifest read
(`GET manifests.telo.sh/<transport>/<host>/<path…>/<version>/telo.yaml`) never
touches this app.

## Configuration

| Env | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 8040) |
| `DB_CONNECTION` | Postgres connection string (needs `pg_trgm` + the `vector` extension — use a `pgvector/pgvector` image) |
| `EMBEDDER_BASE_URL` | OpenAI-compatible `/v1` base URL of the self-hosted embeddinggemma-300m sidecar (semantic search); the compose sidecar uses the ungated `onnx-community` mirror, no token needed |
| `MANIFEST_BUCKET_NAME` / `MANIFEST_BUCKET_ENDPOINT` | S3-compatible manifest cache (R2 / MinIO / RustFS) |
| `MANIFEST_BUCKET_ACCESS_KEY_ID` / `MANIFEST_BUCKET_SECRET_ACCESS_KEY` | Bucket credentials |
| `MANIFEST_BUCKET_FORCE_PATH_STYLE` | `true` for MinIO/RustFS (default `false`) |
| `SEED_REFS` | JSON array of module refs registered idempotently on boot (the curated seed; publishers also self-register via `POST /register`) |
| `TRACK_INTERVAL` | Delay between tracking passes (default `15m`) |
| `TRACK_LOOP` | `false` disables the periodic tracker (tests drive `TrackAll` directly) |
| `TELO_BIN` | Path of the telo CLI the tracker shells out to (default `telo`) |
| `REGISTER_RATE_LIMIT` | Max `POST /register` calls per client IP per window (default `5`) |
| `REGISTER_RATE_WINDOW` | Sliding window for that limit (default `10m`) |
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

## Registration

Modules enter the index two ways:

- **Curated seed** — the `SEED_REFS` JSON array, registered idempotently on boot.
- **Self-service `POST /register`** — open and unauthenticated, so it is layered:
  1. **Per-IP rate limit** (`RateLimit.Guard`, default 5 per 10m) — exceeded
     requests get a `429` with `Retry-After`. Rejected refs still consume budget,
     so hammering junk is not free.
  2. **Shape gate** — the ref must look like a remote module ref: `<ns>/<name>`,
     `oci://<host>/<path>`, or `https://<host>/<path>`. This is a security
     boundary, not a nicety: the CLI resolves a path-like or cwd-resolvable ref
     as a **local** manifest read off disk, short-circuiting before any egress
     check, so an ungated `/etc/passwd` would make this endpoint a filesystem
     existence oracle. It also rejects a leading `-` (so `--help` can't be read
     as a flag), plaintext `http://`, and a userinfo authority
     (`https://evil.com@internal/…`).
  3. **Resolution check** — `telo module versions`, then `telo module manifest`
     at the latest version, confirm it's a real Telo module. The manifest's root
     doc must be a **`Telo.Library`**: an Application is a runnable root that
     cannot be imported, so it defines no importable kinds and would store a
     record indexing nothing.
  4. **Insert, then index the latest version inline** — bounded, constant work
     (one digest + one manifest read + one embed) regardless of how many versions
     the module has, so a `200` means it is actually searchable. The periodic
     loop backfills older versions; only the latest is embedded/searched anyway.

  The row is inserted *before* the inline index, so even if that fails the module
  stays registered and the loop retries it. A malformed, unreachable, or
  non-module ref returns `400` with the reason; an indexing failure is logged
  server-side with its cause and returns only the error **code** (this endpoint
  is anonymous — raw messages can carry host paths or upstream detail). There is
  **no moderation queue**; the hub never vouches for content (trust lives at host
  + integrity-hash).

The periodic tracker remains the **reconciler**: it picks up new versions,
re-pushed digests, and any module whose inline first track failed.

The browser-facing registration form is a separate static SPA,
[`apps/hub-web`](../hub-web) (deployed to GitHub Pages at `hub.telo.run`), which
POSTs to this verb cross-origin.

### `url` transport — weaker guarantees

A direct manifest URL addresses **one file**, not a versioned repo, so it differs
from registry/OCI refs in ways worth knowing:

- **Its version list is always one entry** — whatever `metadata.version` the file
  currently declares (a manifest without one can't be registered at all).
- **It is effectively latest-only for install.** `telo install` resolves the URL
  to whatever it serves *now*, so a pinned `#sha256-…` breaks once the file
  changes. A moving URL (`refs/heads/main`) is legal but mutable by design.
- **Superseded versions survive only in the hub's cache.** When the file's
  version is bumped, the previous version's bytes are gone from origin, so for
  `url` modules the hub is the sole archive — a real dent in the otherwise
  load-bearing "the hub can vanish and every install still works" property.

Content changes are still caught: each track re-checks the digest and re-ingests
when it moves, so the index and cache never drift from what the URL serves.

## Limitations & follow-ups

- **Re-exported kinds are not indexed.** A library's `exports.kinds` may
  re-export an imported kind (`Alias.Kind`, transitive); those entries name
  another module's definition, so they produce no `resource_kinds` row for the
  re-exporting library — the kind surfaces only under its defining module. A
  chain-following indexer is a follow-up.
- **Schema-derived passage enrichment is a follow-up.** The embedded passage is
  composed from the kind name, capability, and curated descriptions; pulling
  `title`/`description` strings out of each kind's `schema`/`inputType`/
  `outputType` (graceful degradation for thin descriptions) is not yet wired.

> **Interim import.** The hub imports `vector-store-pgvector` by relative path
> (`../../modules/vector-store-pgvector`) until that module is published to the
> registry. Flip it to `std/vector-store-pgvector@0.1.0` once it ships — the
> Docker `telo install` build resolves the registry form.

## Tests

End-to-end suite (needs the compose `hub` up and its first tracking pass done):

```sh
pnpm run telo apps/hub/test-suite-e2e.yaml
```
