# Changelog

## 0.29.1 - 2026-08-29
### Fixed
* A streaming route's handler throw union is now declared by the `ai` operations it commonly mounts, so a route mounting one must cover its codes with a `catches:` entry or a catch-all. Previously the union was empty and the analyzer could check nothing.

## 0.29.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.
* Mounts declare their entry grammar (`entries` / `matcher` / `handler`), so the editor renders them as an ordered list of mount points rather than as a set of nodes — making mount order, which is match order, visible and editable.

## 0.28.0 - 2026-08-21
### Fixed
* Declare `inputs: /inputs` on the route handler's `x-telo-ref`, naming the sibling map that holds the call's arguments. Nothing previously tied a route's `inputs:` to the handler it invokes, so an editor could not offer the target's declared input keys there.

## 0.27.0 - 2026-08-20
### Added
* Http.Reference declares a referrer rule requiring the server that mounts it to declare an openapi: block, so a reference with nothing to render is a telo check error on the server's mount slot rather than a failure at boot.
* `Http.Reference` serves the API documentation as a mountable router: the OpenAPI document the server collects is rendered at the prefix its mount declares, alongside the document itself as JSON and YAML. A mount entry now also takes `when:`, resolved once at startup, so the docs — or any other router — can be left out of a production deployment entirely rather than registered and hidden. BREAKING: declaring `openapi:` no longer serves anything by itself; the fixed /reference route is gone, and an app that wants the docs mounts an Http.Reference where it wants them.
### Fixed
* An Http.Server that failed to initialize reported Fastify's duplicate-route error instead of the reason it failed. The multi-pass init loop calls init() again on a resource that failed — which is how a mount not yet injected gets its second chance — while a route registers exactly once, so the second pass raised FST_ERR_DUPLICATED_ROUTE and buried the first failure. Route registration is now resumable: each mount records that it attached and a later pass registers only what is still missing, so a retry that can succeed still does and one that cannot reports its real cause.
* Switch off Fastify's own per-request log lines through the `logController` option and require fastify 5.12, removing the FSTDEP023 deprecation warning the top-level `disableRequestLogging` option now emits. A numeric `trustProxy` hop count is passed to Fastify as the predicate it means, since fastify 5.12 no longer honours the numeric form.

## 0.26.0 - 2026-08-16
### Added
* A multipart request body is accepted out of the box, as raw bytes. Fastify ships parsers for JSON and urlencoded only, so a route receiving a file upload answered 415 before any handler ran — naming a media type the author really did send and pointing at no fix. Raw rather than text because decoding a multipart body as a string corrupts every binary part. A `contentTypeParsers` entry for an exact multipart type still works and takes precedence for that type alone — Fastify consults exact-string parsers before pattern ones — so customizing form-data leaves related and mixed on the default.

