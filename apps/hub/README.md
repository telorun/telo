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
  skipped (cheap read), a moved digest re-ingests that version. A version whose
  stored integrity pin is null re-ingests too, which is what backfills the pin
  for everything tracked before the hub recorded one.
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
  (display-only). Each entry carries the `kind` it instantiates and that
  instance's own `description`, read from the declaring doc — a bare name says
  you may write `!ref Alias.writeLine` but not what you get. Both are empty for
  a **re-export**, whose declaring doc belongs to another module; `declared`
  (the verbatim entry) is what tells the two apart.
- **Groups modules two ways, so discovery works without a query.** The
  *declared* axis is `metadata.categories` — an open vocabulary of domain
  labels a module (or an individual kind, which overrides its module's) puts
  itself under; whatever labels modules declare are the groups that exist, and
  the hub owns no list. Authors write display text (`[AI, Storage]`) and the
  index derives the match key from it (`category_slug()`, defined once in the
  migration), so `AI` and `ai` collapse into one group and `Data Codecs`
  reaches a URL as `data-codecs`: an open vocabulary cannot be validated into
  agreement, but spelling variance can be normalized out of it. It normalizes
  only what the rule sees — `A. I.` becomes `a-i`, its own group, and a synonym
  always is. Both halves are stored, aligned by position — `categories` is what a
  filter matches and a URL carries, `category_labels` is what a UI prints,
  since `ai` → `AI` is not recoverable. The *derived* axis is `extends`: a
  kind's contract, resolved at
  ingest from the alias prefix through the declaring manifest's own `imports:`
  map into `(owning ref, kind suffix)`. That resolution is what makes every
  backend of one abstract joinable across module boundaries — the abstract's
  module never learns who implements it. Both axes are per version.
- **Serves discovery** over HTTP (the `telo.sh` verbs) and MCP. Ranking is
  **hybrid**: a semantic (vector) arm and the lexical (Postgres full-text +
  trigram) arm fused by Reciprocal Rank Fusion. At ingest each module's latest
  version has its kinds embedded (a self-hosted embeddinggemma-300m model via
  the `embedding` stack) into a pgvector index (the `vector-store-pgvector` module,
  same database); at query the vector arm returns the nearest kind ids and one
  `Sql.Query` RRF-fuses them with the lexical rank. Intent-shaped queries
  ("store files in object storage") resolve even without a substring match.

## HTTP surface

| Verb | Path |
| --- | --- |
| `telo search "<query>"` | `GET /search/modules?q=…&category=…&runtime=…&limit=…&offset=…` (grouped by module) |
| `telo search --kinds "<query>"` | `GET /search/resources?q=…&category=…&runtime=…` (flat kind hits) |
| ref autocomplete | `GET /refs?q=…` (pg_trgm fuzzy, lexical) |
| browse the category facet | `GET /categories` (slug + module count) |
| backends of a contract | `GET /implementations?ref=…&kind=…` |
| everything about one module | `GET /module?ref=…&version=…` |
| `telo module versions <ref>` | `GET /module/versions?ref=…` |
| register a module | `POST /register` (`{ ref }` → validate + index; open, no auth) |
| MCP (`search_resources`, `get_module_manifest`) | `POST /mcp` |
| liveness | `GET /health` |

**Browsing is searching with a filter, not a separate surface.** Both
`/search/*` verbs take an optional `category`, and an empty `q` degrades to an
unranked listing — so `?q=&category=storage` lists a category, and a second
endpoint that would drift from the ranked one never has to exist. `/categories`
stays because it answers a different question (the facet with counts, not a
module list). `search_resources` takes the same optional `category`. The
parameter is slugified on the way in, so either the slug the API returns
(`storage`) or the label an author wrote (`AI`) selects the same group.

**The semantic arm has a relevance floor** (`VECTOR_MIN_SCORE`, cosine
similarity, default `0.5`). An ANN search always returns its nearest `topK`
however far away they are — ask for something the index has nothing like and it
still hands back 50 neighbours, which RRF ranks and the response presents as
answers. The floor turns "the nearest 50" into "the ones actually near", so a
query with no good answer returns nothing rather than a page of noise.

It applies to the **vector arm only**. The lexical arm has its own gate (a
full-text match or a name substring), and thresholding that too would regress
the exact-name lookup hybrid ranking exists to protect. An empty `q` skips the
vector arm entirely, so browsing a category is unaffected. The value is pinned
to the embedding model exactly as the stored vectors are — a different model
scores on a different scale, so re-tune it alongside a re-embed.

`/search/resources` returns a fixed top-20. `/search/modules` takes `limit`
(default 20, max 100) and `offset`, and reports `total` — the pre-limit match
count — because a browse that silently stopped at 20 would read as "that's all
there is". The lexical arm's internal cap lifts when `q` is empty, so a
category listing is not truncated by a ranking cutoff that means nothing
without a query.

The static manifest read
(`GET manifests.telo.sh/<transport>/<host>/<path…>/<version>/telo.yaml`) never
touches this app.

Every module hit carries the module's declared `metadata.name` as `name`. It is
**display identity only** — the ref is the locator, and a name is not unique
across the federation — but it is what the author calls the module and what the
kind registry and diagnostics print, so it is the right heading when the repo
path and the name diverge (`oci://ghcr.io/aws/telo-s3` is `S3`). A client shows
it with the ref, never instead of it.

Every module hit also carries the provenance the module declares in its
`metadata` — `description`, `repository` (source-code URL), and `license` —
indexed per tracked version and served on `/search/modules`,
`/search/resources`, `/refs`, and the `search_resources` MCP tool. A module
that declares none reports them as empty strings, never null.
`/module/versions` is deliberately excluded: it stays a version list rather
than a metadata endpoint. Each newest-first entry is `{ version, integrity }`,
and `integrity` is the one thing beyond the name it carries — the
`sha256-<base64url>` import pin for exactly that version, so an editor
upgrading an `imports:` entry writes the new pin in the request it already
makes rather than downloading the module to hash it. The pin comes from
`telo module manifest --json`, i.e. from the owning transport's own
`manifestHash`, since only the transport knows what its reads verify against.
It is omitted for a version tracked before the hub recorded pins (the tracker
re-ingests those on the next pass) and for a ref no transport can hash — a
consumer reads its absence as "no pin available", never as an error.

Search hits carry both grouping axes: `categories` on the module and on each
kind — each entry a `{ slug, label }` pair, so a chip prints the label and a
click filters by the slug — and `extends: { ref, kind }` on a kind. An empty `extends.ref` with a
non-empty `extends.kind` means the contract is a `Telo.*` built-in abstract,
which belongs to no published module. A module that implements another's
abstract stays a top-level result in its own right — the hub lists it both
under its categories and under `/implementations` of the contract; nesting one
inside the other is a client's presentation choice, not the index's.

### Runtime reach

Telo is polyglot: one manifest is loaded by different kernels, and a kind's
`controllers:` candidates decide which of them can host it. The hub indexes
that, because without it `search_resources` hands a caller composing for the
Rust kernel a kind whose only controller is JavaScript — and nothing in the
response says so. Every kind hit carries
`runtime: { runtimes, languages, portable }`, and `runtime` on `/search/*` and
on `search_resources` filters by kernel (`nodejs`, `rust`) — the same labels an `imports:` entry's `runtime:` field uses.

The facet is **per kind**, and the module roll-up distinguishes full from
partial reach, because coverage genuinely differs inside one module:
`std/console` ships Rust controllers for two of its four kinds. A module hit
carries `runtime.runtimes` (every kernel with at least partial reach) and
`runtime.full` (the subset covering every kind), so a filter reads one list and
a UI still renders "Rust (partial)".

A kind that declares no controllers is `portable: true` with an empty
`runtimes` — no kernel constraint applies, so it satisfies every runtime
filter. That is a flag rather than a list of today's kernels on purpose:
enumerating them would make every stored row wrong the day a third kernel
ships. Language is a **separate axis** from runtime and is left empty for a
`napi`/`wasm` bundle, whose source language the PURL does not determine — a
blank beats a guess.

None of this is derived here. `telo module manifest --json` reports it, because
the mapping from a controller PURL to the kernels that can load it is loader
knowledge; a second copy in this app would drift silently the day a loader
lands.

### Deprecation and provenance

A module or kind may declare `metadata.deprecated: { reason, replacedBy? }`, and
hits carry it as `deprecated: { reason, replacedBy }` — `reason: ""` meaning not
deprecated, since a fixed response shape is what lets typed clients consume this
without probing for optional keys. A kind's replacement is resolved through the
declaring manifest's own `imports:` map into `{ ref, kind }`, exactly as
`extends` is, so it is a target a consumer can follow; an empty `ref` with a
non-empty `kind` names a kernel built-in. A module's replacement is a plain
module ref, and is optional — a module superseded by a kernel built-in has no
module to point at, so the reason carries the instruction.

`publisher` is **derived from the ref**, never declared: ownership is a property
of the host, and a self-asserted field on an open, unauthenticated registry
verifies nothing. It is the host and organisation (`ghcr.io/telorun`), or the
host alone for a `url` module, whose path segments are a directory rather than
an organisation.

### Export lists carry full detail

On a `/search/modules` hit, `exportedKinds` describes **every** exported kind —
capability, description, `extends`, runtime, deprecation — not just the ones
that matched. `matchedKinds` stays a separate list because only it carries a
relevance score.

That redundancy is deliberate: it is what lets a client preview any kind of any
result without a second request. A consumer scanning results is deciding
*between* modules, and a list that can only describe the kinds a query happened
to hit forces a navigation per candidate to answer "what else is in here?".

### `GET /module`

Everything a module page renders, in one call: the module's metadata, every
exported kind with its own capability, contract, runtime and deprecation, the
exported singleton instances, and the tracked version list. `version` selects a
tracked version and defaults to the latest.

It exists because a search hit cannot answer this question. `/search/*` is
ranked and returns only the latest version and only the kinds that matched a
query; this is keyed by ref, serves any tracked version, and carries the full
kind list. A page built on search would need three round trips and still could
not address an older version. Both "never registered" and "no such version"
return one 404 — the caller's next move is the same, and separating them would
leak which refs are tracked.

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
SEED_REFS='["oci://ghcr.io/telorun/console","oci://ghcr.io/telorun/timer"]' \
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

## Tests

End-to-end suite (needs the compose `hub` up and its first tracking pass done):

```sh
pnpm run telo apps/hub/test-suite-e2e.yaml
```
