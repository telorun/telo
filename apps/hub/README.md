# Telo Hub

Federated discovery over Telo modules — the umbrella metadata index behind
`telo.sh`, `manifests.telo.sh`, and the `search_resources` MCP tool. A
declarative Telo application: [telo.yaml](telo.yaml) is the composition root —
it binds the environment, owns the one connection, bucket, embedder, vector index
and shell host, and mounts the HTTP and MCP surfaces — while the work lives in
six libraries beside it.

| File | Owns |
| --- | --- |
| [hub-schema.yaml](hub-schema.yaml) | the tables, the derivations two readers share, and the ingest claim |
| [hub-origin.yaml](hub-origin.yaml) | reading a module from wherever it is published |
| [hub-ingest.yaml](hub-ingest.yaml) | one version → bucket bytes, rows and vectors, as a durable run |
| [hub-search.yaml](hub-search.yaml) | ranked search over kinds and modules |
| [hub-catalog.yaml](hub-catalog.yaml) | keyed reads: one module, one version, one manifest, one registration's progress |
| [hub-registry.yaml](hub-registry.yaml) | validating and recording a submitted ref |

Each library declares the instances it needs as a `resources:` block and is
handed them by the root, so all six read and write **one** connection.
`hub-schema` and `hub-origin` declare `lifecycle: shared`, which is what lets
ingest and registration both reach the claim and the CLI without the composition
being linearized into a chain.

## What it does

- **Tracks registered module refs** across transports — OCI
  (`oci://<host>/<repo>`) and a direct manifest URL
  (`https://<host>/<path>/telo.yaml`, transport `url`).
  A cron pass enumerates each registered module's versions by shelling out to
  the generic CLI verbs — `telo module versions <ref>`,
  `telo module digest <ref@version>`, `telo module manifest <ref@version> --json`
  — so the transport protocol stays encapsulated behind the CLI and no
  discovery-specific resource kind exists.
- **Digest-reconciles every version on every pass.** Version content
  immutability is a convention no transport enforces; an unchanged digest is
  skipped (cheap read), a moved digest re-ingests that version. Enumeration and
  digest resolution are ordinary work; only the ingest itself is a durable run.
- **Ingests one version as one durable run.** The manifest read, the bucket
  write, the relational writes and the re-embed are recorded step by step, so a
  crash part-way is resumed rather than restarted — and the relational writes
  commit as one transaction on the same connection the journal records through,
  which is what makes each step's record commit with the step it describes. A
  transient origin failure is retried inside the run, and once the backoff passes
  30s the run **parks**: an origin outage costs nothing while it waits.
- **Caches each version's `telo.yaml`** to an S3-compatible bucket at the
  deterministic key `<transport>/<host>/<path…>/<version>/telo.yaml` — the key
  the CLI computes with the analyzer's shared `manifestCacheKey` helper, so the
  tracker's write key and studio's read key never drift. In production the
  bucket is Cloudflare R2 bound directly to `manifests.telo.sh` (no compute in
  the read path). The hub **never stores artifact payloads** — install/run
  resolution is origin-direct, so the hub can vanish and every install still
  works.
- **Indexes one row per `(module-version, resource-kind)`** — the unit an LLM
  (or a human) searches for is a resource kind it can import, not a package. A
  kind's identity is `(location ref + suffix)`; the prefix in a manifest's
  `kind:` field is the importer's own alias, so hits carry the bare suffix plus
  the exact module ref. Only **exported** kinds are searchable — a kind a library
  gates out of `exports.kinds` is not importable, so it is never returned. A
  `Telo.NeedType` declares a kind too (one a module can ask for), and is indexed
  as one; so is the built-in vocabulary, tracked at `BUILTINS_REF` (see
  Registration).
- **Indexes a library's exported instances too** (`module_resources`). A public
  surface is two lists: `exports.kinds` (kinds you may instantiate) and
  `exports.resources` (ready-made singletons referenced as
  `!ref <Alias>.<name>`). A library may offer either or both — a library that
  exports only ready-made singletons and no kinds at all is legitimate, so a
  kinds-only index showed none of its actual entry points. Surfaced as
  `exportedResources` on a module hit, and ranked by search exactly as kinds
  are. Each entry carries the `kind` it instantiates and that
  instance's own `description`, read from the declaring doc — a bare name says
  you may write `!ref Alias.writeLine` but not what you get. Both are empty for
  a **re-export**, whose declaring doc belongs to another module; `declared`
  (the verbatim entry) is what tells the two apart.
- **Indexes applications by their declared contract.** A `Telo.Application`
  registers like a library — ref, versions, pins, digest tracking, cached
  manifest — and is indexed by what it asks of whoever runs it: every
  `variables:`, `secrets:` and `ports:` entry, as `telo module manifest --json`
  reports it under `application`. Its own kinds are stored but never exported,
  since an application exports nothing. Search offers applications only to a
  caller that asks for them (`entry=application`).
