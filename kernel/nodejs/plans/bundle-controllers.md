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

Bundling is **polyglot by design** — `pkg:telo` is runtime-neutral and the
loader dispatches on `?format=`. What's *implemented in this (Node) kernel* is a
subset:

- **In (implemented):** `format=js` controllers. A bundled JS source is
  self-contained (esbuild inlines deps; `@telorun/sdk` is bundled in and stays
  identity-correct via the SDK's globalThis/Symbol design — see below), so it
  `import()`s with no install.
- **Recognized, not yet hostable here:** `format=napi` (prebuilt `.node`) and
  `format=wasm` → `ControllerEnvMissingError`, so the candidate list falls
  through. These are the extension points; a Node kernel could grow napi/wasm
  support, and a future Rust kernel adds its own formats. This is the
  per-platform-binary matrix the publish side still has to solve for native.
- **Out (publish v1):** the CLI bundler emits `format=js` only and refuses a
  controller with non-bundleable deps (native `.node` addons), telling the
  author to keep `pkg:npm` — until napi bundling lands.

## Locator

PURL type `pkg:telo`, e.g.:

```
pkg:telo/javascript@0.4.1?format=js&path=./nodejs/script.mjs#script
```

**`pkg:telo` names the delivery only** — "the controller ships inside the
module's own bundle (the Telo registry artifact)," parallel to how `pkg:npm` /
`pkg:cargo` name *their* source registries. It is the one delivery whose runtime
is **not** fixed by an ecosystem (npm ⇒ JS, cargo ⇒ Rust; a bundle is just
files), so it — and only it — carries an explicit runtime via `?format=`.

- `format` qualifier — the **artifact format**, dispatched on by the loader:
  `js` → `import()`, `napi` → `require(.node)`, `wasm` → `WebAssembly`. Distinct
  from *runtime*: one runtime hosts many formats (the Node kernel does js + napi
  + wasm) and one format runs on many runtimes (wasm everywhere), so format ≠
  runtime. Inferred from the file extension when omitted.
- `path` qualifier — relative path to the artifact, resolved against the
  declaring manifest's `baseUri` (dev dir, extracted-cache dir, or runner
  working dir — same resolution in all three).
- `#fragment` — named export selecting the controller within the module
  (same semantics as the npm/napi loaders).
- Version segment mirrors the module version; carried for display/lockfile
  parity, not used for resolution (the bytes travel in the tarball).

### Kernel wiring

- `controller-loader.ts` `dispatchOne`: a branch
  `if (purl.startsWith("pkg:telo")) return this.bundleLoader.load(purl, baseUri)`.
- `ControllerResolveSource`: `"bundle"` (always an instant local resolve —
  never a "downloading…" line).
- **No `runtime:` label for bundling.** Runtime labels name a host runtime
  (`nodejs → pkg:npm`, `rust → pkg:cargo`); bundling is a delivery, not a
  runtime, so there is no `bundle` label. `pkg:telo` is selected via the default
  policy's `*` wildcard. **Selection model A** (current): a `pkg:telo` candidate
  loads if the kernel can host its `format`, else env-misses to the next; order
  is preference. **Model B** (future, additive, same PURL shape): map a runtime
  label to the `(type, format)` set it accepts (`nodejs ← pkg:npm | pkg:telo?format=js`,
  `rust ← pkg:cargo | pkg:telo?format=napi`) so `runtime:` selects bundles too.

## `BundleControllerLoader` (kernel/nodejs/src/controller-loaders/bundle-loader.ts)

The simplest of the three loaders — no install root, no lock, no `.telo-state`.

```
load(purl, baseUri):
  1. parse purl (PackageURL.fromString) → { qualifiers.path, qualifiers.format, subpath }
  2. resolve absolute file = resolve(dirname(baseUri), path)
     (missing path / remote baseUri / missing file → ControllerEnvMissingError
      so a mixed candidate list falls back to the next candidate)
  3. format = qualifiers.format ?? inferFromExtension(file)
     (a format this kernel can't host — anything but "js" today, e.g. napi/wasm —
      → ControllerEnvMissingError, so the list falls through to a sibling here or
      a candidate another runtime's kernel can load)
  4. await ensureRealmSymlinks(dir); mod = await import(pathToFileURL(file).href)  // js
  5. instance = subpath ? mod[subpath] : mod
  6. validate exports create()/register() (missing export, or present-but-not-a-
     controller, → ERR_CONTROLLER_INVALID — distinguished for an actionable error)
  7. return { instance, source: "bundle" }
```

