# Registry Asset Bundling

Let `pnpm telo publish` ship arbitrary files (HTML, JS, CSS, …) alongside `telo.yaml`. They land at `https://registry.telo.run/<ns>/<name>/<ver>/<path>` and are reachable as plain URLs.

The artifact stops being a single YAML and becomes a gzipped tarball (`.tar.gz`, `Content-Type: application/gzip`). The server unpacks to per-file S3 objects under `<ns>/<name>/<ver>/<path>`. The `modules` row gains a `files JSONB` column.

This is the foundation for downstream work (module-served web UIs, kernel `Self://path` URLs, registry-bundled controllers). Those are out of scope here.

## Pipeline

1. **CLI builds tar.gz** — first entry `telo.yaml` (post-inline / post-canonicalize / `assets:` stripped), then each declared asset; gzipped.
2. **CLI sends it** — `PUT /<ns>/<name>/<ver>` with `Content-Type: application/gzip`. Body's format, not transport encoding — do not set `Content-Encoding: gzip` (proxies may auto-decode it). Auth header unchanged.
3. **Server unpacks + validates** — reject non-regular files, `..` segments, leading `/` or `\`, null bytes, duplicate paths. Bound the unpacked size during streaming (gzip-bomb mitigation: kill the stream once cumulative output crosses a configured ceiling).
4. **Server stores** — one S3 PUT per entry at `<ns>/<name>/<ver>/<path>`; UPSERT `modules` with `files = [{path, size, contentType, sha256}, …]`.

GETs need no new routes — the existing `notFoundHandler` ([apps/registry/telo.yaml:234-249](../telo.yaml#L234-L249)) already proxies any unmatched path to the public R2 bucket.

## Manifest

New top-level `assets:` field on `Telo.Library` / `Telo.Application`, peer of `include:`:

```yaml
include:
  - ./resources/*.yaml      # YAML, inlined into module scope (existing)
assets:
  - ./public/**             # static files, bundled into the tar (new)
  - ./dist/index.html
```

`string[]`, globs against the manifest dir, real-path must stay under it (same security check as `include:`). Forbidden in partial files. Stripped from `telo.yaml` before packing — it's a publish-time directive, not runtime metadata.

`assets:` only needs to be added to the manifest JSON Schema in [kernel/nodejs/src/manifest-schemas.ts](../../../kernel/nodejs/src/manifest-schemas.ts) so the analyzer accepts it; no runtime semantics.

## Data model

One migration appended to [apps/registry/telo.yaml](../telo.yaml):

```sql
ALTER TABLE modules ADD COLUMN files JSONB NOT NULL DEFAULT '[]'::jsonb
```

Each entry: `{ path, size, contentType, sha256 }`. `path` is the tar entry path = S3 key suffix. `contentType` is server-inferred from the extension (small built-in table; unknown → `application/octet-stream`) and used both as the S3 object's content-type and the recorded value. `sha256` is recorded for future verification, not enforced on read.

Existing rows keep `files = '[]'`. The pre-existing `file_key` column stays — `GET /<ns>/<name>/<ver>/telo.yaml` keeps working unchanged because the new pipeline writes the same key.

## Code changes

**CLI** ([cli/nodejs/src/commands/publish.ts](../../../cli/nodejs/src/commands/publish.ts)):

- After `canonicalizeRelativeImports`, parse the first doc, expand `assets:` globs (reuse the walker from `expandAndInlineIncludes`), then strip the field from the YAML.
- Pack with the [`tar` npm package](https://www.npmjs.com/package/tar) using `gzip: true` — `telo.yaml` first, then assets at their relative paths.
- Swap the existing `pushToTeloRegistry` body for the gzipped buffer and content-type to `application/gzip`; URL/auth/retry logic unchanged.
- Add `tar` to [cli/nodejs/package.json](../../../cli/nodejs/package.json).

**Server** ([apps/registry/telo.yaml](../telo.yaml)):

- `Telo.Import` for the new `modules/tar/` library (`Tar.Pack` / `Tar.Unpack`, `gzip: true` flag).
- Append the migration above.
- Add `application/gzip` to `Http.Server.contentTypeParsers` so bodies arrive as bytes.
- Rewrite the publish handler body: `checkHeader` / `verifyToken` / `checkToken` unchanged; add `unpack` (`Tar.Unpack` with `gzip: true` and a `maxUnpackedBytes` ceiling) → `storeFiles` (`Run.ForEach` over `entries`, inner sequence does `S3.Put` and emits the per-file metadata) → `record` (UPSERT `modules` with `files = $::jsonb` bound from `steps.storeFiles.result`). `catches:` gains `UNPACK_FAILED → 400` (covers malformed gzip, malformed tar, path-safety violations, and bomb-ceiling overruns).

The legacy `text/yaml` PUT path is removed — the registry releases in lockstep with the CLI, so old clients hitting the new server get a 415.

## New `Run.ForEach` step

Telo has no iteration kind today. Adding one to [modules/run/](../../../modules/run/) is part of this plan — the publish handler is the first consumer, but it's a generic stdlib gap.

Shape (a step variant of `Run.Sequence`, peer of `invoke` / `if` / `try` / `throw`):

```yaml
- name: storeFiles
  forEach:
    in: "${{ steps.unpack.result.entries }}"   # any array-typed CEL expression
    as: entry                                  # binds each item into the per-iteration CEL scope
    do:                                        # any single step shape; usually a nested Run.Sequence
      kind: Run.Sequence
      steps:
        - name: put
          invoke:
            kind: S3.Put
            bucketRef: { name: ModuleStore }
          inputs:
            key: "${{ inputs.fileKey + entry.path }}"
            body: "${{ entry.body }}"
            contentType: "${{ entry.contentType }}"
      outputs:
        path: "${{ entry.path }}"
        size: "${{ entry.size }}"
        contentType: "${{ entry.contentType }}"
        sha256: "${{ entry.sha256 }}"
```

`steps.storeFiles.result` is the array of per-iteration outputs in input order, ready to bind as the JSONB `files` column.

Commitments:

- The kernel's CEL environment grows a per-iteration binding under whatever name `as:` declares.
- An error mid-iteration halts the loop and propagates as a regular invocable error. Partial S3 writes are orphaned, but the `record` step never runs, so the version is invisible — orphan GC is a separate future concern.
- `Tar.Unpack` attaches `contentType` to each entry (extension-derived; consumer may override). Keeps the inner loop free of mime-inference plumbing.

## Tests

- CLI: build a manifest with `assets:`, intercept `fetch`, assert `Content-Type: application/gzip`, body decompresses to a tar whose first entry is `telo.yaml`, the YAML has `assets:` stripped, and every asset is present.
- Server: publish a tar.gz with `telo.yaml` + one HTML file, GET it back, assert bytes match.
- Server, path safety: post a tar.gz containing `../escape.txt`, assert 400 / `UNPACK_FAILED`.
- Server, gzip bomb: post a tar.gz that expands past `maxUnpackedBytes`, assert 400 / `UNPACK_FAILED` and that the stream was killed mid-decode (no full buffer in memory).
- `modules/tar/tests/`: pack/unpack round-trip with and without gzip, malformed input rejection.