- **Serves no artifact files.** The hub serves no file an artifact ships — no
  README, no images, no payload. It indexes an application's declared contract
  and caches its `telo.yaml` alone; a consumer that wants a file the artifact
  carries reads it from the artifact at the pinned ref and verifies it against
  the `layers:` index the pin covers.
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
  version has its kinds embedded (by the configured embedding model — a
  self-hosted embeddinggemma-300m by default — via the `embedding` stack) into
  a pgvector index (the `vector-store-pgvector` module,
  same database); at query the vector arm returns the nearest kind ids and one
  `Sql.Query` RRF-fuses them with the lexical rank. Intent-shaped queries
  ("store files in object storage") resolve even without a substring match.
  A third, **identity** arm votes for entries whose qualified name the query
  spells: module name and entry name are split at their capitals, so
  `http server` reads `HttpServer.Server`, and every word of the query must
  appear. A name holding the words as one phrase, in order, counts twice in
  the fusion, so the named module's other kinds rank beside the one named and
  ahead of a kind elsewhere whose description repeats the words. A query that
  names a module therefore leads with that module's kinds; a described need
  leaves the arm empty and the other two decide.

## HTTP surface

| Verb | Path |
| --- | --- |
| `telo search "<query>"` | `GET /search/modules?q=…&category=…&publisher=…&runtime=…&entry=…&sort=…&deprecated=…&contractOnly=…&limit=…&offset=…` (grouped by module) |
| `telo search --kinds "<query>"` | `GET /search/resources?q=…&category=…&publisher=…&runtime=…&entry=…` (flat hits) |
| ref autocomplete | `GET /refs?q=…` (pg_trgm fuzzy, lexical) |
| browse the category facet | `GET /categories?entry=…` (slug + module and kind counts) |
| browse the publisher facet | `GET /publishers?entry=…` (publisher + module count) |
| backends of a contract | `GET /implementations?ref=…&kind=…` |
| modules importing a module | `GET /dependents?ref=…&limit=…&offset=…` |
| ready-made instances of a kind | `GET /instances?ref=…&kind=…` |
| everything about one module | `GET /module?ref=…&version=…` |
| one version's `telo.yaml` | `GET /module/manifest?ref=…&version=…` (`text/yaml`) |
| `telo module versions <ref>` | `GET /module/versions?ref=…` |
| the whole catalogue (sitemaps) | `GET /modules?after=…&limit=…` (every ref `/module` answers for, paged by `seq`) |
| register a module | `POST /register` (`{ ref }` → validate + schedule, `202`; open, no auth) |
| poll a registration | `GET /register/status?ref=` |
| MCP tools (`search_resources`, `get_kinds`, `list_libraries`, `get_module_manifest`, `get_module`, `list_module_versions`, `find_implementations`, `find_instances`, `find_dependents`, `list_categories`, `suggest_module_refs`, and the guide tools `guide_build_ui`, `guide_write_integration_tests`, `guide_design_library`) | `POST /mcp` |
| liveness | `GET /health` |

**Every keyed HTTP read has an MCP twin.** `get_module` mirrors `GET /module`,
`list_module_versions` mirrors `GET /module/versions`, `find_implementations`
mirrors `GET /implementations`, `find_instances` mirrors `GET /instances`,
`list_categories` mirrors `GET /categories`,
and `suggest_module_refs` mirrors `GET /refs` — same handler, same shape,
reached as a tool instead of a query string.

**Three tools are shaped for a caller that pays for every byte it is sent** — a
model, whose context re-sends each result on every later step — and have no
HTTP twin.

- `search_resources` takes one `query` or several `queries` (each answered on
  its own under `results`) and a `limit` per query (default 8, at most 50). Hits
  are grouped under the module that owns them, so a module's ref, version, name
  and description are stated once; a member that says nothing is left out
  (`entry` unless the hit is not a kind, `extends`, `deprecated`, `instances`,
  `siblings`, `runtimes` on a portable hit or one from the built-in vocabulary,
  whose module says `builtin: true`). The category facet is not
  repeated on each response: `list_categories` serves it, and a refused
  `category` still names the real slugs. `categoryFilterDropped` appears only
  when it is true. A call with neither `query` nor `queries` is an error result,
  and a `limit` outside 1–50 is refused as `-32602`.
- `get_kinds` takes `kinds: [{ ref, kind, version? }]` across any number of
  modules, and an optional `telo` version, and answers in text: per module, the
  line to write under `imports:`
  (`<Name>: <ref>@<version>#<integrity>` for an OCI ref, the bare ref for any
  other transport), then each asked kind's document cut verbatim out of the
  cached `telo.yaml` — with every named shape and local parent it references,
  three levels deep, and without the keys that say how the kind is implemented
  (`controllers`, `base`, the template body). A kind extending a kind of
  another module without `base:` takes that parent's fields, so the parent's
  definition follows, two modules up, marked as reached through `extends` —
  read at the version the child's own `imports:` pins the parent at, or at the
  latest tracked one when the hub does not hold that version. A
  name the module does not define is reported beside the kinds it exports; a
  call naming only untracked refs is an error result. An alias-qualified name
  (`Http.Server`) is read by its suffix. **Built-ins are read at one telo
  version** — `telo`, else a version asked for on the built-in vocabulary's own
  ref, else the latest tracked — because a `Telo.<Kind>` reference means the
  telo that runs the manifest, not the declaring module's floor: the
  vocabulary's own kinds (asked for, or reached as a `Telo.<Kind>` parent) are
  headed by a `# Telo — built in to telo <X>: write no import; …` line in
  place of an import line, and the answer closes with every schema fragment, value type, zone
  attribute and format a returned document names, transitively, each printed
  exactly as `telo builtins <name>` prints it. A `telo` the hub tracks no
  vocabulary at is refused as `-32602` (`ERR_UNKNOWN_TELO_VERSION`), naming the
  versions it does track. The argument is a release as `telo --version` prints
  it (`X`); a working copy prints `X+unreleased`, which no hub ever tracks, so
  the tool text sends that caller to `telo builtins <names>` instead.
