---
status: approved
priority: medium
depends-on: []
packages: [apps/hub, apps/authoring-agent, docs]
refinement: ready
---

# Contract-first discovery

## Problem

Hub discovery lists every backend of a contract as a peer of the contract itself, so a model composing an application reads the same capability several times and has to work out the contract from its backends.

- `search_resources` for "durable key/value store" (limit 6) answers six module groups today: `kv-store`'s `Store`, then `kv-store-sql`, `kv-store-memory` and `kv-store-redis` (each a `Store` extending it), then `api-key-sql`'s `Store` and `api-key-postgres`'s `Store` (which extends it). That is two capabilities. The backends use up the limit that other answers could have had.
- "store rows in PostgreSQL" answers four backends of four different contracts (`kv-store-sql`, `queue-postgres`, `vector-store-pgvector`, `api-key-postgres`), each as a peer of nothing, so the reader cannot see which contract each one serves.
- The authoring agent's `LIBRARY INDEX:` (`list_libraries` for `ghcr.io/telorun`, 84 KB, re-sent on every turn) gives about 9.6 KB to 38 libraries whose every kind implements another module's abstract, and lists backend kinds inside 19 more. It does not say which kinds are abstract, so the agent cannot tell a contract from a backend without another call.
- Choosing a backend is a lookup once the contract is known. The authoring agent cannot make it: `find_implementations` is mounted only on the `find_kinds` sub-agent. It also matches direct `extends` only, so `openai`'s `Model` (which extends `Self.ChatModel`, which extends `Ai.Model`) is not listed as an `Ai.Model`, while `api-key-sql`'s `Store`, an abstract nothing can declare, is listed as an implementation of `ApiKey.Store`. And a deprecated alias carries its deprecation only in its description text.

## Surface

**Added**
- `list_libraries` entry member `abstracts` — each abstract the library declares, with the names of the modules that implement it.
- `search_resources` abstract-hit member `matchedImplementations` — the kinds folded into the hit, `{ name, ref, runtimes?, deprecated? }`.
- `find_implementations` row members `runtimes` (omitted when portable) and `deprecated` (`{ reason, replacedBy? }`, present only on a deprecated kind).
- `find_implementations` mounted on the authoring agent.

