# Bundled controllers (`pkg:telo`)

Ship a controller's JavaScript **alongside `telo.yaml`** inside the module's
registry artifact, loaded by direct `import()` with no npm/crates install at
either end. This removes the two-track release problem (registry manifest +
separately-published npm package) for pure-JS controllers, makes the
editor→docker-runner loop install-free, and lets the k8s runner drop its
trusted-build `npm ci` job for bundle-only modules.

Bundling is a **delivery mechanism for a Node controller**, not a new runtime.
It coexists with `pkg:npm` and `pkg:cargo` in the same `controllers:` candidate
array — controllers that need native addons or Rust stay on their existing rail,
selected by the existing fallback policy.

## Scope

- **In:** pure-JS controllers. A `bundle:` source may import **only** the
  realm-collapse externals (`@telorun/sdk`, …), Node built-ins, and its own
  relative siblings (`./helper.js`). Anything else is a diagnostic.
- **Out:** native addons (`better-sqlite3`, `bcrypt`) and Rust — these keep
  `pkg:npm` / `pkg:cargo`. The publish-side bundler refuses to emit a bundle
  when it sees a non-bundleable dependency and tells the author to keep
  `pkg:npm`.
- **Out (v1):** per-platform binary tarballs. The `bundle` rail is JS-only for
  now; the native story is left on `pkg:npm`/`pkg:cargo`.

## Locator

New PURL type `pkg:telo`, e.g.:

```
pkg:telo/javascript@0.4.1?path=./nodejs/script.mjs#script
```

- `path` qualifier — relative path to the JS file, resolved against the
  declaring manifest's `baseUri` (dev dir, extracted-cache dir, or runner
  working dir — same resolution in all three).
- `#fragment` — named export selecting the controller within the module
  (same semantics as the npm/napi loaders).
- Version segment mirrors the module version; carried for display/lockfile
  parity, not used for resolution (the bytes travel in the tarball).

### Kernel wiring

- `runtime-registry.ts`: add `bundle: "pkg:telo"` to `LABEL_TO_PURL_TYPE`. No
  change to `KERNEL_NATIVE_PURL_TYPE` (`pkg:npm`) or `DEFAULT_POLICY` — `pkg:telo`
  is picked up by the `*` wildcard tail of the default policy, and `runtime:
  bundle` selects it explicitly. `orderCandidates` needs no change.
- `controller-loader.ts` `dispatchOne`: add a branch
  `if (purl.startsWith("pkg:telo")) return this.bundleLoader.load(purl, baseUri)`.
- `ControllerResolveSource`: add `"bundle"` (always an instant local resolve —
  never a "downloading…" line).

## `BundleControllerLoader` (kernel/nodejs/src/controller-loaders/bundle-loader.ts)

The simplest of the three loaders — no install root, no lock, no `.telo-state`.

```
load(purl, baseUri):
  1. parse purl → { path, fragment }
  2. resolve absolute file = resolve(dirname(baseUri), path)
     (env-missing → ControllerEnvMissingError so a mixed candidate list
      falls back to the next candidate, matching the napi loader's contract)
  3. ensureRealmHook()            // process-global, registered once
  4. mod = await import(pathToFileURL(file).href)
  5. instance = fragment ? mod[fragment] : mod
  6. validate instance exposes create() or register() (same check as npm loader)
  7. return { instance, source: "bundle" }
```

### Realm-collapse resolve hook (2b)