- `list_libraries` takes an optional `publisher` (`ghcr.io/telorun`) and lists
  every tracked library at its latest version: `ref`, `name`, a `summary` (the
  first sentence of its description, at most 160 characters), `kinds` and
  `instances`, and `builtin: true` on the built-in vocabulary. Applications and
  deprecated modules are left out.

**The endpoint also serves three authoring guides as argument-less tools** —
`guide_build_ui`, `guide_write_integration_tests` and `guide_design_library`,
each answering one text block read from `guides/build-ui.md`,
`guides/write-integration-tests.md` and `guides/design-library.md`. A guide
says how to design and compose — a screen, a test that starts a real service as
a container, a library — and sends its reader to `get_kinds` for every exact
schema and import line, so it names no version and no pin. Each is kept at most
32768 UTF-8 bytes — the authoring agent's default tool-result bound, so it
arrives whole there.
The `instructions:` text names the guide tools first and stays within 4096
characters, the length past which a client may cut it (Claude Code does).

`GET /modules` is deliberately HTTP-only: listing the whole catalogue is a crawler / site-build read that no
manifest-authoring agent needs, and `search_resources` and `suggest_module_refs`
already answer discovery.

**Kinds and instances are searched the same way.** What search ranks is every
exported kind and every exported instance (`exports.resources`), as one set
(the `search_entries` view): both are ways to get a job done, and a module that
only ships ready-made instances — one module per OCR language model — is found
exactly as a module declaring kinds is. Each entry is embedded (vector id
`k:<id>` / `i:<id>`) and matched lexically over its name and description and
its module's name and description, then RRF-fused. A hit carries `entry`
(`kind` | `instance`), `name` (what an importer writes after its alias:
`Bucket`, `pol`, `hmacSha256`), `kind` (the kind it is or instantiates) and
`kindRef` (that kind's owning module); a module hit's `matchedKinds` carries the
same four. An instance takes its runtime reach and capability from its kind's
row (portable when there is none, e.g. a `Telo.Function`), and its categories
from its own kind when its module declares that kind, else from its module.
A re-exported instance is its declaring module's entry, not a second one.

**Applications are an opt-in entry type.** `entry` — repeatable on HTTP
(`entry=kind&entry=instance&entry=application`), an array on `search_resources`
and `list_categories` — picks the entry types to rank: `kind`, `instance`,
`application`. Omitted, it is `[kind, instance]`, so an existing caller is still
offered kinds and instances only; an unknown value is a `400` / JSON-RPC `-32602`. All
selected types are ranked together by the one hybrid rule. The default excludes
applications because the caller of a search is usually composing a manifest, and
an application is something you run, never something you import. Every vector
carries its entry type, and an application never takes a kind's or an instance's
place in a default search: the lookup applies the entry filter before it takes
its nearest `topK` (`VectorStore.Match`'s contract). The pgvector store walks its
index until `topK` entries of the requested types are found, up to
`hnsw.max_scan_tuples` entries (20,000 by default) — beyond that bound a default
search's vector arm returns fewer entries. Likewise an application's module decides
a category's label only when applications are asked for.

An application hit is the module itself: `entry: "application"`, `name` its
`metadata.name`, `kind: "Application"`, `kindRef: ""`, `capability: ""`,
`runtime: null`, the `module` object, and its contract as `application`:

```text
{ "variables": [{ "name", "description", "required", "env", "default", "arg", "schema" }],
  "secrets":   [{ "name", "description", "required", "env", "schema" }],
  "ports":     [{ "name", "description", "required", "env", "default", "arg", "protocol" }] }
```

`required` is true when the entry declares no `default:`; `env` is `''` when
unbound; `arg` is `null`, `{ form: "flag", flag, short }` or
`{ form: "position", position }`. A secret carries no `default` and only its
`type` / `x-telo-type` as `schema` — no value of a secret is stored, indexed or
served. An application is embedded from its name and description, matched
lexically over those plus every input's name, env binding and description, filed
under its module's categories, and never folds as a sibling. On
`/search/modules` an application module carries `module.runtime: null` and its
contract as `application`.

**An application's runtime reach is not indexed**, because it depends on the
application's whole import closure rather than on anything it declares. So a
`runtime` filter combined with `application` in `entry` is refused — HTTP `400`
`{ code: "ERR_RUNTIME_FILTER_UNSUPPORTED", error }`, JSON-RPC `-32602` with
`data.code` — rather than answered with a guess.

`/categories` and `list_categories` take the same `entry` with the same
default: a category is listed when an entry of a requested type declares it, and
`modules` counts modules with such an entry. The category guard on `/search/*`
judges `category` against the vocabulary of the requested types.

`/refs` and `suggest_module_refs` complete a ref to import, so they leave out a
module whose latest version is recorded as an application. A module with no
ingested version, or whose root kind is not recorded, stays listed.

**A module hit names its implementations.** `/search/modules` carries
`implementations: [{ ref, name }]` — the modules whose exported kinds extend any
of this module's kinds, at their latest version. When every kind a module
exports is abstract, importing it alone gives nothing to declare; the web card
marks such a hit "Interface only" and lists these as "Implemented by:".

**Siblings fold into one hit.** Instances of one kind are siblings — every
language model of a recognizer — and a broad query matches all of them. So
`/search/resources` keeps the best-ranked instance of each kind as the hit and
lists the other matching ones under its `siblings` (`{ name, description,
module: { ref, version, name }, score }`), and `/search/modules` does the same
for modules whose every match is an instance of one kind (`siblings: [{ ref,
version, name, description, score, matchedKinds }]`), with `total` counted
after folding. Nothing is dropped: a sibling is listed because it matched, and
a query naming one (`german`) leads with it. Kind hits never fold, and neither
do instances of a built-in kind, which unrelated functions share.

**An instance is also reached from the kind it instantiates.** The hub records at
ingest which module owns each exported instance's kind — resolved through the
exporting manifest's own `imports:`, the way `extends` is — and serves the
reverse: `GET /instances?ref=…&kind=…` and `find_instances` list every instance
of that kind across modules, each `{ name, description, module: { ref, version,
name, description } }` at the module's latest version. Every projection of a
kind carries `instances`, the count. `/module` (and `get_module`) also lists
the kinds a module re-exports from an import (`exports.kinds:
[TesseractModel.Language]`), marked `reexported: true` and described by the
owning module's latest version, so the `tesseract` page reaches the language
models of the `Language` kind it passes through. Every kind there carries `ref`,
its owning module — the key `/instances` takes. Re-exports are never search
hits: a kind is ranked once, under the module that declares it.

**Browsing is searching with a filter, not a separate surface.** Both
`/search/*` verbs take an optional `category`, and an empty `q` degrades to an
unranked listing — so `?q=&category=storage` lists a category, and a second
endpoint that would drift from the ranked one never has to exist. `/categories`
stays because it answers a different question (the facet with counts, not a
module list). `search_resources` takes the same optional `category`. The
parameter is slugified on the way in, so either the slug the API returns
(`storage`) or the label an author wrote (`AI`) selects the same group.

**A wrong `category` is answered, never silently applied.** The vocabulary is
open, so unlike `runtime` it cannot be an enum — and the failure mode is worse,
since an unrecognized value matches *nothing* rather than a subset: an empty hit
list reads as "no such kind exists" and sends a caller off to build what it was
about to find. So both `/search/*` verbs and `search_resources` do three things.
A category outside the declared vocabulary is a bad argument — HTTP 400,
JSON-RPC `-32602` — carrying the real slugs. A recognized one that selects
nothing *for that query* re-runs the search without it and reports
`categoryFilterDropped: true`, because too narrow a filter is not an absent
capability. And every HTTP response carries the `categories` facet, so one search
teaches the whole vocabulary instead of leaving a caller to guess the next slug;
the `search_resources` tool leaves it to `list_categories`.

**One query owns "what slugs exist".** `CategoryVocabulary` answers `/categories`
*and* backs the guard (through `RequireKnownCategory`, split out so `/categories`,
which passes a constant, is not made to catch an unreachable throw). Its set is
the **union** of module-level and kind-level categories, because a kind doc's
`categories:` replaces its module's for that kind — so a module whose every kind
overrides it declares a slug present in no `resource_kinds` row, and a guard
reading kinds alone would reject a slug the hub advertises one endpoint over.
`modules` counts only modules the module search can return — ones exporting at
least one kind or instance; a module exporting neither still votes on the
category's label.
Rows are `{ category, label, modules, kinds }` everywhere, `category` being the
key `/categories` has always used: one concept must not have two key names
depending on which endpoint answered.

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
click filters by the slug — and `extends: { ref, kind }` on a kind. The prefix
of `extends:` resolves through the declaring manifest: an import alias to that
import's ref, `Self` and the module's own `metadata.name` to the module itself,
and `Telo` to the built-in vocabulary's ref (`BUILTINS_REF`), so a kind
extending `Telo.LogSink` names a contract the hub tracks like any other. A
module that implements another's
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
`console` ships Rust controllers for two of its four kinds. A module hit
carries `runtime.runtimes` (every kernel with at least partial reach) and
`runtime.full` (the subset covering every kind), so a filter reads one list and
a UI still renders "Rust (partial)".

A need type is reported as the kernels that host it: its kind is served by the
kernel's own need-type controller, so `runtimes` names every kernel that
registers that controller (`nodejs` today) and it is never `portable`.

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

The built-in vocabulary has **no runtime facts**: `telo module manifest --json`
reports its `runtime` as `null`, since the runtime itself implements those kinds
and an absent PURL would otherwise read as portable. Its version rows store no
`runtimes`, its kinds are neither portable nor claimed by a kernel (so a
`runtime` filter does not select them), and its `search_resources` hits carry no
`runtimes`.

### Deprecation and provenance

A module or kind may declare `metadata.deprecated: { reason, replacedBy? }`, and
hits carry it as `deprecated: { reason, replacedBy }` — `reason: ""` meaning not
deprecated, since a fixed response shape is what lets typed clients consume this
without probing for optional keys. A kind's replacement is resolved through the
declaring manifest's own `imports:` map into `{ ref, kind }`, exactly as
`extends` is, so it is a target a consumer can follow — a `Telo.<Kind>`
replacement resolving to the built-in vocabulary's ref. A module's replacement is a plain
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
exported singleton instances, the tracked version list, and `application` — an
application's declared contract in the shape above, `null` for a library.
`version` selects a tracked version and defaults to the latest. For an
application `kinds` and `exportedResources` are `[]` and `module.runtime` is
`null`; its versions and pins are where a library's are (`module.integrity`,
`/module/versions`, `list_module_versions`).

It exists because a search hit cannot answer this question. `/search/*` is
ranked and returns only the latest version and only the kinds that matched a
query; this is keyed by ref, serves any tracked version, and carries the full
kind list. A page built on search would need three round trips and still could
not address an older version. Both "never registered" and "no such version"
return one 404 — the caller's next move is the same, and separating them would
leak which refs are tracked.

### Publishers

A **publisher** is the host and org a module's ref sits under
(`ghcr.io/telorun`; the host alone for a `url` module; `local` for a seeded
path) — derived, never declared, which is why it can be trusted as far as the
host can. `GET /publishers` lists the ones that hold a searchable module, as
`{ publishers: [{ publisher, modules }] }`, most modules first; `entry` selects
which entry types count, as on `/categories`.

`publisher` on `/search/modules`, `/search/resources` and `search_resources`
narrows to exactly the modules whose `module.publisher` equals it. Unlike a
category it is not refused when unknown: there is no declared vocabulary to
refuse against, so a publisher with no module selects nothing.

**Both search routes echo `publisher`, and `/search/modules` echoes `sort`,
`deprecated` and `contractOnly`.** An older hub accepts any of these parameters
and ignores it, answering with the whole catalogue in its own order. A caller
that sent a filter and reads no echo of it is looking at unfiltered rows.

### Leaving modules out of a listing

Two parameters on `/search/modules`, each `include` (default) or `exclude`; any
other value is a `400`:

- `deprecated=exclude` leaves out modules whose latest version is deprecated.
- `contractOnly=exclude` leaves out modules whose every exported kind is a
  contract. A module exporting no kind at all — an application, a pack of
  instances — is not contract-only.

Both are applied before the page is cut, so `total` counts what is listed and
every page holds `limit` rows of it. The response says what was left out as
`hidden: { deprecated, contractOnly }`, a module that is both counted as
deprecated — so `total + hidden.deprecated + hidden.contractOnly` is the count
with neither filter. `total` and `hidden` are reported for a page with no hits
too: one past the last row, or one whose every match is hidden.

### Sort

`sort` on `/search/modules` orders the hits: `relevance` (default — the fused
score, then the ref), `name` (the declared module name, case-insensitive) or
`recent` (newest first by when the hub **first tracked** the listed version).
Any other value is a `400`. Each hit's `module.trackedAt` is that instant
(RFC 3339, UTC).

`recent` is the hub's own observation, not a publish date — no transport reports
one. It is stored once per version (`module_versions.first_tracked_at`) and
never rewritten by a re-ingest, unlike `tracked_at`. Versions the hub already
held when the column was added carry their last ingest time, so the order means
something only for versions tracked since.

With a query, `name` and `recent` order the ranked candidates the search already
caps, not the whole catalogue; they are meant for browsing (an empty `q`).

### `GET /module/manifest`

The cached `telo.yaml` of one tracked version, as `text/yaml` — the HTTP twin of
`get_module_manifest`, on the same handler. `version` defaults to `latest`. An
unknown ref and an unknown version are one 404, as on `/module`. The text is the
public manifest exactly as cached: no parsing, no re-serialization.

### Imports and dependents

Ingest records what each version imports (`module_imports`: the alias, the
imported ref with its pin cut off and a relative source resolved against the
importer, and the version the pin named). Two readings:

- `/module` and `get_module` carry `imports` (`[{ alias, ref, version }]`, the
  described version's own) and `dependents` (how many other modules import it).
- `GET /dependents?ref=…` lists those modules, a page at a time:
  `{ of: { ref }, total, dependents: [{ ref, version, name, description, application }] }`.
  `limit` is 1–100 (default 50), `offset` skips rows, and `total` is the count
  before the page is cut — reported for a page past the end too. A response
  with no `total` is from a hub that returned every importer.
- `find_dependents(ref, limit?, offset?)` is the same list for a model:
  `{ of, total, dependents: [{ ref, name, summary, application? }] }`, where
  `summary` is the description's first sentence cut at 160 characters, as
  `list_libraries` cuts one.

A dependent is counted once, at **its latest version**: what a module imported
in an older version says nothing about who depends on the import now. An
untracked importer is invisible — the hub knows only the modules registered
with it.

### `GET /modules`

The complete catalogue, for building sitemaps: `{ modules: [{ ref,
latestVersion, seq }], next }`. It lists exactly the refs `GET /module` answers
for — both read one definition of a tracked module (its latest version's row
exists) — with `latestVersion` the value `/module` reports. Search cannot serve
this: it folds pack modules into `siblings` and caps its candidates, and `/refs`
stops at 20.

`seq` is the module row's id: assigned once at registration, never changed or
reused. Entries are ascending by `seq` and strictly greater than `after`
(default `0`); `limit` is 1–1000 (default 1000), and anything outside either
range is a `400`. `next` is the page's last `seq` when the page is full and
`null` otherwise, so a caller passes it back as `after` until it is `null`.

A module that becomes ready later appears at its own `seq`, which may be lower
than a page already read — so a sitemap shard re-read later may contain more
modules than it did.

## Configuration

| Env | Purpose |
| --- | --- |
| `PORT` | HTTP port (default 8040) |
| `DB_CONNECTION` | Postgres connection string (needs `pg_trgm` + the `vector` extension — use a `pgvector/pgvector` image) |
| `EMBEDDER_BASE_URL` | `/v1` base URL of an OpenAI-compatible embeddings server (semantic search). The compose sidecar serves embeddinggemma-300m from the ungated `onnx-community` mirror, no token needed |
| `EMBEDDER_API_KEY` | Key of an embeddings API that asks for one, sent as `Authorization: Bearer <key>` (default empty: no header is sent, which is what a self-hosted server takes) |
| `EMBEDDER_MODEL` | Model id sent with every embeddings request (default `embeddinggemma-300m`) |
| `EMBEDDER_DIMENSIONS` | Length of the vectors that model returns, fixed into the `resource_vectors` table when it is created (default `768`) |
| `EMBEDDER_QUERY_PROMPT` / `EMBEDDER_PASSAGE_PROMPT` | What a search query / an indexed text is wrapped in before it is embedded, `{text}` standing for the text (defaults: embeddinggemma's `task: search result \| query: {text}` and `title: none \| text: {text}`). Set both to `{text}` for a model that takes raw text |
| `MANIFEST_BUCKET_NAME` / `MANIFEST_BUCKET_ENDPOINT` | S3-compatible manifest cache (R2 / MinIO / RustFS) |
| `MANIFEST_BUCKET_ACCESS_KEY_ID` / `MANIFEST_BUCKET_SECRET_ACCESS_KEY` | Bucket credentials |
| `MANIFEST_BUCKET_FORCE_PATH_STYLE` | `true` for MinIO/RustFS (default `false`) |
| `SEED_REFS` | JSON array of module refs registered idempotently on boot (the curated seed; publishers also self-register via `POST /register`) |
| `ALLOW_LOCAL_REFS` | `true` lets `SEED_REFS` name a `./`-relative module directory read from the hub's own disk (default `false`; set by the compose stack) |
| `TRACK_CRON` | When the reconcile pass runs, as a 5-field cron in UTC (default `*/15 * * * *`) |
| `TRACK_ENABLED` | `false` disables the periodic reconcile (tests drive `Ingest.scheduleDueVersions` directly) |
| `BUILTINS_REF` | Where the built-in vocabulary is published, one version per telo release (default `oci://ghcr.io/telorun/telo`). Registered on every boot before `SEED_REFS`, and the only ref a `Telo.Builtins` root is indexed or registered at |
| `INGEST_REV` | Revision of the ingest pipeline (default `9`). Raising it makes every tracked version due exactly once — the whole-registry re-ingest control, deployed alongside a change to what ingest extracts |
| `TELO_COMMAND` | The command the origin reads run, as a JSON array: a program and its leading arguments (default `["telo"]`). It must be the same telo generation as the hub, since ingest reads that CLI's `module manifest --json` contract — including how it reports a `Telo.Builtins` root |
| `REGISTER_RATE_LIMIT` | Max `POST /register` calls per client IP per window (default `5`) |
| `REGISTER_RATE_WINDOW` | Sliding window for that limit (default `10m`) |
| `TELO_EGRESS` | `public-only` refuses origin fetches to private/loopback/link-local hosts (set in the production image) |

`TRACK_INTERVAL` and `TRACK_LOOP` are **gone**; `TRACK_CRON` and `TRACK_ENABLED`
replace them. `TELO_BIN` is **gone** too: `TELO_COMMAND` replaces it, as an array
so the command may carry leading arguments (the development image runs the
checkout's CLI as `["/telo/node_modules/.bin/bun","/telo/cli/nodejs/bin/telo.ts"]`).

### Changing the embedding model

`EMBEDDER_MODEL`, `EMBEDDER_DIMENSIONS` and the two prompts describe one model
and move together; the defaults are embeddinggemma-300m's. Any server speaking
the OpenAI `/v1/embeddings` API works: a hosted one that asks for a key takes
it from `EMBEDDER_API_KEY`, as a bearer token.

Stored vectors are only comparable with vectors from the same model and the
same wrappers, so a change to any of the four is a re-embed of the whole index:

1. Stop the hub and drop the `resource_vectors` table. The table is created
   only when absent, so an existing one keeps the vector length it was created
   with, and writes of another length are refused.
2. Start the hub with the new values and a raised `INGEST_REV`, which makes
   every tracked version due once and embeds it again.
3. Re-tune `VECTOR_MIN_SCORE`: another model scores on another scale.

The vectors table is indexed with HNSW, which pgvector limits to 2000
dimensions, so a model returning longer vectors cannot be used.

## Deploy on Kubernetes

`apps/hub/chart` is a Helm chart for the hub alone, published as
`oci://ghcr.io/telorun/charts/hub`. Its version is the hub's, and it deploys
the `telorun/hub` image of that version. The database, the bucket and the
embeddings server are yours to supply; every credential is read from a Secret
you name.

```sh
kubectl create secret generic hub-db \
  --from-literal=DB_CONNECTION='postgres://user:password@host:5432/hub'
kubectl create secret generic hub-bucket \
  --from-literal=MANIFEST_BUCKET_ACCESS_KEY_ID=… \
  --from-literal=MANIFEST_BUCKET_SECRET_ACCESS_KEY=…

helm install hub oci://ghcr.io/telorun/charts/hub \
  --set database.existingSecret.name=hub-db \
  --set bucket.name=telo-manifests \
  --set bucket.endpoint=https://<account>.r2.cloudflarestorage.com \
  --set bucket.existingSecret.name=hub-bucket \
  --set embedder.baseUrl=http://embedder/v1
```

Those five values are required and an install without one is refused, naming
it. The rest of the configuration table above has a value of its own in
`values.yaml` (`embedder.model`, `seedRefs`, `tracking.cron`, …), each left to
the hub's default when empty; `embedder.apiKey.existingSecret` names the Secret
holding `EMBEDDER_API_KEY`. `ingress` and `httpRoute` expose the service, both
off by default.

- **One instance.** There is no replica count, and setting one is refused: the
  `/register` rate limiter counts in process memory. A rollout stops the old
  pod before starting the new one, so an upgrade is a few seconds of downtime.
- **The pod runs unprivileged**: the image's `node` user, a read-only root
  filesystem, no capabilities.
- **Egress is yours to bound.** The hub fetches whatever ref is registered, and
  the image refuses private, loopback and link-local hosts (`TELO_EGRESS`) only
  as a guardrail; a network policy on the namespace is the boundary.

## Run locally

The compose stack wires everything (hub, its Postgres, shared object storage):

```sh
docker compose up -d hub
curl "http://localhost:8040/search/resources?q=delay"
```

The dev service mounts the repo and runs the **workspace** CLI, not the one
baked into the image — so the stack exercises the code in your tree. That is
also what lets the manifest declare a `requires: telo:` floor naming a release
still in flight: the image ships the last released telo, and booting this
manifest in it is refused by the load gate, correctly.

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
  An entry must be an `oci://` or `https://` ref, or — with `ALLOW_LOCAL_REFS` —
  a local path; anything else stops the boot with `ERR_INVALID_MODULE_REF`, and a
  local path without the flag with `ERR_LOCAL_REF_DISABLED`.
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
     doc must be a **`Telo.Library`** or a **`Telo.Application`**; anything else is
     refused with "the root document of `<ref>` is `<kind>`; only a Telo.Library
     or Telo.Application can be registered".
  4. **Insert, then schedule the latest version** — the row is written and the
     latest version is claimed and handed to a durable run, and the response is
     `202`. The request path never ingests: a `200` used to mean *searchable*,
     and once indexing is asynchronous that is a lie. The reconcile pass
     backfills older versions; only the latest is embedded/searched anyway.

  The row is inserted *before* the schedule, so even if scheduling fails the
  module stays registered and the reconcile pass claims it. A malformed,
  unreachable, or non-module ref returns `400` with the reason; a server-side
  fault returns only the error **code** (this endpoint is anonymous — raw
  messages can carry host paths or upstream detail). There is **no moderation
  queue**; the hub never vouches for content (trust lives at host +
  integrity-hash).

`GET /register/status?ref=` is what a client polls afterwards. It is answered
from the **rows**, which are the authoritative record of what has been ingested —
not from the durable run, whose id carries a version, a digest and an attempt a
client does not hold, and of which a ref has one per version. It reports
`pending` (recorded, nothing indexed yet), `ingesting` (some versions in, more
arriving), `ready`, `failed`, or `unknown`.

The reconcile pass remains the **reconciler**: it picks up new versions,
re-pushed digests, and any module whose first ingest failed.

The browser-facing registration form is part of [`apps/hub-web`](../hub-web), the
request-time site at `hub.telo.run`; the reader's browser POSTs to this verb
cross-origin.

### `url` transport — weaker guarantees

A direct manifest URL addresses **one file**, not a versioned repo, so it differs
from an OCI ref in ways worth knowing:

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

### The built-in vocabulary

Every telo release publishes its built-in vocabulary — the `Telo.Builtins`
archive (`kernel/specs/builtin-vocabulary.md`): the kinds that need no import,
the schema fragments, value types, zone attributes and formats they name — at
`oci://ghcr.io/telorun/telo@<release>`. The hub tracks it like a module at
`BUILTINS_REF`, which it registers on every boot, before `SEED_REFS`: a
deployment that left it out of the seed would otherwise never index it.

- **Only there.** Registration is open, so nobody else may publish "built-in"
  kinds: ingest records a `Telo.Builtins` root at `BUILTINS_REF` as root kind
  `Builtins` and refuses it at any other ref (`INGEST_ROOT_KIND_UNSUPPORTED`,
  naming the ref it is indexed at), and `POST /register` admits one only at
  `BUILTINS_REF`, where it answers as an already-tracked module.
- **Indexed as kinds**, so `search_resources` finds `Telo.ConsoleSink` for
  "write log records somewhere". Its hits and its `list_libraries` entry carry
  `builtin: true` (`module.builtin` on the HTTP search routes): its kinds are
  written `Telo.<Kind>`, with no import.
- **No runtime facts**, see Runtime reach.
- **Read at a telo version.** `get_kinds` resolves every built-in it returns at
  one telo version — its `telo` argument, or the latest tracked — because a
  built-in reference means the telo that runs the manifest. The fragments,
  value types, zone attributes and formats are cut out of the cached archive by
  the renderer's fixed layout and printed exactly as `telo builtins <name>`
  prints them; the closure over what each names is a recursive query.
- **The origin reads it with the hub's own telo.** `telo module manifest --json`
  reports a `Telo.Builtins` root with `runtime: null` and `application: null`
  from the release that ships the archive on; the production image's telo is
  the CLI of the commit it is built from, and the development image runs the
  checkout's, so `TELO_COMMAND` meets that floor by construction.

### `local` transport — development only

A seed entry of the form `./modules/tesseract` names a module directory on the
hub's own disk, relative to its working directory. The compose stack mounts the
repository there and seeds a few of its modules this way, so an unpublished
module is indexed as it is in the checkout. It exists only behind
`ALLOW_LOCAL_REFS`, only through the seed — `POST /register` refuses it whatever
the flag says, since reading an anonymous caller's path off disk is exactly what
its shape gate prevents — and only as `./` followed by segments of letters,
digits, `.`, `_` and `-` that do not start with `.`, so it cannot leave the
working directory.

Like a `url` ref it has one version, the one the directory declares, and no pin.
Its manifest is cached under `local/<path>/<version>/telo.yaml`, a key no
published ref produces. Its `imports:` are still relative on disk, so every
cross-module ref the hub stores for it — an `extends` target, a replacement, an
instance's kind owner — is resolved against the module's own ref:
`../../tesseract-model` imported from `./modules/tesseract-lang/pol` is
`./modules/tesseract-model`, the ref that module was seeded under. Its
publisher is `local`.

## Re-ingesting

The `version_ingest` table is the ingest control plane, one row per
`(module, version)`. A version is due when its recorded digest no longer matches
the origin's, when its `ingest_rev` is below `INGEST_REV`, or when a recorded
failure's `next_attempt_at` has passed — and the statement that decides this also
increments `attempt` and stamps `claimed_at`, in one write. That is what makes
two concurrent passes over one version collapse to one run, and what makes every
attempt a fresh durable run id (`ingest:<moduleId>:<version>:<attempt>`) rather
than one burnt by the attempt that failed.

An in-flight claim (`claimed_at` set, `completed_at` null) is never re-claimed:
recovering a run whose process died is the resumer's job, and a second recovery
path here would compete with it.

Failure backoff doubles from a minute; past eight attempts `next_attempt_at` is
left null and the version is **not** retried again — an artifact that is no
longer a Telo module stops being read every quarter of an hour forever.

Three levels of re-ingest, all writes to that table:

```sql
-- one version
UPDATE version_ingest SET ingest_rev = 0
WHERE module_id = $1 AND version = $2;

-- every version of one module
UPDATE version_ingest SET ingest_rev = 0 WHERE module_id = $1;

-- a claim whose run was lost beyond the resumer's reach
UPDATE version_ingest SET claimed_at = NULL WHERE module_id = $1 AND version = $2;
```

Clearing `last_error` alone does **not** make a version due — the digest still
matches and the revision is still current. Raising `INGEST_REV` re-ingests
everything, once.

Revision `9` stores a need type's runtime reach as `telo module manifest
--json` reports it — the kernels that host the need-type controller — where `8`
stored it as no kernel, so a `runtime` filter hid every need type; deploying it
re-ingests every tracked version once.

Revision `8` indexes each module's `Telo.NeedType` documents as kinds, resolves
an `extends:` / `replacedBy` prefix of `Telo` to `BUILTINS_REF` and a module's
own `metadata.name` to the module itself (where `Telo` used to leave the ref
empty), records the built-in vocabulary's root kind as `Builtins`, and stores no
runtime facts for a payload reporting `runtime: null`; deploying it re-ingests
every tracked version once.

Revision `7` records what each version imports (`module_imports`), so deploying
it re-ingests every tracked version once.

Revision `6` records each version's root kind (`module_versions.root_kind`,
`Library` or `Application`), stores an application's contract
(`application_inputs`) and stops storing an application's own kinds as exported.
The root kind can only be learned by reading the manifest, so deploying it
re-ingests every tracked version once; until a version is re-ingested its root
kind is NULL, which every reader treats as not an application, and its vectors
carry no entry type and take no part in the vector arm. An application
version whose `telo module manifest --json` payload carries no `application`
field is refused (`INGEST_CONTRACT_MISSING` in `version_ingest.last_error`)
rather than indexed as asking for nothing — `TELO_COMMAND` names a telo older
than the hub. A refused version never reaches the current `ingest_rev`, so every
reconcile pass claims it again: point `TELO_COMMAND` at the hub's telo and the
next pass indexes it.

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

The hub's end-to-end suite (`apps/hub/test-suite-e2e.yaml`) and hub-web's run
only through one command, locally and in CI alike:

```sh
pnpm run test:e2e:hub
```

It always runs on a fresh stack. It refuses to start while port 8040 or 8050 is
taken (a running development stack, typically) rather than attach to it — those
are the only two ports it refuses; brings `db`, `storage`, `embedder`, `hub` and
`hub-web` (production target) up under a compose project of its own,
`telo-hub-e2e`, with the database on storage that dies with the stack and
published on a loopback port Docker assigns, handed to the hub suite (its
`tests/integration/` tests) as `DB_HOST` / `DB_PORT` / `DB_USER` /
`DB_PASSWORD` / `DB_NAME`; waits for the hub's first tracking pass over `SEED_REFS`;
runs the hub's suite and then hub-web's; fails if hub-web's process restarted
during the run; and always tears the stack down with its volumes. On failure
the suites' output and the stack's logs are written to `e2e-logs/`. Pointing a
suite at the development stack is unsupported: the suites assume a hub that has
seen nothing but its seeds.
