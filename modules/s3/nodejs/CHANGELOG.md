# @telorun/s3

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
