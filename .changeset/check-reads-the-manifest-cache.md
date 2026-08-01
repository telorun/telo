---
"@telorun/cli": minor
"@telorun/kernel": patch
"@telorun/analyzer": patch
---

`telo check` no longer re-downloads every import on every run.

It built its `Loader` from `[LocalFileSource, ...transports]` — `LocalManifestCacheSource` was absent, and nothing wrote the cache afterwards. So every `oci://` and registry import was pulled from the origin on every invocation, including fully digest-pinned ones whose bytes cannot change. The loader was also constructed per input path, so one `telo check a b c` re-fetched a module shared between them once per file. Checking the repo's examples took 41s of which 35s was network, with `http-server` and `console` each fetched six times inside a single process.

`check` now registers the same manifest cache `run` reads and write-throughs after a successful load, and shares one loader across every input path (its `urlToSource` / `fileCache` dedupe by canonical URL, so the resolution result never depended on which entry asked). A cache source is registered per input path's cache root; entries are content-addressed, so a hit under any root is as good as a hit under the one that path would write to.

Freshness is kept honest rather than assumed, per cache-key shape:

- A **pinned** import — what `telo install` writes and what every published manifest carries — is verified against its inline `sha256-` hash on read, so it needs no network at all.
- An import naming a **mutable OCI tag** is revalidated with one `HEAD` per reference (once per invocation, not once per input path) against the digest that produced the cached copy, recorded in `.telo/manifests/.origins.json`. A tag that has moved, or was never recorded — e.g. a cache written by `telo run` — drops that one entry and reloads it.
- A **registry** ref is always version-segmented, and a published version is immutable by the same convention npm relies on, so it is served without revalidation. This is a deliberate call: the registry origin has no cheap freshness probe (`digest()` downloads the manifest to hash it), so revalidating would cost exactly what re-fetching costs.
- An arbitrary **HTTP(S) URL** import is never read from the cache by `check`. Its key carries no version segment — one URL is one path forever — so a hit would be served for the lifetime of the directory regardless of what the server now returns. Re-fetching costs one request, which is exactly what revalidating would cost, so the honest option is also the cheap one. `check` still writes these entries, since `telo run` reads them.

So `check` cannot report a clean bill of health against a manifest that has changed upstream.

On the kernel side, read-side `OciClient`s are pooled per `(host, repo)` on the `OciTransport` instance instead of built per operation. The client caches bearer tokens per scope, but a per-operation client discarded that cache immediately, so every manifest and every blob paid its own 401→challenge→token round trip plus a `~/.docker/config.json` read and possibly a credential-helper subprocess. An expired token still self-heals through the existing 401 retry. The pool belongs to the instance rather than the module so a second transport — a test, or a second in-process kernel — never inherits another's credentials; `defaultTransportRegistry` is memoized per registry URL, so the production lifetime is unchanged. Publishing keeps its own client.

`Loader.forget(url)` drops one file's memo (every parse variant, plus every request URL that canonicalised to it) so a single stale manifest can be re-resolved without discarding the whole loader and every unrelated file's cached resolution with it. The loader already documented needing this for watch mode.

Checking the examples now takes 1.2s warm; a single pinned manifest resolves with no network at all.
