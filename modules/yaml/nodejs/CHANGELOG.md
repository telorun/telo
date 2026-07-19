# @telorun/yaml

## 0.4.2

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

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.3.0

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

## 0.2.2

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.1

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.0

### Minor Changes

- 019c62a: Initial release of the `yaml` module.

  Adds `Yaml.Parse` (`Telo.Invocable`): UTF-8 YAML string → `{ docs: object[] }`.
  Multi-document files are handled natively; single-doc callers read `docs[0]`.
  Malformed input throws `InvokeError("ERR_PARSE_FAILED")` carrying the parser
  error list on `error.data.errors`.

  `Yaml.Parse` is a plain `Telo.Invocable`, not a `Codec.Decoder` — YAML parsing
  needs the whole document up front, so the stream-oriented codec abstracts add
  nothing here. `Yaml.Stringify` (object → string) lands when the first consumer
  needs it.

  Primary use case: extracting metadata from a published manifest in handler
  code (e.g. the registry's publish endpoint reading `metadata.description`
  off the `Telo.Library` doc to populate its index).
