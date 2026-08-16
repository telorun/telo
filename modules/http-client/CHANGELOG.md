# Changelog
## 0.21.0 - 2026-08-16
### Added
* The `retry` blocks on Client and Request, and the deprecated `retries` count, are declared from the shared retry fragments instead of being written out per kind. Client's copy had drifted — it declared no defaults at all, so a client policy and a request policy disagreed about every value but `attempts`. The schemas stay closed; `honorRetryAfter` is merged onto the shared shape rather than composed with allOf, which could not have kept them closed. The controller now reads the deprecated `delay` duration string as `initialDelay`, the way the step leaf does — the shared shape carries the field, so accepting it and ignoring it would have made one declared policy mean two different things.## 0.20.0 - 2026-08-15
### Added
* Request bodies can now carry binary. `body` accepts raw bytes and a byte stream alongside a string and an object, with a sibling `bodyEncoding` for a base64 string — the slot `Fs.FileWrite.content` already ships. A byte value used to be JSON-stringified into `{"0":137,...}` with nothing to notice it. A byte stream is sent chunked and is single-shot - any re-send raises ERR_HTTP_BODY_NOT_REPLAYABLE rather than transmitting an empty payload.
* Which responses count as success and which are worth retrying are now declared per request. `success` and `retryOn` each take a list of statuses or a CEL predicate over status, headers and body; `retry` carries attempts, backoff, jitter and Retry-After handling, with the client supplying defaults. Retry used to be network-failures-only. Classification runs before redirect-following, so a status a request declares successful is returned rather than chased. `responseType` reads the body as json, text, bytes or a stream, chosen per call - a binary response read as text corrupts. Http.Request also declares its call contract, so step inputs are type-checked against it; `mode` and `retries` are deprecated aliases.## 0.19.0 - 2026-08-11
### Added
* Http.Request logs its outbound calls: each completed request with method, status and http.client.request.duration (OpenTelemetry's name, in seconds) at debug, a retried network failure at warn, and the re-acquire-and-retry after a 401 at info. Only the final outcome reaches the caller, so a request that failed and was retried — including the common case where the retry succeeds — was previously invisible. The URL is reported as url.scheme, server.address, server.port and url.path: the query string and any userinfo are dropped rather than scrubbed, so no credential can reach a record by construction, and the result is deliberately not published as url.full, which means the absolute URL.## 0.18.0 - 2026-08-09
### Added
* metadata.name is now HttpClient, so the module contributes its kinds under the `HttpClient.<Kind>` canonical prefix instead of `http-client.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.17.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.16.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.15.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.14.0 - 2026-07-29
### Added
* Update controller @telorun/http-client to 0.10.0.## 0.13.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.12.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.12.0 - 2026-07-27
### Added
* Update controller @telorun/http-client to 0.9.0.## 0.11.0 - 2026-07-19
### Added
* Update controller @telorun/http-client to 0.8.0.## 0.10.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.9.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.8.0 - 2026-07-14
### Added
* Update controller @telorun/http-client to 0.7.0.## 0.7.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.## 0.6.0 - 2026-06-05
### Added
* Update controller @telorun/http-client to 0.6.0.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/http-client to 0.5.0.## 0.4.1