### Realm: resolution (the hook) vs identity (free)

Authors write a normal `import { Stream } from "@telorun/sdk"`. Two separate
things have to hold, and they're easy to conflate:

- **Resolution** — the bare specifier must point at a file. A bundle lives in a
  cache/extract dir with no `node_modules` path to the SDK, so
  `ensureRealmSymlinks()` symlinks the `REALM_COLLAPSE_NAMES`
  ([realm.ts](../src/controller-loaders/realm.ts)) into a `node_modules/` next to
  the bundle, pointing at the kernel's own package root. Standard module
  resolution then finds them. **Why a symlink, not a hook:** Node ESM resolve
  hooks (`module.register`) aren't honoured by Bun, and `Bun.plugin` doesn't
  intercept runtime `import()` either (both verified) — a `node_modules` symlink
  is the one mechanism that resolves on *both* runtimes. Idempotent, cached per
  dir; gitignored (`node_modules`). On a k8s read-only run mount the link must be
  created at the extract phase (writable) instead of at load.
- **Identity** — the symlink targets the *kernel's* SDK package root, so
  `@telorun/sdk` resolves to the same module and `Stream`/`InvokeError` are the
  same instances automatically. Even if a publish step inlines the SDK into the
  bundle instead, identity still holds via the SDK's own singletons: `Stream` is
  a globalThis singleton (`Symbol.for("@telorun/sdk:Stream")`,
  [stream.ts](../../sdk/nodejs/src/stream.ts)) and `InvokeError` is recognized by
  `Symbol.for("telo.InvokeError")` via `isInvokeError`
  ([invoke-error.ts](../../sdk/nodejs/src/invoke-error.ts)), not `instanceof`.

The earlier "no hook needed" framing was wrong: it was true for *identity* but
not for *resolution*. The symlink is what lets authors write a plain import — no
`globalThis` access, no per-bundle `node_modules` to author, no ceremony. It
covers the dev loop (editor → docker-runner raw sources) too, since they import
the SDK the same way.

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

Two independent tracks. The **run** track (loader) is the foundation for
*running* a bundled controller (dev-loop and post-install) and is
registry-independent; the **distribution** track must go registry-before-CLI
(the CLI can't PUT a tar.gz until the registry accepts it).

1. ✅ **`BundleControllerLoader`** (kernel) — resolve `?path=`, `import()`,
   validate exports. No realm hook (SDK is dual-realm safe). Proven by
   `tests/bundle-controller-loads.yaml`: a `pkg:telo` controller loads, invokes,
   and the `Stream` it returns flows through `PlainText.Decoder`.
2. ✅ **`pkg:telo` dispatch + `runtime: bundle` label** (kernel). Picked up by
   the default policy's `*` wildcard; `runtime: bundle` selects it explicitly.
3. ✅ **Prerequisite kinds** — separate plan
   ([binary-stream-prerequisites](../../modules/http-server/plans/binary-stream-prerequisites.md)):
   http-server stream body, `std/gzip`, `std/tar`, `S3.Put` binary, `S3.Delete`.
   **Released + published.**
4. ✅ **Registry accepts tar.gz** — dedicated `PUT`/`GET
   /{ns}/{name}/{ver}/module.tar.gz` routes (single-format per route, so the
   `text/yaml` path is untouched). `PublishBundleHandler` auths, buffers the
   stream (`Octet.Decoder`), stores the tarball, reads it back via `S3.Get`
   (the tee), `Gzip.Decoder` → `Tar.Extract telo.yaml` → `PlainText.Decoder`,
   then **delegates** parse/validate/index/store-telo.yaml to the existing
   `PublishHandler`. Static-checked; **needs `test:e2e` (S3 + Postgres) for
   runtime verification.**
5. ⬜ **CLI publish bundle path**: esbuild (SDK bundled in, no externals) +
   non-bundleable refusal + tar/gz + PUT to `…/module.tar.gz`. Test against a
   local registry (`--registry=http://registry.telo.localhost`). Depends on 4.
6. ⬜ **Consumer cache extraction** of `module.tar.gz` into `.telo/manifests`.
7. ⬜ **Editor run-bundle** `.js` collection + relative-import crawl (dev loop;
   parallelizable with 5–6 once 1–2 landed).

Steps 1–2 (run track) are done and tested. Step 4 (registry) is done but only
static-checked here. Steps 5–7 remain.

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
