# Federated discovery — umbrella metadata hub

Follow-up to [federated-registries.md](federated-registries.md) (federation + inline integrity) and [module-transports.md](module-transports.md) (OCI as a second transport). Those let anyone own and host their own modules — over the HTTP registry protocol or any OCI registry. This plan closes the gap they leave: **discovery fragments across hosts.** It builds on the *identity-is-the-ref* rule from those plans — the hub keys its records off a module's location ref, never `metadata.name`.

## Problem

With modules scattered across `registry.telo.run`, `registry.aws-telo.dev`, `ghcr.io/aws`, and arbitrary hosts, there's no single place to search, and the MCP `search_modules` tool only sees one registry. Federation without discovery is a worse experience than centralization. Worse, keyword search over module names can't answer intent-shaped questions ("I need object storage", "something that speaks gRPC") — the thing an LLM composing a manifest actually asks.

## Solution

**A new `apps/hub` — an umbrella marketplace (Artifact Hub shape).** The hub spans **three origins**: **`telo.sh`** — the dynamic public read plane (the CLI's `/search/*`, `/refs`, `/module/versions` verbs, hub-app-served, cookieless, unauthenticated); **`manifests.telo.sh`** — the static manifest cache (a Cloudflare **R2 bucket bound directly to the domain**, no app or Worker in the request path, so the editor's high-frequency manifest reads are pure CDN and survive any hub-app outage); and **`telo.run`** — the app/auth plane (the registration frontend, moderation queue, everything credentialed). The hub **never hosts third-party artifact payloads** (the controller code / bundle `module.tar.gz`) — install/run resolution is always origin-direct. It stores search metadata and caches each version's `telo.yaml` (so the editor can analyze OCI imports, below). The hub is its **own app** (`apps/hub`), separate from `apps/registry` — which stays **unchanged**: no host, on any transport, gains a new discovery endpoint. It runs its own Postgres with **pgvector** and writes each version's `telo.yaml` to the **R2 manifest cache** (**never** artifact payloads), and exposes the federated MCP + `telo.sh` HTTP surface. Everything it stores is derived (cached `telo.yaml`, extracted resource rows, embeddings), so it rebuilds itself by re-tracking the registered modules — the load-bearing property holds: **the hub can vanish and every install still works**, because resolution never routes through it.