**Changed**
- `find_implementations` and `GET /implementations` rows — transitive, any module (the contract's own included), never an abstract; a concrete contract answers too.
- `search_resources` — a kind folds into its abstract's hit, only when the abstract passes the filters too; `limit` counts hits after folding.
- `list_libraries` — `kinds` no longer holds abstracts or folded kinds; a library left with nothing has no entry.
- The `LIBRARY INDEX:` of the authoring agent is the new `list_libraries` answer.

**Removed**
- An abstract as a `find_implementations` / `GET /implementations` row (`ApiKeySql.Store` under `ApiKey.Store`).
- A backend-only library's entry in the `list_libraries` tool.

## Solution

The hub derives two relations from the stored `extends` edges, at each module's latest version, when a query runs. So neither goes stale when a parent module is ingested after its backend.
- An **implementation of** X is an exported kind that is not an abstract and whose `extends` chain reaches X, in any module, transitively. It is what an `x-telo-ref` slot of X accepts. `ApiKeyPostgres.Store` implements both `ApiKeySql.Store` and `ApiKey.Store`, and `openai`'s `Client` implements the concrete `Http.Client`. Deprecated kinds stay in it, marked. This is the hub's one definition of the word: the `find_implementations` tool, the `GET /implementations` route and the index's `abstracts` lists all read it, so hub-web's "Implemented by" lists what a slot accepts.
- A kind **folds** into abstract X when X is the nearest `Telo.Abstract` along its chain, X is declared in another module, and X is in the same answer. The built-in vocabulary counts as another module, so `otlp`'s sinks fold into `Telo.LogSink` / `Telo.TraceSink`. An abstract never folds. A kind whose chain leaves the tracked catalogue before reaching an abstract does not fold. Only the MCP tools fold; the HTTP `/search/*` routes keep their fixed shape for typed frontends.
- Only `extends` edges count. A kind's `capability:` is not an edge, so the capability abstracts (`Telo.Service`, `Telo.Provider`, …) gain no implementations from it.

### `search_resources`

Ranks every entry exactly as today, then folds each matched kind into its abstract's hit, as sibling instances already fold.
- Every filter (`category`, `publisher`, `entry`, `runtime`) is judged on each row alone, as today. A kind folds only when its abstract passes the filters too; the query match is carried to the abstract, the filters are not. Otherwise the kind stays an ordinary hit carrying its `extends`. An abstract has no controllers, so it passes `runtime`.
- The abstract's hit takes the best rank among itself and the kinds folded into it. It appears when it matched itself or when a kind folded into it.
- An abstract hit carries `matchedImplementations`, omitted when empty: the kinds folded into the hit, ranked, each as `{ name, ref, runtimes?, deprecated? }` — `runtimes` omitted as on a portable hit, `deprecated` present only on a deprecated kind. It lists what matched the query; the full set is `find_implementations`.
- `limit` counts hits after folding.
- Instance hits and application hits are never folded.
- A same-module implementation stays an ordinary hit, since its import is the abstract's own.

Request:

```json
{ "query": "durable key/value store", "limit": 2 }
```

Before — both hits are one capability:

```json
{"results": [{"query": "durable key/value store", "modules": [
  {"ref": "oci://ghcr.io/telorun/kv-store", "version": "0.5.1", "name": "KeyValueStore",
   "description": "Durable key/value storage with atomic conditional writes: read a value with its version token, insert only when the key is absent, replace or delete only when that version still matches. Records live their full TTL and are never dropped early, so they can carry locks, leases, at-most-once execution and idempotency records.",
   "hits": [{"name": "Store", "capability": "Telo.Provider",
             "description": "A configured durable key/value store: read a value with its version token, insert when absent, and replace or delete only if that version still matches. A conditional write that loses the race returns null rather than failing."}]},
  {"ref": "oci://ghcr.io/telorun/kv-store-redis", "version": "0.9.0", "name": "KeyValueStoreRedis",
   "description": "Redis-backed key/value storage with atomic conditional writes, shared across every instance of an application and namespaced by a key prefix. Each write is decided at the server in a single step, so two callers racing for the same key can never both win. When Redis is unreachable, operations fail loudly rather than falling back. Run the server with eviction disabled.",
   "hits": [{"name": "Store", "capability": "Telo.Provider",
             "description": "Stores records in Redis under a key prefix, with every conditional write decided atomically at the server so racing callers cannot both succeed. Requires a server configured not to evict keys before their TTL.",
             "extends": {"kind": "Store", "ref": "oci://ghcr.io/telorun/kv-store"}, "runtimes": ["nodejs"]}]}]}]}
```

After — two capabilities, the backends under their contracts. `ApiKeySql.Store` is itself an abstract, so it is not folded under `ApiKey.Store`:

```json
{"results": [{"query": "durable key/value store", "modules": [
  {"ref": "oci://ghcr.io/telorun/kv-store", "version": "0.5.1", "name": "KeyValueStore",
   "description": "Durable key/value storage with atomic conditional writes: read a value with its version token, insert only when the key is absent, replace or delete only when that version still matches. Records live their full TTL and are never dropped early, so they can carry locks, leases, at-most-once execution and idempotency records.",
   "hits": [{"name": "Store", "capability": "Telo.Provider",
             "description": "A configured durable key/value store: read a value with its version token, insert when absent, and replace or delete only if that version still matches. A conditional write that loses the race returns null rather than failing.",
             "matchedImplementations": [
               {"name": "Store", "ref": "oci://ghcr.io/telorun/kv-store-redis", "runtimes": ["nodejs"]},
               {"name": "Store", "ref": "oci://ghcr.io/telorun/kv-store-sql", "runtimes": ["nodejs"]},
               {"name": "Store", "ref": "oci://ghcr.io/telorun/kv-store-memory", "runtimes": ["nodejs"]}]}]},
  {"ref": "oci://ghcr.io/telorun/api-key-sql", "version": "0.2.0", "name": "ApiKeySql",
   "description": "Durable storage for API keys in a table of the application's own database, shared by every replica: issuing, lookup, listing an owner's keys with a cursor, revoking, rotating with an overlap and recording last use at most once per interval. Only digests are stored. Keys that ended long ago are forgotten and reclaimed in the background.",
   "hits": [{"name": "Store",
             "description": "A durable record of API keys kept in a table of the application's own database, readable and writable from every replica at once. A key is judged on every request from the table, never a cache, so a revocation holds at the next request. Keys that ended past the retention window read as absent and are reclaimed in the background.",
             "extends": {"kind": "Store", "ref": "oci://ghcr.io/telorun/api-key"},
             "matchedImplementations": [
               {"name": "Store", "ref": "oci://ghcr.io/telorun/api-key-postgres", "runtimes": ["nodejs"]}]}]}]}]}
```

A query naming only a backend brings its contract with it, though the contract did not match:

```json
{ "query": "redis", "limit": 1 }
```

Before — the backend alone, as a peer of nothing:

```json
{"results": [{"query": "redis", "modules": [
  {"ref": "oci://ghcr.io/telorun/kv-store-redis", "version": "0.9.0", "name": "KeyValueStoreRedis",
   "description": "Redis-backed key/value storage with atomic conditional writes, shared across every instance of an application and namespaced by a key prefix. Each write is decided at the server in a single step, so two callers racing for the same key can never both win. When Redis is unreachable, operations fail loudly rather than falling back. Run the server with eviction disabled.",
   "hits": [{"name": "Store", "capability": "Telo.Provider",
             "description": "Stores records in Redis under a key prefix, with every conditional write decided atomically at the server so racing callers cannot both succeed. Requires a server configured not to evict keys before their TTL.",
             "extends": {"kind": "Store", "ref": "oci://ghcr.io/telorun/kv-store"}, "runtimes": ["nodejs"]}]}]}]}
```

After:

```json
{"results": [{"query": "redis", "modules": [
  {"ref": "oci://ghcr.io/telorun/kv-store", "version": "0.5.1", "name": "KeyValueStore",
   "description": "Durable key/value storage with atomic conditional writes: read a value with its version token, insert only when the key is absent, replace or delete only when that version still matches. Records live their full TTL and are never dropped early, so they can carry locks, leases, at-most-once execution and idempotency records.",
   "hits": [{"name": "Store", "capability": "Telo.Provider",
             "description": "A configured durable key/value store: read a value with its version token, insert when absent, and replace or delete only if that version still matches. A conditional write that loses the race returns null rather than failing.",
             "matchedImplementations": [
               {"name": "Store", "ref": "oci://ghcr.io/telorun/kv-store-redis", "runtimes": ["nodejs"]}]}]}]}]}
```

On the `rust` kernel the backend is filtered out, and the contract, which did not match "redis" itself, goes with it (the answer is empty before the change as well):

```json
{ "query": "redis", "limit": 1, "runtime": "rust" }
```

```json
{"results": [{"query": "redis", "modules": []}]}
```

A deprecated implementation is folded and marked, so the sub-agent reading the hit does not choose it:

```json
{ "query": "openai chat model", "limit": 1 }
```

```json
{"results": [{"query": "openai chat model", "modules": [
  {"ref": "oci://ghcr.io/telorun/ai", "version": "0.37.0", "name": "AI",
   "description": "Language and image models over any provider: buffered text, token-by-token streaming, prompt-to-picture generation and editing, and a tool-use agent loop that calls the model, runs the tools it asks for, and replays their results until it settles. Tools wrap ordinary resources, exposed as a static list or discovered at runtime.",
   "hits": [{"name": "Model", "capability": "Telo.Invocable",
             "description": "A language model called for a complete answer: messages and optional tools go in, the finished content, token usage and a finish reason come back. Providers implement it for their own endpoint; consumers hold one and call it.",
             "matchedImplementations": [
               {"name": "ChatModel", "ref": "oci://ghcr.io/telorun/openai", "runtimes": ["nodejs"]},
               {"name": "Model", "ref": "oci://ghcr.io/telorun/openai", "runtimes": ["nodejs"],
                "deprecated": {"reason": "Renamed to ChatModel, so the completions and responses pairs are named symmetrically for the API each speaks.", "replacedBy": {"kind": "ChatModel", "ref": "oci://ghcr.io/telorun/openai"}}}]}]}]}]}
```

Under a filter its contract fails, a backend stays a hit of its own, exactly as today. The built-in vocabulary declares no categories, so `Telo.LogSink` fails `observability` and `OTLP.Sink` is answered unfolded, with its `extends`:

```json
{ "query": "opentelemetry", "limit": 1, "category": "observability" }
```

```json
{"results": [{"query": "opentelemetry", "modules": [
  {"ref": "oci://ghcr.io/telorun/otlp", "version": "0.8.0", "name": "OTLP",
   "description": "Ships an application's structured log records and finished trace spans to an OpenTelemetry collector over OTLP, batched and flushed on an interval, with resource attributes such as the service name attached to every batch. The route from local logging and tracing to any OTel-compatible observability backend.",
   "hits": [{"name": "Sink", "capability": "Telo.Sink",
             "description": "A destination for log records that batches them and sends them to an OpenTelemetry collector, filtered by minimum severity and bounded by a buffer with a drop policy. Delivery is a network round-trip, so a flush cannot be awaited synchronously and records held only here may be lost if the process dies at once.",
             "extends": {"kind": "LogSink", "ref": "oci://ghcr.io/telorun/telo"}, "runtimes": ["nodejs"]}]}]}]}
```

### `list_libraries`

Each library entry gains `abstracts: { <Kind>: [<module name>…] }`.
- **Keys.** One key per abstract the library exports, every one, whether or not anything implements it. An abstract appears as a key and never in `kinds`, and never folds.
- **Lists.** An abstract's list is the sorted, distinct names of the modules of its implementations that the request lists as libraries (publisher filter, latest version, not a deprecated module, not an application) — the rows `find_implementations` returns for it, cut to those modules. A deprecated kind's module is named, as its row is listed. The abstract's own module is named when it holds an implementation. An empty list says no module the request lists implements the abstract. A refining abstract (`ApiKeySql.Store` under `ApiKey.Store`) keeps its own key, and the outer abstract's list still names the backend below it.
- **Kinds.** A non-abstract exported kind is in its library's `kinds` unless it folds; a folded kind is represented only by its module's name in the lists. A kind whose nearest abstract is not in the answer (another publisher's) stays in `kinds`.
- Every exported kind of a listed library is placed exactly once: in `kinds`, as an `abstracts` key, or folded. A module name in the lists is the relation, not a placement, so one module may be named under several abstracts. A library left with no kinds, no abstracts and no instances has no entry.

The HTTP routes keep the full flat form, so the tool has no switch back to it.

Example — a hub tracking the built-in vocabulary, `kv-store`, `kv-store-sql`, `kv-store-redis`, `api-key`, `api-key-sql`, `api-key-postgres` and `otlp`, and not `postgres`. Request:

```json
{ "publisher": "ghcr.io/telorun" }
```

Before:

```json
{"libraries": [
  {"ref": "oci://ghcr.io/telorun/api-key", "name": "ApiKey",
   "summary": "API keys for authenticating callers of an API: long-lived secrets handed to users, services and organizations, checked on every request without a password hash…",
   "kinds": ["DeclaredKeys", "Generate", "Issue", "KeySource", "List", "Revoke", "Rotate", "Store", "Verifier"],
   "instances": ["KeyRecord", "Owner"]},
  {"ref": "oci://ghcr.io/telorun/api-key-postgres", "name": "ApiKeyPostgres",
   "summary": "Stores API keys in a PostgreSQL table beside the application's own data, so every replica sees an issued, revoked or rotated key at its next request",
   "kinds": ["Store", "Table"]},
  {"ref": "oci://ghcr.io/telorun/api-key-sql", "name": "ApiKeySql",
   "summary": "Durable storage for API keys in a table of the application's own database, shared by every replica: issuing, lookup, listing an owner's keys with a cursor, rev…",
   "kinds": ["Store"]},
  {"ref": "oci://ghcr.io/telorun/kv-store", "name": "KeyValueStore",
   "summary": "Durable key/value storage with atomic conditional writes: read a value with its version token, insert only when the key is absent, replace or delete only when …",
   "kinds": ["Store"]},
  {"ref": "oci://ghcr.io/telorun/kv-store-redis", "name": "KeyValueStoreRedis",
   "summary": "Redis-backed key/value storage with atomic conditional writes, shared across every instance of an application and namespaced by a key prefix",
   "kinds": ["Store"]},
  {"ref": "oci://ghcr.io/telorun/kv-store-sql", "name": "KeyValueStoreSql",
   "summary": "Durable key/value storage with atomic conditional writes, kept in a table on a database you already run",
   "kinds": ["Store"]},
  {"ref": "oci://ghcr.io/telorun/otlp", "name": "OTLP",
   "summary": "Ships an application's structured log records and finished trace spans to an OpenTelemetry collector over OTLP, batched and flushed on an interval, with resour…",
   "kinds": ["Sink", "TraceSink"]},
  {"ref": "oci://ghcr.io/telorun/telo", "name": "Telo", "builtin": true,
   "summary": "Everything a Telo manifest can use without an import, for one telo release: the documents that declare applications, libraries, kinds, imports and needs; the l…",
   "kinds": ["Abstract", "Application", "Callable", "ConsoleSink", "Definition", "DurableDirectory", "Executable", "FileSink", "Function", "Import", "Invocable", "JsonSchema", "KeyedTranslations", "Library", "LogSink", "LogTraceSink", "Mount", "NeedType", "Provider", "PublicHostPattern", "PublicUrl", "Runnable", "Sequence", "Service", "Sink", "Template", "TextTranslations", "TraceSink", "Translations", "Type"]}]}
```

After — `kv-store-redis`, `kv-store-sql` and `otlp` have no entry; their names are under the abstracts they implement, `OTLP` under two. `ApiKeyPostgres` keeps `Table`, which extends `Postgres.Table`, a kind this hub does not track, while its `Store` folds. `ConsoleSink`, `FileSink` and `LogTraceSink` implement `LogSink` / `TraceSink` in their own module, so they stay in `kinds` and `Telo` is named under both. `ApiKey.Store` names `ApiKeyPostgres`, which reaches it through `ApiKeySql.Store`. The capability abstracts nothing implements list `[]`:

```json
{"libraries": [
  {"ref": "oci://ghcr.io/telorun/api-key", "name": "ApiKey",
   "summary": "API keys for authenticating callers of an API: long-lived secrets handed to users, services and organizations, checked on every request without a password hash…",
   "kinds": ["DeclaredKeys", "Generate", "Issue", "List", "Revoke", "Rotate", "Verifier"],
   "abstracts": {"KeySource": ["ApiKey", "ApiKeyPostgres"], "Store": ["ApiKeyPostgres"]},
   "instances": ["KeyRecord", "Owner"]},
  {"ref": "oci://ghcr.io/telorun/api-key-postgres", "name": "ApiKeyPostgres",
   "summary": "Stores API keys in a PostgreSQL table beside the application's own data, so every replica sees an issued, revoked or rotated key at its next request",
   "kinds": ["Table"]},
  {"ref": "oci://ghcr.io/telorun/api-key-sql", "name": "ApiKeySql",
   "summary": "Durable storage for API keys in a table of the application's own database, shared by every replica: issuing, lookup, listing an owner's keys with a cursor, rev…",
   "abstracts": {"Store": ["ApiKeyPostgres"]}},
  {"ref": "oci://ghcr.io/telorun/kv-store", "name": "KeyValueStore",
   "summary": "Durable key/value storage with atomic conditional writes: read a value with its version token, insert only when the key is absent, replace or delete only when …",
   "abstracts": {"Store": ["KeyValueStoreRedis", "KeyValueStoreSql"]}},
  {"ref": "oci://ghcr.io/telorun/telo", "name": "Telo", "builtin": true,
   "summary": "Everything a Telo manifest can use without an import, for one telo release: the documents that declare applications, libraries, kinds, imports and needs; the l…",
   "kinds": ["Abstract", "Application", "ConsoleSink", "Definition", "DurableDirectory", "FileSink", "Function", "Import", "JsonSchema", "KeyedTranslations", "Library", "LogTraceSink", "NeedType", "PublicHostPattern", "PublicUrl", "Sequence", "TextTranslations"],
   "abstracts": {"Callable": [], "Executable": [], "Invocable": [], "LogSink": ["OTLP", "Telo"], "Mount": [], "Provider": [], "Runnable": [], "Service": [], "Sink": [], "Template": [], "TraceSink": ["OTLP", "Telo"], "Translations": ["Telo"], "Type": []}}]}
```

### `find_implementations`

- Lists every implementation of the contract as defined above: transitive, in any module, the contract's own module included, never an abstract. A row in the contract's own module is the one whose `ref` is the asked `ref`. A concrete contract (`Http.Client`) answers the same way. The `GET /implementations` route answers the same set of rows in its fixed shape, which gains no member: `runtimes` and `deprecated` are the tool's.
- Each row carries `runtimes`, omitted when portable or built-in, as on a search hit, and `deprecated: { reason, replacedBy? }` on a deprecated kind (`replacedBy` as `{ kind, ref }`), as on a search hit. A caller reads `runtimes` to pick a kernel; the tool takes only `ref` and `kind`.

Several contracts are several calls in one turn, as the primer already directs for `get_kinds` and `find_kinds`.

A two-level contract. Request:

```json
{ "ref": "oci://ghcr.io/telorun/api-key", "kind": "Store" }
```

Before — the refining abstract, which nothing can declare:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/api-key", "kind": "Store"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/api-key-sql", "version": "0.2.0", "kind": "Store", "capability": "",
   "description": "A durable record of API keys kept in a table of the application's own database, readable and writable from every replica at once. A key is judged on every request from the table, never a cache, so a revocation holds at the next request. Keys that ended past the retention window read as absent and are reclaimed in the background.",
   "categories": [{"slug": "data", "label": "Data"}, {"slug": "security", "label": "Security"}]}]}
