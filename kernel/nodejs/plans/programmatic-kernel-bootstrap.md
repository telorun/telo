# Plan — In-memory kernel bootstrap

Goal: drive the kernel from any URL the manifest-source chain resolves — file, memory, registry — without writing files. Full parity with disk: transitive `Telo.Import`, CEL `${{ }}` compilation, the loader's caching, all of it. Along the way, rename the entry point to match its actual shape, and rename `ManifestAdapter` → `ManifestSource` since these classes aren't really adapters in the GoF sense.

## Change

### Rename `loadFromConfig` → `load`

`loadFromConfig(yamlPath)` is a holdover — there's no "config" concept anywhere; it just takes any URL the manifest-source chain understands. With memory and registry sources in the picture, "config" is actively misleading. Rename to `load(url)` so it pairs cleanly with `start()` / `shutdown()`:

```ts
const kernel = new Kernel({ sources: [memory] });
await kernel.load("memory://app");
await kernel.start();
```

Touch points:

- [`kernel/nodejs/src/kernel.ts`](../src/kernel.ts) — method rename; the `@deprecated loadDirectory` shim that wraps it gets deleted in the same pass (it's already marked dead). Also drop the `new URL(runtimeYamlPath, file://${process.cwd()}/)` wrapper at [`kernel.ts:187`](../src/kernel.ts#L187): the source chain handles its own resolution (`LocalFileSource.read` already calls `path.resolve` against cwd; `MemorySource` and `RegistrySource` take the URL verbatim). Wrapping a `memory://app` input in a `file://`-based `new URL(...)` happens to pass through today only by URL-parser coincidence (non-special schemes ignore the base), but adds trailing-slash and host-case-folding risks that vary across runtimes. Pass `url` straight into `loader.resolveEntryPoint(url)`.
- [`sdk/nodejs/src/types.ts`](../../../sdk/nodejs/src/types.ts) — `Kernel` interface.
- [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts) — single call site.
- The `@telorun/test` suite runner ([`modules/test/nodejs/src/suite.ts`](../../../modules/test/nodejs/src/suite.ts)), which spawns sub-kernels per discovered test file.

No backwards-compat alias. The package is `0.4.x`; the version bump (minor) signals the break in the same changeset that ships `MemorySource` support and the `Adapter` → `Source` rename.

Note: `loadModule(url)` and `loadManifests(url)` stay as-is — they're loader pass-throughs that return manifest arrays for controller code (called via `ctx`), semantically distinct from the kernel-boot `load(url)`.

### Rename `Adapter` → `Source`

`ManifestAdapter` and the per-scheme classes aren't adapters in the GoF sense — they don't bridge incompatible interfaces, they're per-URL-scheme implementations of a single shared role: producing manifest text for a URL. "Source" names what they are in the domain ("a source of manifests"). Bundled into this changeset because the same minor bump already breaks `KernelOptions` for the `sources` field; doing the type rename now avoids a second disruption window.

Renames:

- Interface: `ManifestAdapter` → `ManifestSource` (in [`analyzer/nodejs/src/types.ts`](../../../analyzer/nodejs/src/types.ts)).
- Classes: `LocalFileAdapter` → `LocalFileSource`, `HttpAdapter` → `HttpSource`, `RegistryAdapter` → `RegistrySource`. The new in-memory class introduced below is `MemorySource` (not `MemoryAdapter`).
- Files / directories:
  - [`kernel/nodejs/src/manifest-adapters/local-file-adapter.ts`](../src/manifest-adapters/local-file-adapter.ts) → `kernel/nodejs/src/manifest-sources/local-file-source.ts`. The dead-stub `manifest-adapter.ts` in that dir is deleted (see the section below), so the directory rename is clean.
  - [`analyzer/nodejs/src/adapters/http-adapter.ts`](../../../analyzer/nodejs/src/adapters/http-adapter.ts) → `analyzer/nodejs/src/sources/http-source.ts`; same for `registry-adapter.ts` → `registry-source.ts`.
- `LoaderInitOptions` ([`analyzer/nodejs/src/types.ts:68-80`](../../../analyzer/nodejs/src/types.ts#L68-L80)): `extraAdapters` → `extraSources`, `includeHttpAdapter` → `includeHttpSource`, `includeRegistryAdapter` → `includeRegistrySource`.
- `Loader` internals ([`analyzer/nodejs/src/manifest-loader.ts`](../../../analyzer/nodejs/src/manifest-loader.ts)): private `adapters` field → `sources`; the `register(adapter)` parameter is renamed to `source`; `pick()` keeps its name (it's about URL→source dispatch, not adapter-specific).
- Public re-exports — these are part of the published API surface and consumers may import them directly:
  - [`kernel/nodejs/src/index.ts:4`](../src/index.ts#L4): `export { LocalFileAdapter } from "./manifest-adapters/local-file-adapter.js"` → `export { LocalFileSource } from "./manifest-sources/local-file-source.js"`. Add `export { MemorySource } from "./manifest-sources/memory-source.js"` alongside (the subpath export described in the `MemorySource` section is additive, not a replacement — top-level export is the simpler default; subpath is for callers who want the deep import).
  - [`analyzer/nodejs/src/index.ts:1-2`](../../../analyzer/nodejs/src/index.ts#L1-L2): `HttpAdapter` and `RegistryAdapter` re-exports → `HttpSource` / `RegistrySource`. Same file at line 11 re-exports the `ManifestAdapter` type → rename to `ManifestSource`.

Deliberate non-rename: the `source` *field* on `read()`'s return value (and on `metadata.source` — the URL string identifying where a manifest came from) stays as-is. Renaming it to `url` ripples through every controller and analyzer pass that reads `metadata.source` for diagnostics; not worth bundling here. The conceptual overload — a `Source` class produces records tagged with a `source` URL — is coherent: the field names where the manifest came from, the class names how to read from there.

The rest of this plan uses the new names (`ManifestSource`, `MemorySource`, `LocalFileSource`, etc.) throughout. References to current-code paths that still carry the old names (e.g. the dead-stub file to delete) are flagged explicitly.

### Kernel: caller declares all sources

Today the kernel hardcodes `this.loader.register(new LocalFileAdapter())` in the constructor — a hidden default that bakes in "this kernel reads disk." Drop that. The caller declares the full set of `ManifestSource`s they want; the kernel registers exactly those.

```ts
export interface KernelOptions {
  // ...existing fields
  sources: ManifestSource[];
}

constructor(options: KernelOptions) {
  // ...
  for (const source of options.sources) {
    this.loader.register(source);
  }
  // ...
}
```

`sources` is required (no `?:`). A caller that genuinely wants no manifest sources can pass `[]` and accept that every URL will fail; the explicit empty list documents intent better than an implicit default.

That's the entire kernel-side change. No new methods on `Kernel`. No `loadFromYaml`, no `addMemorySource`, no SDK interface additions. `load` is the only entry point and does the right thing once whichever sources the caller registered cover the URLs in play.

Note: the underlying `Loader` still auto-includes `HttpSource` and `RegistrySource` for `http://` and `pkg:` schemes — those serve controller resolution (`pkg:npm/...` references in `controllers:` fields) which is infrastructure rather than a user-facing transport choice. If a caller eventually needs to disable those too, plumb through `Loader`'s `includeHttpSource` / `includeRegistrySource` options. Out of scope here.

Touch points for the source break:

- [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts) — `new Kernel({ sources: [new LocalFileSource()] })`.
- [`modules/test/nodejs/src/suite.ts`](../../../modules/test/nodejs/src/suite.ts) — same.
- Anywhere else `new Kernel(...)` appears across the workspace.

Single minor bump along with the renames and memory-source additions.

### Delete the dead `ManifestAdapter` stub in kernel

[`kernel/nodejs/src/manifest-adapters/manifest-adapter.ts`](../src/manifest-adapters/manifest-adapter.ts) declares an interface (`ManifestSourceData` + a `readAll`-bearing `ManifestAdapter`) that nothing imports. The live interface is `ManifestSource` (post-rename) in [`analyzer/nodejs/src/types.ts`](../../../analyzer/nodejs/src/types.ts) — that's what `LocalFileSource` and the loader actually use, and its shape is different (no `readAll`; `read` returns `{text, source}`, not `ManifestSourceData`). Delete the kernel-side stub file as part of this change so future authors can't import the wrong type by accident. The path uses the old `manifest-adapters/` name only because deletion happens before the directory rename to `manifest-sources/`.

### `MemorySource` as a separate, opt-in piece

File location: `kernel/nodejs/src/manifest-sources/memory-source.ts`, alongside `local-file-source.ts` (post-rename). Top-level re-export from [`kernel/nodejs/src/index.ts`](../src/index.ts) per the rename section above; subpath export `@telorun/kernel/memory-source` ships alongside it for callers who prefer the deep import. Concrete change to [`kernel/nodejs/package.json`](../package.json) `exports` (extend the existing block; current shape kept verbatim for the `"."` entry):

```json
"exports": {
  ".": { ... existing ... },
  "./memory-source": {
    "types": "./dist/manifest-sources/memory-source.d.ts",
    "source": "./src/manifest-sources/memory-source.ts",
    "bun": "./src/manifest-sources/memory-source.ts",
    "import": "./dist/manifest-sources/memory-source.js",
    "default": "./dist/manifest-sources/memory-source.js"
  }
}
```

Implements [`ManifestSource` from `@telorun/analyzer`](../../../analyzer/nodejs/src/types.ts) (the live interface; the kernel-local stub gets deleted per the section above):

- `supports(url)` → `url.startsWith("memory://")`.
- `set(name, content: string | unknown[])` registers a source. `name` is a module name (`"app"`, `"lib"`) or a hierarchical key (`"auth/login"`); the source stores it internally under `<name>/telo.yaml`, mirroring disk's "module is a directory containing telo.yaml" convention. Partial files use explicit-extension names — `set("app/sub.yaml", ...)` is stored literally so it's reachable via `include: [./sub.yaml]` from `memory://app`. Names with leading `/`, `..` segments, or schemes are rejected at `set` time. Arrays of plain manifest objects are run through `yaml.stringify` (one document per `---` separator) so the loader downstream is identical to the YAML-text path. Callers use `memory://<name>` only where the loader requires a URL (the entry-point passed to `load`, and `Telo.Import.source` fields); the `/telo.yaml` suffix is internal canonicalization and never appears in user-facing URLs.
- `read(url)` strips `memory://` to a key. Look up the literal key first; if missing, fall through to `<key>/telo.yaml` (directory→telo.yaml, mirroring [`local-file-adapter.ts:28-32`](../src/manifest-adapters/local-file-adapter.ts#L28-L32) — pre-rename path — which does the same via `fs.stat`). On hit, return `{ text, source: "memory://<canonical-key>" }` where the canonical key is whichever matched — so `memory://app` returns `source: memory://app/telo.yaml`, and `memory://app/sub.yaml` returns `source: memory://app/sub.yaml`. On miss, throw with both keys tried in the message. The `/telo.yaml`-shaped `source` is what makes `resolveRelative` work transparently for `Telo.Import.source: ../sibling`-style relative imports — without it, `dirname` of a bare `memory://app` lands at the empty root and any `../` escapes immediately.
- `resolveRelative(base, relative)` → POSIX path semantics on the key portion of `base`. Reject `relative` that's already an absolute URL (scheme prefix) or starts with `/` — both are programming errors for memory and the loader already sends absolute-URL imports through a different branch ([`manifest-loader.ts:313-314`](../../../analyzer/nodejs/src/manifest-loader.ts#L313)). Otherwise: `posix.normalize(posix.join(posix.dirname(key), relative))`, throw if the normalized path starts with `..` (escaped namespace root), prepend `memory://` and return. The `/telo.yaml` canonicalization in `read` is what makes `dirname` produce the right base, so no special-casing is needed here. `node:path` is fine because `MemorySource` lives in the kernel package, not analyzer (CLAUDE.md's no-Node-builtins rule scopes only to analyzer for browser parity); a hand-rolled normalize is a 15-line swap if a browser-side memory source ever appears. Worked examples:

  Worked cases (`base` is the `source` returned by a prior `read`; the trailing parenthetical shows what the next `read` then resolves to):

  - `memory://app/telo.yaml` + `./sub.yaml` → `memory://app/sub.yaml` (`app/sub.yaml`, literal)
  - `memory://app/telo.yaml` + `../shared` → `memory://shared` (`shared/telo.yaml`, fall-through)
  - `memory://auth/login/telo.yaml` + `../register` → `memory://auth/register` (`auth/register/telo.yaml`)
  - `memory://app/telo.yaml` + `../../foo` → **error** (escapes namespace root)
  - `memory://app/telo.yaml` + `/foo` → **error** (no absolute root)

- No `expandGlob`, no `resolveOwnerOf`. Both are optional in the live interface and only exercised by filesystem-backed flows. Skipping `expandGlob` means globs in `include:` for memory-loaded modules are unsupported — the loader throws a clear error when a source lacks it ([`manifest-loader.ts:177`](../../../analyzer/nodejs/src/manifest-loader.ts#L177)). Test embedders enumerate entries explicitly via `set` and use literal include paths; that's enough. Skipping `resolveOwnerOf` means the analyzer/IDE's "walk parent dirs to find the owning `telo.yaml`" path doesn't apply to `memory://` URLs, which is fine — embedders pass an entry-point URL directly. If a real consumer ever needs glob expansion over the in-memory map (filtering keys against minimatch patterns), it's a small follow-up; out of scope here.

Caveats: callers holding `CompiledValue` instances cannot round-trip those through `yaml.stringify`; pass YAML text in that case. The escape check on `resolveRelative` (`..`-prefix after normalization) intentionally diverges from `LocalFileSource.resolveRelative`, which uses `path.resolve` and silently allows escapes outside the manifest dir — disk has a wider context, memory doesn't.

### Make `Loader.moduleCache` per-instance

[`manifest-loader.ts:26`](../../../analyzer/nodejs/src/manifest-loader.ts#L26) declares `moduleCache` as `private static readonly` — the cache is shared across every `Loader` in the process. Today this is mostly invisible because the CLI runs one kernel per process. Once embedders spin up multiple in-process kernels (the headline use case for the memory source — test runners, IDE previews, anything that wants throwaway kernels per case), a static cache means kernels with overlapping `memory://name` keys read each other's entries. The `text === text` re-check ([`manifest-loader.ts:73`](../../../analyzer/nodejs/src/manifest-loader.ts#L73)) prevents stale *content* from leaking, but tests still cross-pollinate via cache hits whose text happens to match, debugging gets confusing ("why is this manifest already loaded?"), and isolated-kernel reasoning quietly breaks.

Move the field to an instance property:

```ts
export class Loader {
  private readonly moduleCache = new Map<
    string,
    { text: string; manifests: ResourceManifest[] }
  >();
  // ...
}
```

Three call sites change ([line 26 declaration](../../../analyzer/nodejs/src/manifest-loader.ts#L26), [line 72 `.get`](../../../analyzer/nodejs/src/manifest-loader.ts#L72), [line 165 `.set`](../../../analyzer/nodejs/src/manifest-loader.ts#L165)): `Loader.moduleCache` → `this.moduleCache`. The field is private and unreferenced anywhere outside `manifest-loader.ts` — no external touch points. Each `Kernel` already constructs its own `Loader`, so per-instance caching is the right default; the static was an accident, not a deliberate cross-kernel hit-rate optimization. If a real workload ever wants a shared cache across kernels, the right shape is a `cache` option on `LoaderInitOptions` carrying an explicit shared `Map`, not an implicit static.

## Why this shape

Sources operate at the text layer ([`manifest-loader.ts:69`](../../../analyzer/nodejs/src/manifest-loader.ts#L69)): the loader takes text → parses → runs `precompileDoc` to wrap `${{ }}` strings in `CompiledValue`. Once any source answers `memory://`, the existing `load` path delivers full parity — CEL compile, transitive imports, the per-instance `moduleCache` all kick in for free. The kernel doesn't need to know memory exists; it just delegates URL resolution to whichever sources the caller handed it.

## Example

In-memory `Telo.Library` declares a kind; in-memory `Telo.Application` imports the library by `memory://` URL and uses the kind via alias. All `Telo.Import.source` values are local — disk only enters via `controllers:`, which is npm-resolved by `RegistrySource` (the standard path for any controller anywhere in the system).

```ts
import { Kernel } from "@telorun/kernel";
import { MemorySource } from "@telorun/kernel/memory-source";

const memory = new MemorySource();

memory.set(
  "lib",
  `
kind: Telo.Library
metadata:
  name: my-lib
  version: 1.0.0
exports:
  kinds:
    - Validate
---
kind: Telo.Definition
metadata:
  name: Validate
capability: Telo.Runnable
controllers:
  - pkg:npm/@telorun/assert@0.1.12#schema
schema:
  type: object
  properties:
    metadata:
      type: object
      properties: { name: { type: string } }
      required: [name]
    value: true
    schema: true
  required: [metadata, schema]
`,
);

memory.set(
  "app",
  `
kind: Telo.Application
metadata:
  name: InMemoryApp
  version: 1.0.0
targets:
  - Check
---
kind: Telo.Import
metadata:
  name: MyLib
source: memory://lib
---
kind: MyLib.Validate
metadata:
  name: Check
value: hello
schema:
  type: string
  const: hello
`,
);

const kernel = new Kernel({ sources: [memory] });
await kernel.load("memory://app");
await kernel.start();
// kernel.exitCode === 0 — MyLib.Validate dispatched through the in-memory alias chain
```

Same scenario via parsed-manifest input:

```ts
memory.set("lib", [
  {
    kind: "Telo.Library",
    metadata: { name: "my-lib", version: "1.0.0" },
    exports: { kinds: ["Validate"] },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Validate" },
    capability: "Telo.Runnable",
    controllers: ["pkg:npm/@telorun/assert@0.1.12#schema"],
    schema: {
      type: "object",
      properties: {
        metadata: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        value: true,
        schema: true,
      },
      required: ["metadata", "schema"],
    },
  },
]);
```

## Test

The kernel exercise is a TypeScript embedding test — it constructs `new Kernel({ sources: [...] })` and calls into the runtime, which can't be expressed as a Telo manifest. So this work brings vitest to the kernel package alongside the test itself.

Setup ([`kernel/nodejs/package.json`](../package.json)):

- Add `vitest` to `devDependencies` (matching version with [`apps/docker-runner`](../../../apps/docker-runner/package.json) for repo consistency — currently the canonical vitest user).
- Add `"test": "vitest run"` and `"test:watch": "vitest"` to `scripts`.

Test file: `kernel/nodejs/tests/load-from-memory.test.ts` constructs a kernel with a `MemorySource`, registers the two entries from the [Example](#example), calls `load("memory://app") → start()`, asserts `kernel.exitCode === 0`. Proves an in-memory application boots, resolves a `memory://` `Telo.Import` through `MemorySource`, and dispatches a library-declared kind via alias.

Note: the repo-level `pnpm run test` discovers Telo YAML manifests via `test-suite.yaml` and won't pick up `.test.ts` files. The kernel's vitest runs separately via `pnpm --filter @telorun/kernel test`. Wire it into CI in the same pass that adds the script — locate the workflow that runs per-package tests for vitest-using packages and include `@telorun/kernel`.

## Changeset

Per CLAUDE.md, every change to a published package needs a `.changeset/<name>.md`. This work touches four published packages — all minor bumps in a single changeset file:

- `@telorun/kernel` — `KernelOptions.sources` becomes required, `loadFromConfig` → `load`, `LocalFileAdapter` → `LocalFileSource`, new `MemorySource` export, `Loader.moduleCache` per-instance.
- `@telorun/analyzer` — `ManifestAdapter` → `ManifestSource`, `HttpAdapter`/`RegistryAdapter` renamed, `LoaderInitOptions` field renames, `Loader.register` parameter rename.
- `@telorun/sdk` — `Kernel.loadFromConfig` → `Kernel.load` on the interface.
- `@telorun/cli` — call-site updates for both the rename and the `sources` field.
- `@telorun/test` — same call-site updates in the suite runner.

Single `.changeset/<descriptive-name>.md` listing all five with `minor` bumps. Body summarises: "Replace `Kernel.loadFromConfig` with `load`, require `KernelOptions.sources`, rename `ManifestAdapter` → `ManifestSource` (and per-scheme classes), introduce `MemorySource` for in-memory kernel bootstrap, scope `Loader.moduleCache` per-instance."

## Out of plan

- Loader-level `manifest://` for parsed-manifest input. Add only if a real consumer needs it.
- Migrating any existing YAML test to in-memory. Disk path is simpler for those; `MemorySource` is for embedders and unit tests, not the integration suite.
- Renaming `metadata.source` (the URL string) to `metadata.url`. Touches every controller and analyzer pass that reads it for diagnostics; do separately if the field/class-name doubling becomes a real readability problem.