**Ingest — register a module ref, enumerate its versions through the telo CLI. No catalog, no host-side index anywhere.** OCI offers no usable enumeration (`_catalog` is unsupported on GHCR, ECR, and Docker Hub; un-namespaced where it exists; and can't tell a Telo module artifact from an ordinary container image), and — following the Artifact Hub model — the answer is not to invent one but to register the **specific module** and enumerate only its **versions**, which every transport already supports per-repo. A publisher registers a single module ref — `oci://ghcr.io/aws/telo-s3` (OCI) or `registry.aws-telo.dev/aws/s3` (HTTP) — one per module. A pull **tracker** — the hub's **telo ingest tracker**, itself a declarative Telo app — periodically enumerates that module's versions by invoking the `telo module versions <ref>` CLI verb, diffs against what it already holds, and for each **new** version reads `telo.yaml` via `telo module manifest <ref>@<version>`, caches it, parses every `Telo.Definition`, and indexes one row per `(module-version, resource-kind)`. Which protocol resolves a given ref (OCI vs the HTTP registry) is fully **encapsulated behind those CLI verbs** — the tracker never speaks it directly. Version *content* immutability is a **convention neither OCI nor the HTTP registry enforces** — a tag can be re-pushed to different bytes — so the tracker cannot fetch-once-and-forget. It records the resolved **content digest** the CLI reports alongside each cached version and, on every track, re-checks that digest for versions it already holds (a cheap read, no re-download); an unchanged digest is skipped, a **moved** digest re-ingests that version (re-read `telo.yaml`, re-cache to the same R2 key, re-embed). So the R2 cache and vectors are reconciled to origin, never permanently stale, and the editor's hash-verified read of a pinned import can't diverge from what the origin now serves. The `telo.yaml` re-read and re-embed happen only on a digest change; a steady-state track is digest-compare-only. Those two read operations are the **generic CLI verbs** `telo module versions <ref>` and `telo module manifest <ref>` (the `npm view` / `docker manifest inspect` analog, useful to any user or script), so the tracker reaches every host **through the telo CLI** and **no discovery-specific resource kind is invented**. The hub is therefore a **single declarative Telo app** end to end: the ingest tracker is a Telo pipeline that shells out to the `telo` CLI for each transport-specific read (a `Run.*` subprocess step per `telo module versions` / `telo module manifest`), and serving (search API, MCP, embedding, vector-store) is declarative alongside it — the hub dogfoods the runtime instead of running a Node service beside it, and the transport protocol stays encapsulated behind those CLI verbs exactly as `telo publish` / `upgrade` already wrap it. Any parse-and-extract step the pipeline needs (reading each `Telo.Definition` out of a cached `telo.yaml`, composing the embed passage) is a resource kind, not inline `JS.Script`, per the runtime's own authoring rules. This adds **no endpoint to the registry protocol and nothing to `apps/registry`** — discovery reuses the existing CLI verbs, so a host needs zero new surface to be discoverable. Registering one module covers all its versions forever; a new *module* is a new registration (the first-party `std` library is seeded once from its known ref list). The hub stores `{ transport, host, path, version }` per module version — enough to reconstruct the exact install ref, never derived from metadata — plus the cached `telo.yaml`.

**`telo.sh` is the cloud CLI — the read verbs as HTTP paths.** The generic verbs the tracker uses (`telo module versions <ref>`, `telo module manifest <ref>`) plus discovery (`search`, ref autocomplete) are exposed over HTTP under the *same* vocabulary — one contract shared by three front-ends (the local CLI, the ingest tracker, the HTTP surface) over a single core (`moduleVersions(ref)` / `moduleManifest(ref)`), never re-implemented per caller:

```
telo module versions <ref>   →  GET telo.sh/module/versions?ref=…                                    (hub app, dynamic)
telo module manifest <ref>   →  GET manifests.telo.sh/<transport>/<host>/<path…>/<version>/telo.yaml  (R2, static)
telo search "<query>"        →  GET telo.sh/search/{resources,modules}?q=…                            (hub app, dynamic)
(ref autocomplete)           →  GET telo.sh/refs?q=…                                                  (hub app, dynamic)
```

The manifest read is the one **static** verb — a plain path-form object on `manifests.telo.sh` (R2 direct binding), no compute in the path — while the rest are dynamic on `telo.sh`. Only the **read** subset maps at all — `install` / `run` / `publish` write local disk or upload and stay CLI-only. Two availability tiers fall out of this split, and the difference is load-bearing:

- **Origin-direct verbs never touch `telo.sh`.** `install`, `run`, `upgrade`, and `module versions|manifest <ref>` resolve against the module's own host through the telo CLI; a browser routing them through the hub is *only* because it can't speak OCI. With `telo.sh` down, anything whose ref you already hold still installs and runs.
- **Discovery verbs structurally require the aggregated index.** `search` and ref autocomplete can't be answered origin-direct — no single host holds a cross-federation index — so the CLI's `telo search` is a thin client of `telo.sh/search/*`, exactly as `helm search hub` queries Artifact Hub (vs. `helm search repo`'s local index). `telo.sh` down degrades discovery only; it never blocks installing a known ref. A locally-synced offline search index is a deferred fast-follow, not v1.

The manifest read is **effectively immutable per version** — a version's bytes change only on the rare origin re-push, which the tracker detects by digest and reconciles (re-write the same R2 key + purge the CDN edge for that object) — so it's a plain static object on `manifests.telo.sh` (R2, path-form key) with a long cache: pure CDN, the hub app entirely out of the path, which keeps the editor's per-load manifest fetches robust; `/module/versions`, `/search/*`, and `/refs` are dynamic, hub-app-served on `telo.sh` (short / no cache).

**Discovery is per-resource, not per-module — `search_resources` replaces `search_modules`.** The unit an LLM (or a human) searches for is a *resource kind* it can import and use, not a package. At ingest the hub parses each cached `telo.yaml`, extracts every `Telo.Definition`, and indexes **one row per `(module-version, resource-kind)`** carrying the kind **suffix** (`metadata.name`, e.g. `Sequence`), its description, and the owning module's full `{ transport, host, path, version }` ref. A kind's identity is that **(location ref + suffix)** pair, never a fixed dotted string: the prefix in a manifest's `kind:` field is the *caller's own import alias* (PascalCase, chosen when they import the module), so the hub cannot and does not return one. `search_resources(query)` returns kind hits, each already carrying the exact location ref — so the follow-up `get_module_manifest(ref)` resolves against the right host over the right transport, and the caller imports the module under an alias of their choosing and writes `<Alias>.<suffix>`. This also **re-keys `get_module_manifest` off the location ref** instead of `namespace/name`, which is required anyway: an OCI module (`ghcr.io/aws/telo-s3`) has no addressable `namespace/name`.

**Semantic search over a composed resource description.** Each indexed resource-kind carries a vector embedding of a **composed passage** — its curated one-line description plus supplementary schema-derived text (below) — so `search_resources` matches on *meaning*, not substring. A single `name + description` is not enough: today **no `Telo.Definition` carries a kind-level description at all** (only the *module* has one, plus per-property schema text), so the embedding input has to be both authored and composed. Embeddings come from the existing stdlib embedding stack, and the vector index goes through the existing `std/vector-store` abstraction — no new *primitive*, one new backend:

- The hub imports `std/embedding` + `std/embedding-openai` and configures an `EmbeddingOpenai.Model` whose `baseUrl` points at a **self-hosted `embeddinggemma-300m` server** exposed over the OpenAI-compatible `/embeddings` API (`model: embeddinggemma-300m`, placeholder `apiKey`). The self-hosted model means no per-query vendor cost and no third-party data egress. `embeddinggemma-300m` yields 768-dim vectors; the model identity is **pinned to the stored vectors** — the hub records `{ embeddingModel, dimensions }`, and changing the model is a **re-embed** (re-track every version, recompute vectors), never an in-place swap. The embedder is **owned as hub deployment infra** (a sidecar in the hub's compose / Dockerfile), so the hub is only searchable while its embedder is up.
- Vectors are stored through `std/vector-store`: the hub declares a `VectorStore.Store` backed by a **new `std/vector-store-pgvector` backend** (the pgvector backend the vector-store roadmap already anticipates). The backend **owns its own `vectors` table** — its name **configurable per store** — living in the **same Postgres database** as the hub's relational resource-kind rows: **two tables, one database**, not one row. At ingest the hub writes the relational row **and** `VectorStore.Record`-upserts the vector under the **same resource-kind row id**; the RRF query (below) joins the two tables on that id. The hub never reaches into the backend's table, so the backend stays a **generic, reusable primitive**. `VectorStore.Match` runs nearest-neighbour at query. The ANN index type + tuning live in the reusable backend, not in the hub.
- The embedded passage is **composed**, not one field: the kind's `<module>.<Kind>` name and capability, its **curated `metadata.description`** (the primary signal), the schema-derived text (`schema` / `inputType` / `outputType` `title` + `description` strings), and the module's own `metadata.description` for framing. The curated line leads; the schema text enriches it and keeps the vector usable for a kind whose description is thin (graceful degradation). Kind-level `metadata.description` is already schema-permitted (`metadata` is open, only `name` is required) and the stdlib's exported kinds already carry one; the hub indexes whatever description exists rather than gating on it.
- At **ingest** the hub embeds that composed passage with `Embedding.Passage` (stored-document intent) and records the vector **for each module's latest version only** — a new version re-embeds its kinds and **supersedes** the prior vectors, so the vector table holds exactly one vector per `(module, resource-kind)`. Older versions keep their relational rows and cached `telo.yaml` (for pinned manifest reads and version history) but carry **no** vector, which stops a many-versioned module from crowding the bounded ANN top-K with near-identical vectors. At **query** time the hub embeds the search string with `Embedding.Query` (search intent) and calls `VectorStore.Match`.
- Ranking is **hybrid**, and the fusion is **one SQL statement, not manifest-side aggregation**: `VectorStore.Match` returns the vector top-K `[{id, rank}]` (the ANN stays inside the vector-store abstraction), then a single `Sql.Query` CTE takes that bounded list as a **bound parameter**, computes the lexical rank via a full-text CTE over name/description in the same Postgres, **RRF-fuses** the two, joins the relational rows by id, and `DISTINCT ON (module) … ORDER BY version DESC` dedups to the latest version — `ORDER BY fused_score LIMIT 20`. Because the vector side is already latest-only, this dedup only has to collapse the lexical CTE's older-version hits. The group-by / sum-of-reciprocal-ranks / sort / join / dedup set-algebra lives in SQL (declarative, testable in isolation), so **nothing aggregates in CEL and no `JS.Script` is reached for**; and because the query only ever sees ranked *ids* passed in — never the embedding — the vector ANN is not buried as hub SQL and the `std/vector-store` decision holds. Exact-name lookups don't regress under pure vector recall.

**Search returns a fixed top-20 — no pagination.** `search_resources` (MCP) and `/search/resources` · `/search/modules` (HTTP) take `{ query }` and return the top 20 fused hits — enough for a caller (an LLM or a human) picking a kind to import, which never pages. Dropping pagination also sidesteps the ranking-stability trap an RRF cursor would carry (fused scores aren't row-intrinsic, so any cursor drifts under concurrent ingest). Version enumeration during **ingest** still follows the transport's own paging (OCI `tags/list` `Link` / `last` cursors), so a many-versioned repo enumerates fully — that paging is unrelated to search.

**Self-service registration frontend — `apps/hub-web`.** A standalone React + Vite SPA (Radix `ui/*` + `lucide-react`, same pattern as `apps/telo-editor`, minus Tauri — it's a browser app), built to static assets that `apps/hub`'s `Http.Server` serves alongside the `/register` API on the **`telo.run` app/auth plane** (registration and moderation are credentialed-adjacent surfaces, never the cookieless `telo.sh` read plane). This is the Artifact Hub Control Panel: a publisher enters a single **module ref** to register — an OCI repo (`oci://ghcr.io/aws/telo-s3`) or an HTTP module path (`registry.aws-telo.dev/aws/s3`); the hub validates the ref resolves (its transport's `read` / `listVersions` succeed and the `telo.yaml` parses as a Telo module) and enqueues it in a **moderation queue** — registrations are held, not tracked on submit. Once approved, the module is scheduled for periodic version tracking; the form surfaces validation failures (unreachable ref, not a Telo module) inline. Submission is **open, no auth** — consistent with "the hub does not vouch for content"; the moderation gate plus ref validation is the anti-spam / anti-SSRF boundary. An **ownership challenge** (an in-repo metadata file, à la `artifacthub-repo.yml`, or DNS TXT proving control of the host) is a fast-follow that grants a verified-publisher badge on the same `/register` flow without reshaping the frontend. The Radix `ui/*` set is **copied per-app** (the editor precedent via `components.json`), not extracted to a shared package.

**The editor resolves OCI imports from the `manifests.telo.sh` static cache, never OCI directly.** A browser can't speak the OCI protocol at all — anonymous token handshake, `Accept` negotiation, no registry CORS, tar extraction — so the browser-safe `analyzer` has no `OciSource` (see [module-transports.md](module-transports.md)). Instead the tracker writes each version's cached `telo.yaml` to an R2 bucket bound directly to `manifests.telo.sh` at a deterministic key — `<transport>/<host>/<path…>/<version>/telo.yaml` — so a multi-segment OCI repo `path` just nests as prefixes (e.g. `oci://ghcr.io/telorun/integrations/jetbrains/youtrack@1.2.0` → `https://manifests.telo.sh/oci/ghcr.io/telorun/integrations/jetbrains/youtrack/1.2.0/telo.yaml`). The editor builds that URL **locally from the parsed import ref** and fetches it with an ordinary CORS GET — **no hub app, no Worker, no compute in the path**, just R2 behind Cloudflare's cache, which is what keeps the editor's per-load fetches robust even when the hub app is down. The ref→key function is a single **browser-safe helper in `analyzer`**, shared with the tracker so read and write keys never drift. The key is the human version/tag, so unpinned imports stay addressable; when the import is pinned the editor **verifies the fetched bytes against the `#sha256-…` hash**, so a compromised cache can't mislead analysis; an unpinned import is analyzed on trust, because the security boundary is install/run (origin-direct, re-verified), not edit time. `manifests.telo.sh` is a **separate registrable domain** from the app/auth origin `telo.run`, cookieless and credential-free — the `githubusercontent.com`-vs-`github.com` split — so untrusted third-party `telo.yaml` never shares an origin with the hub's authenticated surfaces. HTTP-transport manifests stay direct-to-origin (browser-fetchable). Private OCI is never tracked, so it is simply unsupported in the editor.

**Ref & version autocomplete are dynamic `telo.sh` verbs, not static reads.** Typeahead can't come off a static object — the editor (and the CLI) resolve it through the hub. `GET telo.sh/refs?q=youtrack` returns candidate module refs by **fuzzy substring** match (Postgres `pg_trgm`, a GIN trigram index over the reconstructed ref), so the memorable token buried at the end of an OCI path (`…/jetbrains/youtrack`) matches without typing the `oci://ghcr.io/telorun/…` boilerplate and a typo (`youtrak`) still hits — ranked so a last-path-segment hit beats a host/org hit, deduped to the latest version. `GET telo.sh/versions?ref=…` lists the tracked versions once the full ref is known (the browser can't call OCI `tags/list`; the hub has them from tracking). `/refs` is deliberately **lexical** — complete a ref whose name the author already knows — and is *not* the semantic `/search/*` (find a kind by what it does when they don't); different situations, so different verbs, and `/refs` stays a trivial trigram lookup with no embedder in the path. Both surface only **registered, tracked** modules — the same known-set limitation the editor has against a single registry today, now federated.

Namespace ownership needs no central authority: it's a property of the host. `aws` on `registry.aws-telo.dev` (or `ghcr.io/aws`) is aws's by construction — the exact problem the first plan set out to fix. The hub records metadata and may surface provenance/verification badges, but **does not vouch for or gate** content; trust lives at the host + integrity-hash layer.

## Decisions

Rationale and rejected alternatives for the choices made in **Solution** above (that section is the normative spec; this is the design ledger).

- **Hub is a new `apps/hub`, not the registry extended.** Rejected: folding discovery into `apps/registry` (conflates one-origin serving with cross-origin discovery, and forces the registry to carry a vector index it doesn't need).
- **No host-side catalog — discovery reuses the `telo module versions` / `telo module manifest` CLI verbs.** Rejected: a `/catalog` feed on the registry protocol (a new host-side surface every HTTP registry *and* OCI publisher must serve and keep current — OCI can't back it at all, and a hand-maintained feed goes stale so register-once silently misses new versions); org-level enumeration (OCI has none — `_catalog` is unsupported / un-namespaced / can't identify a Telo artifact); a CLI-push announce (loses rebuild-from-tracking, misses modules published without `telo publish`).
- **Ingest drives the generic CLI verbs — no new resource kind.** Rejected: a discovery-only `Transport.*` / hub-local kind whose sole caller is the hub (invents a seam for one consumer, when list/read is already a CLI capability); promoting to a reusable `Module.*` client kind is a clean fast-follow the moment a *second declarative* consumer (in-manifest update-checker, SBOM walker) lands.
- **Hub caches manifests but never payloads.** Rejected: a caching proxy/mirror of the *payloads* at the hub (fixes availability but recentralizes hosting and makes the hub load-bearing for installs — revisit only if origin availability becomes a real problem).
- **Version content is reconciled by digest, not assumed immutable.** Rejected: fetch-once-per-version (treats a convention as a guarantee — serves permanently stale bytes on a re-push, and breaks a pinned import's hash-verified editor read when origin bytes move).
- **Resource kind is the index unit; module is a projection.** Rejected: a *separate* module-granularity index/embedding (the module's `metadata.description` already frames each kind's passage, so module intent surfaces through the resource hits and the roll-up is free); a shape-toggling `groupBy` param on one endpoint (polymorphic response, un-typeable for MCP / clients).
- **Semantic search via the existing `std/embedding` stack, self-hosted OpenAI-compatible backend.** Rejected: an in-process ONNX embedder resource kind (a new Node-native bridge when the OpenAI-compatible abstraction already exists); a hosted embedding vendor (recurring cost + egress of resource metadata).
- **Vector index via `std/vector-store` + a new `std/vector-store-pgvector` backend.** Rejected: raw `sql:` + a hand-rolled `vector(768)` column and `<=>` operator in the hub (buries a reusable primitive as hub-local SQL — the hub is exactly the consumer that justifies shipping the pgvector backend); a hub-owned `vector(768)` column co-located on the resource-kind table (couples the hub to the vector schema; the configurable-table-name split keeps the primitive reusable while still living in one database); a first-class `vector` type in `modules/sql` (the abstraction is `vector-store`, not `sql`).
- **Ranking is hybrid (lexical + vector RRF), fused in one `Sql.Query`, not in CEL.** The vector rank is computed by `Match` and only passed into SQL as ids, so this does *not* reopen the rejection of hub-local vector SQL. Rejected: pure-vector search (regresses exact-name lookups and known-kind recall); a `Run.Sequence` / CEL fusion (stateful aggregation that bottoms out in `JS.Script`); computing the vector rank in the same SQL (needs raw pgvector `<=>` in hub SQL — the buried primitive the pgvector backend exists to avoid); a standalone `Rank.Fuse` kind for v1 (warranted only when fusing lists from stores that can't be joined in one query — here lexical + relational share one Postgres).
- **Search returns a fixed top-20, no pagination; only the latest version is embedded.** Rejected: keyset or offset search pagination (unnecessary for the consumer, and an RRF cursor can't be made stable under concurrent ingest).
- **The hub record keys off the location ref, not `metadata.name`.** The *identity-is-the-ref* rule from [module-transports.md](module-transports.md) applied to discovery; deriving a ref from `metadata.name` produces a non-resolvable location whenever repo path ≠ name (and an OCI module has no addressable `namespace/name`).
- **Transport is part of a module's record identity.** The explicit `oci://` scheme can't be inferred from `host/path` alone, so the record stores `transport`.
- **Three origins: `telo.sh` (dynamic reads), `manifests.telo.sh` (static manifest cache), `telo.run` (app/auth).** Rejected: one host for everything (untrusted content shares an origin with authenticated surfaces); serving the manifest through a single-host Cloudflare **Worker router** on `telo.sh` (adds a request-ceilinged compute hop to the read that must stay maximally available — R2 direct binding serves cache hits with no Worker invocation); raw S3 / a hosted vendor (R2 gives zero egress + free-tier reads and binds straight to the domain).
- **Discovery verbs need the aggregated index; execution verbs don't.** Rejected: a locally-synced offline search index (`helm search repo` analog) for v1 — the hub is the index and CLI search is a thin online client; add local sync only if offline discovery becomes a real ask.
- **Editor resolves OCI from the `manifests.telo.sh` static cache, not an OCI client.** Rejected: an in-editor OCI client (impossible in a browser); injecting Node Docker-credential auth into `analyzer` (breaks its browser-safety invariant); routing the manifest through the hub app or a Worker (puts compute in the editor's highest-frequency, availability-critical read). Private OCI is out of scope for the editor.
- **Ref autocomplete is lexical (`/refs`, `pg_trgm` fuzzy), distinct from semantic `/search/*`.** Rejected: prefix-only completion (buries the memorable token at the end of an OCI path); overloading `/search/*` for typeahead (drags the embedder into every keystroke).
- **Registration is validated, per-module, not open-crawl.** The hub validates the ref resolves and the `telo.yaml` parses before scheduling tracking, dedups refs, and rate-limits; it reads only over the module's own transport, and cached `telo.yaml` served to editors is hash-verified for pinned imports. It still does not vouch for content — trust stays at host + integrity-hash.
- **Registration frontend is a standalone `apps/hub-web`, open submit + moderation queue.** Rejected: colocating the SPA inside `apps/hub` (mixes a Vite frontend build into a Telo backend app); authenticated submission with an ownership challenge for v1 (pulls auth + ownership verification and a cross-app user-store coupling into the hub; slated as a fast-follow verified-publisher badge on the same `/register` flow). The Radix `ui/*` set is copied per-app (editor precedent via `components.json`), not extracted to a shared package.
- **No central namespace authority.** Ownership derives from the host (host-qualified refs from the first plan); the hub is discovery, not identity. Removes the squatting/blame problem structurally.

## Delivery phases

Three phases, each independently shippable and useful; dependencies flow strictly forward, so a later phase only ever adds to an earlier one — never reworks it. Seeding starts curated (the `std` ref list) and opens to the public only in Phase 3.

**Phase 1 — Ingest, relational index, lexical search, editor read path.** ✅ **Shipped** (`apps/hub`; `telo module digest` / `manifest --json` carry the digest and shared cache key). The load-bearing spine, end-to-end without any embedder. Ships: `apps/hub`'s telo ingest tracker (a declarative Telo pipeline shelling to the `telo` CLI to drive `telo module versions` / `telo module manifest`, digest-reconciles, extracts one relational row per `(module-version, resource-kind)` into Postgres); the `manifests.telo.sh` R2 static cache plus the browser-safe ref→key helper in `analyzer` and the editor's OCI-import resolution against it; the `telo.sh` dynamic surface (`/module/versions`, `/refs` `pg_trgm` autocomplete, and `/search/resources` · `/search/modules`) with ranking **lexical-only** (Postgres full-text over name/description — the RRF query with the vector arm stubbed to lexical); the `search_resources` MCP tool and the `telo search` CLI client. The transport-egress guard for the tracker's outbound fetches lands here (it is the first component reaching registered hosts). **Shippable outcome:** federated modules are discoverable and installable, and the editor resolves `oci://` imports — search just isn't semantic yet. Seeded from the curated first-party ref list; no public registration.

**Phase 2 — Semantic ranking.** Purely additive to Phase 1's endpoints — it upgrades ranking, adds no new surface. Ships: the `embeddinggemma-300m` sidecar (hub deployment infra) wired through the existing `std/embedding` / `EmbeddingOpenai.Model`; the new `std/vector-store-pgvector` backend (own `vectors` table, same database); ingest-time embedding of the composed passage for each module's **latest** version only; and the hybrid RRF `Sql.Query` that fuses the `VectorStore.Match` top-K ids with the lexical CTE — replacing the Phase 1 lexical-only ranking behind the same `/search/*` responses. **Shippable outcome:** intent-shaped queries ("store files in object storage") work.

**Phase 3 — Self-service registration.** Opens ingest beyond the curated seed. Ships: `apps/hub-web` (React + Vite SPA, `telo-editor` pattern) built to static assets served by `apps/hub` on the `telo.run` app/auth plane; the open, unauthenticated `/register` form with inline ref-validation feedback; and the moderation queue that gates a submitted ref before any tracking. **Shippable outcome:** publishers register their own modules.

**Fast-follows (post-v1, already scoped out in Decisions):** the ownership-challenge verified-publisher badge on the same `/register` flow; a locally-synced offline search index (`helm search repo` analog); promoting the CLI read verbs to a reusable declarative `Module.*` client kind once a second in-manifest consumer lands.

## API surface — calls & responses

The index unit is the **resource kind** (one row per `(module-version, resource-kind)`); **module** results are a **projection** — a group-by-owning-module roll-up over the same hits. One index, one query, **two endpoints, each a fixed response shape** (no param reshapes a response): `GET telo.sh/search/resources` returns flat kind hits, `GET telo.sh/search/modules` returns the roll-up. Both run the same fused vector+RRF query; `/modules` applies the group-by server-side. MCP exposes `search_resources` (the flat shape) only.

**Resource-first (MCP / LLM) — `GET /search/resources`, flat kind hits:**

```
GET telo.sh/search/resources?q=store+files+in+object+storage
```
```json
{
  "query": "store files in object storage",
  "hits": [
    { "kind": "Bucket", "capability": "Telo.Provider",  "description": "An object-storage bucket for files.",
      "module": { "ref": "oci://ghcr.io/aws/telo-s3", "version": "1.2.0", "description": "AWS S3 object storage for Telo." },
      "score": 0.91 },
    { "kind": "Put",    "capability": "Telo.Invocable", "description": "Uploads an object to a bucket.",
      "module": { "ref": "oci://ghcr.io/aws/telo-s3", "version": "1.2.0", "description": "AWS S3 object storage for Telo." },
      "score": 0.86 }
  ]
}
```

Each hit carries the kind **suffix** (`Bucket`), never a prefixed name — the `<Alias>` is the importer's to choose — plus the exact module ref to import it.

**Module-first (CLI / hub-web browse) — `GET /search/modules`, the same hits grouped:**

```
GET telo.sh/search/modules?q=object+storage
```
```json
{
  "query": "object storage",
  "hits": [
    {
      "module": { "ref": "oci://ghcr.io/aws/telo-s3", "version": "1.2.0", "description": "AWS S3 object storage for Telo." },
      "score": 0.91,
      "matchedKinds": [
        { "kind": "Bucket", "capability": "Telo.Provider",  "score": 0.91 },
        { "kind": "Put",    "capability": "Telo.Invocable", "score": 0.86 },
        { "kind": "Get",    "capability": "Telo.Invocable", "score": 0.84 }
      ],
      "exportedKinds": ["Bucket", "Get", "Put"]
    }
  ]
}
```

`exportedKinds` comes from the index, so the module card lists everything it offers with **no second manifest fetch** — the objection that sank a standalone `search_modules`.

**Ref autocomplete (typeahead) — fuzzy, lexical:**

```
GET telo.sh/refs?q=youtrack
```
```json
{
  "query": "youtrack",
  "refs": [
    { "ref": "oci://ghcr.io/telorun/integrations/jetbrains/youtrack",
      "latestVersion": "2.1.0",
      "description": "JetBrains YouTrack issue-tracking integration." }
  ]
}
```

**Version list (once the ref is known):**

```
GET telo.sh/module/versions?ref=oci://ghcr.io/aws/telo-s3
```
```json
{ "ref": "oci://ghcr.io/aws/telo-s3", "versions": ["1.0.0", "1.1.0", "1.2.0"] }
```

**Manifest fetch (static, R2 — the editor's read path):**

```
GET manifests.telo.sh/oci/ghcr.io/aws/telo-s3/1.2.0/telo.yaml
```
```yaml
kind: Telo.Library
metadata: { name: s3, namespace: aws, version: 1.2.0, description: "AWS S3 object storage for Telo." }
exports: { kinds: [Bucket, Get, Put] }
# … full telo.yaml bytes (hash-verified by the editor when the import is pinned)
```

**The same discovery, from the CLI:**

```
$ telo search "object storage"                 # human default: grouped by module
oci://ghcr.io/aws/telo-s3@1.2.0  —  AWS S3 object storage for Telo.
  Bucket  (Provider)   An object-storage bucket for files.
  Put     (Invocable)  Uploads an object to a bucket.
  Get     (Invocable)  Downloads an object from a bucket.

$ telo search --kinds "object storage"         # flat kinds (the search_resources shape)
Bucket  oci://ghcr.io/aws/telo-s3@1.2.0   An object-storage bucket for files.
Put     oci://ghcr.io/aws/telo-s3@1.2.0   Uploads an object to a bucket.
```

## Complete example after the change

Aws has published `s3` to their own GHCR (see [module-transports.md](module-transports.md)) and registers the `oci://ghcr.io/aws/telo-s3` module once with the hub (via `apps/hub-web`). The tracker enumerates its versions and reads each `telo.yaml` through the telo CLI — the very operations exposed as generic verbs:

```
# What the tracker calls under the hood (and what any user/script can run; also
# HTTP verbs — GET telo.sh/module/versions?ref=…, GET manifests.telo.sh/oci/…/telo.yaml):
telo module versions oci://ghcr.io/aws/telo-s3
# → 1.0.0
#   1.1.0
#   1.2.0
telo module manifest oci://ghcr.io/aws/telo-s3@1.2.0
# → prints the module's telo.yaml (resolved + integrity-verified over OCI)
# These are origin-direct — they work with telo.sh down.
```

For each **new** version the tracker extracts the `S3.Bucket` / `S3.Get` / `S3.Put` kinds and re-embeds each kind's composed passage via the self-hosted `embeddinggemma-300m`, **superseding the prior version's vectors** so only the latest version stays in the vector table (older versions keep their relational rows for pinned manifest reads). New versions are picked up automatically on the next track; a new *module* is a new registration. From then on:

```
# Semantic discovery — needs the aggregated index, so it goes through telo.sh.
# In the CLI (telo search --kinds "…") or MCP (search_resources), same query, one core:
telo search --kinds "store files in object storage"   # → GET telo.sh/search/resources?q=…
# → S3.Bucket @ oci://ghcr.io/aws/telo-s3@1.2.0  (semantic hit, no substring match on "s3")
#   + the exact location ref, so the follow-up manifest read resolves it over OCI
```

```yaml
imports:
  S3: oci://ghcr.io/aws/telo-s3@1.2.0#sha256-9Qk1mZ...   # editor GETs manifests.telo.sh/oci/…/1.2.0/telo.yaml, then hash-verifies
```

The editor autocompletes refs via `telo.sh/refs?q=…`, and type-checks `S3.*` from the CDN-cached, hash-verified `telo.yaml` on `manifests.telo.sh` (R2, no compute in the path); `telo install` pulls the blob straight from GHCR — the hub never touches the payload bytes, and if `telo.sh` is down every install still works.