```

After — the backend below it:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/api-key", "kind": "Store"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/api-key-postgres", "version": "0.2.0", "kind": "Store", "capability": "",
   "description": "A durable store of API keys in a PostgreSQL table on the application's connection. Issue, list, revoke and rotate are atomic and take effect on every replica at once; last use is recorded at most once per interval. Keys revoked or expired longer ago than the retention window read as unknown.",
   "categories": [{"slug": "data", "label": "Data"}, {"slug": "security", "label": "Security"}], "runtimes": ["nodejs"]}]}
```

The same relation over the route, which keeps its shape (the rows of the first block's After, without `runtimes`):

```
GET /implementations?ref=oci://ghcr.io/telorun/api-key&kind=Store
```

```json
{"extends": {"ref": "oci://ghcr.io/telorun/api-key", "kind": "Store"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/api-key-postgres", "version": "0.2.0", "kind": "Store", "capability": "",
   "description": "A durable store of API keys in a PostgreSQL table on the application's connection. Issue, list, revoke and rotate are atomic and take effect on every replica at once; last use is recorded at most once per interval. Keys revoked or expired longer ago than the retention window read as unknown.",
   "categories": [{"slug": "data", "label": "Data"}, {"slug": "security", "label": "Security"}]}]}
```

A chain through `Self.`, with a same-module implementation and a deprecated alias, on a hub tracking only `ai` and `openai`. Request:

```json
{ "ref": "oci://ghcr.io/telorun/ai", "kind": "Model" }
```

Before — `Model` (which extends `Self.ChatModel`) is missing:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/ai", "kind": "Model"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/ai", "version": "0.37.0", "kind": "Buffered", "capability": "Telo.Invocable",
   "description": "Presents a streaming model as a buffered one: it drives the stream, collects every part and folds them into a single completed answer with its usage and finish reason. For a provider that only streams, and for consumers that want one answer rather than a sequence.",
   "categories": [{"slug": "ai", "label": "AI"}]},
  {"ref": "oci://ghcr.io/telorun/openai", "version": "0.20.0", "kind": "ChatModel", "capability": "Telo.Invocable",
   "description": "A chat model called through the chat completions API, served by OpenAI or any OpenAI-compatible endpoint: model id, the request every call goes through — whose client carries the base URL and the credential — and default request options that per-call overrides win over. The portable choice; almost every compatible endpoint serves this API and not the responses one.",
   "categories": [{"slug": "ai", "label": "AI"}]},
  {"ref": "oci://ghcr.io/telorun/openai", "version": "0.20.0", "kind": "ResponsesModel", "capability": "Telo.Invocable",
   "description": "A chat model called through OpenAI's responses API: model id, the request every call goes through — whose client carries the base URL and the credential — reasoning effort, and default request options that per-call overrides win over. Reasoning survives a tool loop, which the completions API cannot do.",
   "categories": [{"slug": "ai", "label": "AI"}]}]}
