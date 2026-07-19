# @telorun/s3

## 0.5.2

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

## 0.5.1

### Patch Changes

- 721a241: Fix `S3.Get` surfacing a missing object as a generic 500 instead of
  `ERR_NOT_FOUND`. The S3 client lives in the `S3.Bucket` controller's bundle, so
  `err instanceof S3ServiceException` in a separately-bundled controller (each
  inlines its own copy of `@aws-sdk/client-s3` under `telo install`) was always
  false — the not-found branch never ran and the error escaped as
  `ERR_EXECUTION_FAILED`. Classify S3 errors structurally (`name` /
  `$metadata.httpStatusCode`) instead of by class identity, which is safe across
  bundle boundaries.

## 0.5.0

### Minor Changes

- 7621c13: New `S3.PresignedUrl` kind — mints a time-limited URL for an object via SigV4
  query presigning (`@aws-sdk/s3-request-presigner`): `get` for downloads, `put`
  for browser-direct uploads (with an optionally signed Content-Type). Pure
  local crypto: no request leaves the process and the object's existence is not
  checked. Expiry defaults to 900 s, configurable per resource and overridable
  per invocation, capped at the SigV4 limit of 7 days; the reported `expiresAt`
  is read back from the URL's signed `X-Amz-Date` + `X-Amz-Expires`. Also
  aligns `@aws-sdk/client-s3` to the presigner's release line.

## 0.4.0

### Minor Changes

- 8586b39: Resolve resource references uniformly across import boundaries and execution scopes.

  - **http-server**: `mounts[].type` is now an injected `Telo.Mount` reference (`!ref <name>`, or `!ref <Alias>.<name>` for a mount exported by an imported library) instead of a dotted kind-string. The server consumes the live injected instance, so an `Http.Api` / `Mcp.HttpEndpoint` defined in another library can be mounted across the boundary. The bare `Kind.Name` string form is removed.
  - **s3**: `bucketRef` is now an `x-telo-ref: "std/s3#Bucket"` slot (`!ref <bucket>` / `!ref <Alias>.<bucket>`); controllers consume the injected `S3.Bucket` instance, so S3 operations can reference a bucket exported by another library. The `{ name }` form is removed.
  - **analyzer**: `resolveRefSentinels` recurses into `x-telo-scope` resources, so a `!ref` inside a scoped resource (e.g. a `Run.Sequence` `with:` server's mount) is canonicalized to `{kind, name}` like any top-level slot.
  - **kernel**: Phase-5 dependency injection targets the (compile-CEL-expanded) resource the controller actually receives, so injected instances reach reference fields that also carry `x-telo-eval: compile` (e.g. `Http.Server.mounts`).
  - **sdk**: `CreatedResource` gains an optional `resource`, letting a factory return the expanded manifest the controller was created with.

## 0.3.0

### Minor Changes

- 030bfdd: Add `S3.Delete` (idempotent object delete by key), rounding the module out to a complete object-CRUD set. Widen `S3.Put`'s `body` to accept buffered binary (`Uint8Array`, e.g. the `bytes` from `Octet.Decoder`) in addition to a UTF-8 string.

## 0.2.2

### Patch Changes

- 0505e9b: s3: drop the unused `accessKeyId` / `secretAccessKey` library-level `secrets` contract

  `std/s3` declared `accessKeyId` and `secretAccessKey` as `Telo.Library` secrets,
  which the kernel treats as required inputs for every importer — yet nothing in the
  module reads them. Credentials flow per-resource: `S3.Bucket` is a `Telo.Provider`
  that takes `accessKeyId` / `secretAccessKey` as its own (compile-evaluated) fields,
  and `S3.Get` / `S3.Put` / `S3.List` reuse the bucket's client via `bucketRef`.
  Removing the dead contract lets consumers import `std/s3` without passing secrets
  that are never used. Docs updated accordingly.

## 0.2.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.2.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.1.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.1.0

### Minor Changes

- 0335074: Add `S3.Get` invocable kind. Reads an object from a bucket declared via `S3.Bucket` and returns `{ output, contentType }` where `output` is a `Stream<Uint8Array>` (annotated with `x-telo-stream: true`) of the object's bytes. Pair `output` with an Encoder (e.g. `Octet.Encoder`) inside an `Http.Api` response to stream a stored object straight onto the wire without buffering. Authentication uses the bucket's existing SigV4 credentials, so consumers no longer need a separate unauthenticated `HttpClient.Client` to proxy reads. Throws `ERR_NOT_FOUND` for missing keys, `ERR_INVALID_REFERENCE` when the bucket alias does not resolve, and `ERR_INVALID_RESPONSE` when the backend returns no iterable body — all enumerated in the kind's `throws.codes` so callers can write typed `catches:` entries.

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]

  - @telorun/sdk@0.12.0

- Updated dependencies [58362c4]

  - @telorun/sdk@0.12.0

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]

  - @telorun/sdk@0.12.0

- Updated dependencies [b62e535]

  - @telorun/sdk@0.12.0

- dccd3a6: Removed leftover debug `console.log` calls from `S3.List` controller (`invoke` and pre-`ListObjectsCommand` traces).
- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]

  - @telorun/sdk@0.12.0

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]

  - @telorun/sdk@0.12.0

- f061c35: `S3.Bucket` with `createIfMissing: true` now issues a `HeadBucketCommand` first and only calls `CreateBucketCommand` when the head returns 404. This avoids the spurious create-then-catch round trip against providers that log "bucket exists" attempts loudly (R2, MinIO). The existing `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` catch is kept as a guard against a head-vs-create race.

- Updated dependencies [3c4ac58]

  - @telorun/sdk@0.12.0

- Updated dependencies [353d7e5]

  - @telorun/sdk@0.12.0

- Updated dependencies

  - @telorun/sdk@0.12.0

- Updated dependencies

  - @telorun/sdk@0.12.0

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.12.0