A bundled file still contains `import { Stream } from "@telorun/sdk"`. That bare
specifier **must** resolve to the kernel's own copy or `instanceof Stream`
breaks — the guarantee the npm loader gets today from `npm install file:` +
`peerDependencies` ([npm-loader.ts:216-232](../src/controller-loaders/npm-loader.ts#L216-L232)).

Replace that mechanism, for `pkg:telo` only, with a **process-global Node ESM
resolve hook**:

- Registered once (first bundle load), via `module.register` of a small resolver
  module.
- Intercepts exactly the `REALM_COLLAPSE_NAMES` set; maps each to
  `resolveKernelPackageRoot(name)` (already computed by the npm loader — extract
  it to a shared helper). Everything else (relative imports, Node built-ins)
  falls through to default resolution.
- No filesystem side effects → works identically under the k8s read-only mount.

This hook is the **riskiest, most novel piece** — build and test it first
(see Sequencing).

## Publish (cli/nodejs/src/commands/publish.ts + publishers/)

For a `pkg:telo` controller, replace the npm publish path with a bundle path:

1. **Bundle** — in the publisher's `build()` step
   ([publish.ts:400-419](../../cli/nodejs/src/commands/publish.ts#L400-L419)),
   run esbuild on the entry: `bundle: true`, `format: "esm"`, `platform:
   "node"`, `external: REALM_COLLAPSE_NAMES`. Emit a single `.mjs` into the
   module dir at the `path` location.
2. **Refuse non-bundleable deps** — if esbuild would inline a `.node` addon (or
   the dep graph references one), fail with an actionable message: keep this
   controller on `pkg:npm`.
3. **No npm publish, no PURL rewrite** — the `pkg:telo` PURL already points at
   the in-tarball path; `rewritePurls` is skipped for this type.
4. **Tar + gzip** — after `expandAndInlineIncludes` /
   `canonicalizeRelativeImports`, assemble the artifact:
   `telo.yaml` + every `pkg:telo` `path` file. Reuse / promote the existing
   hand-rolled tar+gzip writer from
   [apps/k8s-runner/src/tar.ts](../../apps/k8s-runner/src/tar.ts) into a shared
   CLI helper (no Telo kind needed — this is Node code).
5. **PUT** the `.tar.gz` with `content-type: application/gzip` instead of the
   current `text/yaml` body.

A new `publishers/` entry for `type: "telo"` (alongside the npm publisher)
encapsulates `build` (esbuild) and the no-op publish.

## Registry (apps/registry/telo.yaml)

The registry is itself a Telo app, so accepting tar.gz means a handler rewrite
on top of new stdlib kinds. **Those kinds are a hard prerequisite and live in a
separate plan:**
[modules/http-server/plans/binary-stream-prerequisites.md](../../modules/http-server/plans/binary-stream-prerequisites.md)
— `http-server` binary stream body, `std/gzip` `Gzip.Decoder`, `std/tar`
`Tar.Decoder`, `S3.Put` binary widening. **They must be released and published to
the registry before this handler rewrite can reference them** (the registry
imports them like any other dependency).

Pipeline (composed from those prerequisite kinds). The upload must be both
stored *and* extracted, i.e. read twice — rather than tee a live stream, the
handler buffers once (artifacts are small) and **reads back through `S3.Get`**
(already a byte stream) as the tee:

```
PUT (application/gzip)
  request.body : Stream<Uint8Array>             ← http-server raw stream body
    → Octet.Decoder → bytes : Uint8Array        ← buffer once (existing kind)
    → S3.Put "<ns>/<name>/<ver>/module.tar.gz"  (bytes, binary)  ← S3.Put widened
    → S3.Get same key : Stream<Uint8Array>      ← read back = the tee (exists)
        → Gzip.Decoder  : Stream<Uint8Array>    ← std/gzip (new)
        → Tar.Extract path="telo.yaml" : Stream ← std/tar (new)
        → PlainText.Decoder → text → Yaml.Parse → validate Library/Application
        → index namespace/name/version (SQL — exists)
        → S3.Put "<ns>/<name>/<ver>/telo.yaml"  (text — exists)
```

The registry **extracts server-side** (needed for SQL indexing and to keep
serving manifest-only `telo.yaml`) and **serves two GET artifacts**:

- `.../telo.yaml` — manifest only. Unchanged. Used by the editor's
  `RegistrySource` and the MCP `get_module_manifest`
  ([apps/registry/telo.yaml:675-691](../../apps/registry/telo.yaml#L675-L691)).
- `.../module.tar.gz` — **new** full artifact. Used by install/run.

The handler rewrite itself (content-type detection, the gzip→tar→extract→index
chain, the second `S3.Put`, the new `module.tar.gz` GET endpoint) stays in this
plan; it is unblocked once the prerequisite kinds above are published.

## Consumer install / cache

`LocalManifestCacheSource` already maps a registry ref to
`.telo/manifests/<ns>/<name>/<ver>/`. Extend the install/run write-through:

- For a `pkg:telo`-bearing module, download `module.tar.gz` and **extract** into
  that dir, so `path: ./nodejs/script.mjs` resolves next to the cached
  `telo.yaml` — the identical relative resolution the author uses in dev.
- Manifest-only consumers (analyzer/editor) keep fetching `.../telo.yaml`.

## Editor + runner (raw `.js`, no publish)

`RunBundle.files` is already `{ relativePath, contents: string }[]`
([packages/runner-core/src/contract.ts:31-34](../../packages/runner-core/src/contract.ts#L31-L34)) —
raw `.js` text drops in with no contract change.

- **Editing** the `.js` is already covered by the raw file explorer / unified
  open-editors tabs. Optional v1+ nicety: surface "this Definition is backed by
  `nodejs/script.js`" from the resource so the file is discoverable from the
  Definition, not just the tree.
- **Run-bundle builder** ([apps/telo-editor/src/run/bundle.ts](../../apps/telo-editor/src/run/bundle.ts)):
  for each local manifest, parse `pkg:telo` PURLs out of `Telo.Definition.
  controllers`, resolve `path`, include that file **plus its relative
  (`./`,`../`) import graph**. Bare imports are not crawled — they are externals
  (5a) or a diagnostic.
- The docker runner materializes the files next to `telo.yaml`; `telo run`
  resolves `bundle:` relative to the entry. **No install, no publish.** For a
  manifest whose controllers are all `pkg:telo`, the k8s runner's trusted-build
  `npm ci` job and its cache-poisoning threat model don't apply
  ([apps/k8s-runner/plans/kubernetes-runner.md:91-146](../../apps/k8s-runner/plans/kubernetes-runner.md#L91-L146)).

## Release-track impact

A bundle-only controller no longer publishes to npm → it needs **no changeset**;
the module's changie version covers the whole artifact. The CI guard
`pnpm changeset status` must stop demanding a changeset for controllers shipped
as `pkg:telo`. Update the relevant CLAUDE.md / CI note when this lands.

## Sequencing

1. **Realm resolve hook + `BundleControllerLoader`** (kernel). Highest risk.
   Prove `import()` of a hand-written `.mjs` with `import {Stream} from
   "@telorun/sdk"` yields a working controller and `instanceof Stream` holds.
   Kernel test fixture under `kernel/nodejs/` + a `tests/*.yaml`.
2. **`pkg:telo` dispatch + `runtime: bundle` label** (kernel). Fallback-chain
   test: `[pkg:telo …, pkg:npm …]` prefers the bundle, falls back on
   env-missing.
3. **Publish bundle path** (CLI): esbuild + externals + non-bundleable refusal +
   tar/gz + `application/gzip` PUT. Dry-run + a real round-trip test.
4. **Prerequisite kinds** — separate plan
   ([binary-stream-prerequisites](../../modules/http-server/plans/binary-stream-prerequisites.md)):
   http-server stream body, `std/gzip`, `std/tar`, `S3.Put` binary. **Release
   and publish before step 5.**
5. **Registry handler** rewrite to the gzip→tar→extract pipeline + `module.tar.gz`
   GET endpoint (depends on step 4 being published).
6. **Consumer cache extraction** of `module.tar.gz`.
7. **Editor run-bundle** `.js` collection + relative-import crawl.

Steps 1–3 deliver a working dev loop (editor/docker-runner) end-to-end before
any registry change. Step 4 (its own plan) and steps 5–6 add registry
distribution. Step 7 is the editor polish.

## Testing

- Kernel: bundle load + realm identity; fallback ordering; env-missing recovery.
- CLI: publish dry-run; bundle emitted; non-bundleable dep rejected;
  tar.gz round-trips and extracts to the right paths.
- Prerequisite kinds (gzip/tar/http-server/s3) — tested in their own plan.
- Registry: PUT a tar.gz → GET `telo.yaml` and `module.tar.gz`; manifest indexed.
- Editor: run-bundle includes the `.js` and its relative siblings; docker runner
  executes a `pkg:telo` controller with no install.

## Open items to confirm during implementation

- Exact `REALM_COLLAPSE_NAMES` set the resolve hook must cover (read from the
  npm loader's current list; keep the two in sync via a shared constant).
- Whether the run-bundle relative-import crawl should hard-error on a bare
  third-party import (recommended) or silently drop it.