```

After — `Model` is listed and marked deprecated:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/ai", "kind": "Model"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/ai", "version": "0.37.0", "kind": "Buffered", "capability": "Telo.Invocable",
   "description": "Presents a streaming model as a buffered one: it drives the stream, collects every part and folds them into a single completed answer with its usage and finish reason. For a provider that only streams, and for consumers that want one answer rather than a sequence.",
   "categories": [{"slug": "ai", "label": "AI"}], "runtimes": ["nodejs"]},
  {"ref": "oci://ghcr.io/telorun/openai", "version": "0.20.0", "kind": "ChatModel", "capability": "Telo.Invocable",
   "description": "A chat model called through the chat completions API, served by OpenAI or any OpenAI-compatible endpoint: model id, the request every call goes through — whose client carries the base URL and the credential — and default request options that per-call overrides win over. The portable choice; almost every compatible endpoint serves this API and not the responses one.",
   "categories": [{"slug": "ai", "label": "AI"}], "runtimes": ["nodejs"]},
  {"ref": "oci://ghcr.io/telorun/openai", "version": "0.20.0", "kind": "Model", "capability": "",
   "description": "Deprecated alias of ChatModel, kept so a manifest written against an earlier version keeps loading. Use ChatModel.",
   "categories": [{"slug": "ai", "label": "AI"}], "runtimes": ["nodejs"],
   "deprecated": {"reason": "Renamed to ChatModel, so the completions and responses pairs are named symmetrically for the API each speaks.", "replacedBy": {"kind": "ChatModel", "ref": "oci://ghcr.io/telorun/openai"}}},
  {"ref": "oci://ghcr.io/telorun/openai", "version": "0.20.0", "kind": "ResponsesModel", "capability": "Telo.Invocable",
   "description": "A chat model called through OpenAI's responses API: model id, the request every call goes through — whose client carries the base URL and the credential — reasoning effort, and default request options that per-call overrides win over. Reasoning survives a tool loop, which the completions API cannot do.",
   "categories": [{"slug": "ai", "label": "AI"}], "runtimes": ["nodejs"]}]}
```