## 0.25.0 - 2026-08-11
### Added
* Http.Server emits its own access record instead of passing Fastify's through, so the log is this kind's contract rather than one framework's prose — which is what lets a Rust or Go implementation of the kind produce records a single consumer can read. Each record carries an event_name (http.server.started, http.server.request, http.server.request.started, http.server.stopped); consumers key on that, never on the message text. Attributes follow OpenTelemetry conventions — http.route (the low-cardinality matched template) rather than url.path, and http.server.request.duration in seconds. One info record per request on completion instead of two, with the received-side record at debug where it still catches a request that hangs. Severity follows the response: info, except a 5xx which is error. A mount entry may carry its own logging.level, so a health endpoint polled every second or a static mount serving a built SPA can go quiet (level: warn) while the rest of the server keeps logging — the import-scoped threshold cannot express this, because one server is a single resource in a single scope. A quietened mount still reports its own 500. See docs/log-events.md.
### Fixed
* Http.Server request records no longer leak unbounded cardinality or misreport the server. http.route fell back to the concrete URL when no route matched, so an unauthenticated 404 scan wrote arbitrary strings into the info-level attribute dashboards group on; the key is now omitted, which is also what OpenTelemetry requires with no match. http.server.stopped is emitted only for a server that actually listened, so a consumer pairing start with stop never sees an unmatched close. url.scheme reports the socket rather than the advertised baseUrl, which is routinely https behind a TLS terminator while the socket is plaintext. The logger adapter is also injected unconditionally: gating it on info handed Fastify its null logger at level: warn and silently dropped every diagnostic Fastify owns — its error-handler failures, reply-send failures and aborted-request hooks — which are exactly the records warn is meant to keep.## 0.24.0 - 2026-08-09
### Added
* metadata.name is now HttpServer, so the module contributes its kinds under the `HttpServer.<Kind>` canonical prefix instead of `http-server.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.23.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.22.0 - 2026-07-30
### Added
* Update controller @telorun/http-server to 0.18.0.## 0.21.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.
### Fixed
* Update controller @telorun/http-server to 0.17.1.## 0.20.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.20.0 - 2026-07-27
### Added
* Update controller @telorun/http-server to 0.17.0.## 0.19.1 - 2026-07-20
### Fixed
* Update controller @telorun/http-server to 0.16.1.## 0.19.0 - 2026-07-20
### Added
* Update controller @telorun/http-server to 0.16.0.
* Request logging now goes through Telo's structured logger. Fastify's Pino instance is replaced with a Telo-backed adapter, so request records are Telo records at the source and inherit the root Application's `logging:` block — level, encoding, redaction, and sinks. The `logger:` field now means "enable request logging" rather than being a raw Fastify passthrough. Headers are not captured by default.## 0.18.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.17.1 - 2026-07-14
### Fixed
* Update controller @telorun/http-server to 0.15.2.## 0.17.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.16.1 - 2026-07-06
### Fixed
* Update controller @telorun/http-server to 0.15.1.## 0.16.0 - 2026-06-23
### Added
* Update controller @telorun/http-server to 0.15.0.## 0.15.1 - 2026-06-20
### Fixed
* Update controller @telorun/http-server to 0.14.1.## 0.15.0 - 2026-06-20
### Added
* Update controller @telorun/http-server to 0.14.0.
* Add the `Http.Static` mount — serve a directory of static assets (built SPA, plain HTML, images) on an Http.Server, with a manifest-relative `root`, `spaFallback` for client-side routing, and `maxAge` / `immutable` cache control.## 0.14.0 - 2026-06-20
### Added
* Update controller @telorun/http-server to 0.13.0.## 0.13.0 - 2026-06-18
### Added
* Update controller @telorun/http-server to 0.12.0.## 0.12.1 - 2026-06-16
### Fixed
* Update controller @telorun/http-server to 0.11.1.## 0.12.0 - 2026-06-15
### Added
* Update controller @telorun/http-server to 0.11.0.## 0.11.0 - 2026-06-07
### Added
* Update controller @telorun/http-server to 0.10.0.
* Module `description` and schema `examples:` for registry / MCP discovery (`search_modules` + `get_module_manifest`).
### Fixed
* Validate `Http.Server` mounts strictly — each entry now requires `mount:` and rejects unknown keys, so a misnamed or missing mount reference is caught at `telo check` instead of failing only at boot.## 0.10.0 - 2026-06-07
### Added
* Update controller @telorun/http-server to 0.9.0.## 0.9.0 - 2026-06-06
### Added
* Document the OpenAPI seams on Http.Api routes — request field gains a description pointing at request.schema, and content[mime].schema notes it feeds the generated OpenAPI response. Adds a fully-documented route example (request.schema + response schema with field examples).## 0.8.2 - 2026-06-06
### Fixed
* Clarify the response body field accepts a YAML object (auto-serialized to JSON); don't embed a JSON string.## 0.8.1 - 2026-06-05
### Fixed
* Update controller @telorun/http-server to 0.8.1.## 0.8.0 - 2026-06-05
### Added
* Update controller @telorun/http-server to 0.8.0.## 0.7.0 - 2026-06-04
### Added
* Update controller @telorun/http-server to 0.7.0.## 0.6.1