A built-in contract, whose own module is a source of implementations. Request:

```json
{ "ref": "oci://ghcr.io/telorun/telo", "kind": "LogSink" }
```

Before — only the foreign backend; the built-in sinks, which most applications plug in, are missing:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/telo", "kind": "LogSink"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/otlp", "version": "0.8.0", "kind": "Sink", "capability": "Telo.Sink",
   "description": "A destination for log records that batches them and sends them to an OpenTelemetry collector, filtered by minimum severity and bounded by a buffer with a drop policy. Delivery is a network round-trip, so a flush cannot be awaited synchronously and records held only here may be lost if the process dies at once.",
   "categories": [{"slug": "observability", "label": "Observability"}]}]}
```

After — built-in rows have no `runtimes`, as a portable hit has none:

```json
{"extends": {"ref": "oci://ghcr.io/telorun/telo", "kind": "LogSink"}, "implementations": [
  {"ref": "oci://ghcr.io/telorun/telo", "version": "0.141.0", "kind": "ConsoleSink", "capability": "Telo.Sink",
   "description": "Writes structured log records to standard error or standard output, as pretty text for a terminal or as JSON lines for a collector, with optional colour. The zero-configuration destination every runtime provides.",
   "categories": []},
  {"ref": "oci://ghcr.io/telorun/telo", "version": "0.141.0", "kind": "FileSink", "capability": "Telo.Sink",
   "description": "Appends structured log records to a file on the host, as JSON lines or pretty text. The destination path is required; level filtering, buffering and flushing follow the log destination settings.",
   "categories": []},
  {"ref": "oci://ghcr.io/telorun/otlp", "version": "0.8.0", "kind": "Sink", "capability": "Telo.Sink",
   "description": "A destination for log records that batches them and sends them to an OpenTelemetry collector, filtered by minimum severity and bounded by a buffer with a drop policy. Delivery is a network round-trip, so a flush cannot be awaited synchronously and records held only here may be lost if the process dies at once.",
   "categories": [{"slug": "observability", "label": "Observability"}], "runtimes": ["nodejs"]}]}
```

### Authoring agent

- The `LIBRARY INDEX:` is `list_libraries` as above, so it holds contracts, plain modules and features, with each implementing module named under its abstract.
- The author mounts `find_implementations` beside `get_kinds` and the guides.
- The primer's discovery workflow becomes:
  1. Match each need against the index. A backend the user names ("use Redis") is found by its module name under an abstract.
  2. In one turn: `get_kinds` for the kinds chosen, `find_implementations` for each abstract chosen, and `find_kinds` for the needs the index does not answer.
  3. One more `get_kinds` for the backends chosen: the one the user named, else the simplest row that has no `deprecated` marker and whose `runtimes` is absent or lists the target kernel. The reply names the choice. A deprecated row is never chosen; its `replacedBy` is.
- The `find_kinds` sub-agent's prompt reads folded hits. It chooses the abstract, plus the matched implementation the need names — never a deprecated one — else one from `find_implementations`.

## Decisions

- **Fold, never drop.** Dropping hid `App.Instance` (extends `Channel.Text`) from "run a child application", and hid `postgres` from someone searching for "postgres".
- **Derived from `extends`, not declared.** A declared "backend" marker would be new manifest surface needing `requires:` floors in every module, and an author can mislabel a module. The `extends` edges already prove the relation.
- **Per kind, not per library.** "Every kind extends a foreign abstract" missed `openai` / `anthropic` (their `Client` extends the concrete `Http.Client`) and every `*-postgres` module exporting a `Table`. The per-kind rule trims those libraries' lines without hiding them.
- **Fold into the nearest abstract, look up transitively.** Folding further up would hide the intermediate contract; a lookup stopping at the nearest abstract dead-ends on `ApiKey.Store`, and one skipping the contract's own module loses `ConsoleSink` / `FileSink`, what most applications plug into `Telo.LogSink`.
- **One implementation relation for every surface.** The tool, the route and the index lists answer one question, so a list that reads as "no backends" never sits beside a lookup that returns one, and hub-web's "Implemented by" never shows an abstract nobody can declare.
- **Every abstract is a key, empty or not.** An abstract nothing implements is a contract an author may need to implement; hiding it, or returning it to `kinds`, would defeat the index saying which kinds are abstract.
- **Deprecated kinds stay listed, marked.** The relation is what a slot accepts, which a deprecated kind still is; dropping it would promote it to an unfolded search hit, and leaving the marker to its description lets the agent pick it.
- **Filters judged per row.** Bringing in a contract the filter excludes would answer outside what the caller asked for, and disagree with the index for the same relation.
- **Read-time derivation, not an ingest column.** A column written at ingest would be wrong whenever the parent module is ingested later or changes which kinds are abstract.
- **No count on abstract hits, no `runtime` on `find_implementations`.** The agent calls `find_implementations` for every abstract it chooses, so a count changes no action and would have to agree with it forever; each row's `runtimes` already says what a caller filters on.
- **Backends named in the index, not dropped and not counted.** A dropped backend sends a user's "use Redis" through a `find_kinds` run; a count adds nothing the agent acts on.
- **The fold is MCP-only.** The model-facing projections are where every byte is paid for. Hub-web and studio read the HTTP routes, and folding there would change what they display.
- **`find_implementations` on the author, not only on the sub-agent.** Choosing a backend is an exact lookup with no model call, and going through `find_kinds` would spend a low-effort model run on it.
- **Third-party nested refs (`apify/...`, half the index) are left as they are.** That is a separate change.

## Verify

- A hub integration test over fixture modules:
  - Set-up: an abstract; a foreign implementation; a same-module implementation; a chain through `Self.`; a kind extending a concrete foreign kind with and without an abstract further up; a kind extending an untracked kind; a kind extending `Telo.LogSink`; a kind with only a `capability:`; an abstract refining a foreign abstract, with a concrete kind below it in a third module; an implementation of another publisher's abstract; a backend inside a category whose abstract is outside it; a parent ingested after its implementation; a deprecated kind with a `replacedBy`.
  - `search_resources`: the fold, the rank, an abstract brought in by a backend-only match, `limit` after folding, `runtime` ("redis" on `rust` answers no `KeyValueStore` hit), a backend whose abstract fails `category` or `publisher` answered unfolded with its `extends`, a matched abstract whose every implementation is filtered out answered without `matchedImplementations`, a deprecated implementation carrying `deprecated` in `matchedImplementations`, instances unfolded, a same-module implementation unfolded, and no hit carrying a count of implementations.
  - `list_libraries`: a backend-only library has no entry and its name is under its abstract; `otlp` under the built-in `LogSink`; under a publisher filter, an implementation of another publisher's abstract keeps its kind in `kinds`; every exported kind of the listed libraries is placed exactly once; for every abstract key, the list equals the distinct modules, among those the request lists, of the rows `find_implementations` returns for it, a deprecated kind's module included; `ApiKey.Store` names `ApiKeyPostgres`; the capability abstracts list `[]`.
  - `find_implementations`: `ApiKey.Store` and `ApiKeySql.Store` both answer `ApiKeyPostgres.Store`; `Ai.Model` answers `Buffered` (same module), `ChatModel`, `Model` and `ResponsesModel`, with `deprecated` on `Model` only; `Telo.LogSink` answers `ConsoleSink`, `FileSink` and `OTLP.Sink`; `Http.Client` answers `openai`'s `Client`; `runtimes` omitted when portable or built-in.
  - The e2e `GET /implementations` case answers `ApiKeyPostgres.Store` for `ApiKey.Store` and the same set of rows as `find_implementations`.
- An `e2e/mcp-tools` case for the new members, and for `find_implementations` taking only `ref` and `kind`.
- `chat/tests/find-kinds.yaml`: the hub stub serves `find_implementations`, folded hits and the folded index. A "use Redis" case: the author calls `get_kinds` for the contract and `find_implementations` on `kv-store`'s `Store` in one turn, then `get_kinds` for the backend, with no `find_kinds` call. A stub offering a deprecated and a current backend never has the deprecated one chosen.
- `chat/tests/asks-before-building.yaml` (live) still passes.
- Measure `list_libraries` for `ghcr.io/telorun` before and after on the hub, to confirm the index does not grow. The repo's manifests predict about 10 KB less; the point of the change is that each contract is stated once, not the size.

## Docs and release

- The hub guide: the two relations, the fold, per-row filters, the index's `abstracts`, read-time derivation, the fold being MCP-only, the route reading the same implementation relation.
- The tool descriptions: `search_resources` (`matchedImplementations`, per-row filters), `list_libraries` (`abstracts`: its keys, lists and that a refining abstract keeps its own entry) and `find_implementations` (transitive, any module, a concrete contract, `runtimes`, `deprecated`).
- The authoring agent guide's Discovery section: `find_implementations` mounted, the index's shape.
- The hub's MCP `instructions:` composing steps, still within 4096 characters.
- `docs/coding-agents.md`'s tool list.
- The primer (its `LIBRARY INDEX:` paragraph saying a name under an abstract is a module holding an implementation of it, and its discovery workflow including the deprecated-row rule), the index preamble message, and the sub-agent prompt.
- One `telo release add --kind Added` fragment for `apps/hub`, saying `GET /implementations` now answers the transitive relation, and one for `apps/authoring-agent`, each body naming only its own change.
- No benefits-ledger entry: this changes no feature an app author gets.
