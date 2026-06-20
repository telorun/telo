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

## Static assets & arbitrary bundled files (`files:`)

A bundled controller is referenced by a `pkg:telo` PURL, so its `path` file is
discoverable from the manifest. Static assets are not: a full-stack app serves a
built SPA via `Http.Static` (`root: ./public`), and `root` is a **directory**,
not a controller locator — no PURL points at `public/index.html`, the JS, the
CSS, the fonts. So the controller-driven file-set (`telo.yaml` + `pkg:telo`
paths) leaves them out, and a published app's `root: ./public` resolves to an
empty dir on the consumer.

The fix is an **author-declared file set** — the same primitive every package
manager ships (npm `files`, Cargo `include`, Go `//go:embed`):

```yaml
kind: Telo.Application   # or Telo.Library
metadata: { name: todo-app, version: 1.0.0 }
files:
  - public/**
```

- **Field**: `files:` — an ordered array of `.gitignore`-style patterns,
  resolved against the manifest directory. Allowed on **both `Telo.Application`
  and `Telo.Library`** (a library may ship bundled templates, migrations, seed
  data).
- **Distinct from `include:`** — `include:` inlines *YAML partial docs* into the
  manifest; `files:` carries *opaque asset files* that stay as separate files in
  the tarball. Distinct from `pkg:telo` paths — those are controller code pulled
  in by PURL; `files:` is everything else the app needs at runtime.
- **Selection is an allowlist with `.gitignore` semantics**, implemented with
  the [`ignore`](https://www.npmjs.com/package/ignore) package (see "Glob
  engine" below): positive patterns opt files **in**, `!` patterns carve them
  back out, **ordered, last-match-wins**. So
  `files: [ public/**, "!**/*.map" ]` ships `public/` without source maps. Order
  matters — `[ "!**/*.map", public/** ]` ships everything, because the later
  positive pattern re-includes it.
- **Always-on default-ignore set** — applied after the `files:` selection,
  independent of the author: `node_modules/`, `.git/`, `.telo/` (the manifest
  cache — bundling it would recurse), `.telobundle.*` (controller-bundle
  output). These are never shippable; a `files:` pattern cannot opt them back in.
- **Dir-confinement** is unchanged from `expandAndInlineIncludes`
  ([publish.ts:140-153](../../cli/nodejs/src/commands/publish.ts#L140-L153)):
  enumerate with `fs.readdirSync(recursive)`, then a
  `realpathSync().startsWith(realManifestDir)` check rejects any selected file
  that escapes the module root. Unlike `include:`, the resolved files are
  **added to the tarball at their relative paths**, not inlined into the YAML and
  not deleted from the manifest.

### Glob engine — `ignore` replaces `minimatch`

`minimatch` is used in exactly one place — the `include:` resolver
([publish.ts:131](../../cli/nodejs/src/commands/publish.ts#L131),
`patterns.some(p => minimatch(normalized, p))`). Both `include:` and `files:`
move to a shared `ignore`-based matcher:

```
selectFiles(allRelPaths, patterns):
  const sel = ignore().add(patterns)          // allowlist via gitignore engine
  const deny = ignore().add(DEFAULT_IGNORE)   // always-on
  return allRelPaths.filter(p => sel.ignores(p) && !deny.ignores(p))
```

Reading note: `ignore` returns `true` from `.ignores(p)` when `p` matches the
rule set — we *reinterpret* "matched" as "selected", and `!` negation then
subtracts exactly as in `.gitignore`. Paths must be manifest-relative with
forward slashes and no leading `/` (the lib rejects `../` and absolute paths) —
already true after `path.relative(manifestDir, …)`.

`include:` keeps working: a plain positive pattern (`partials/*.yaml`) selects
the same set under `ignore` as under `minimatch`; only `.gitignore` edge cases
(leading-`/` anchoring, trailing-`/` dir-only) differ, and no current `include:`
relies on those. Add `ignore` to `cli/nodejs` deps and drop `minimatch` (this is
its only CLI consumer; the kernel's separate `minimatch` dep is untouched).
- **Schema — analyzer `builtins.ts` only**: the `Telo.Application` and
  `Telo.Library` top-level schemas live **solely** in
  `analyzer/nodejs/src/builtins.ts` (the kernel's `manifest-schemas.ts` defines
  only `Telo.Definition`/`Telo.Abstract`; `kernel.load` validates Application/
  Library through `StaticAnalyzer`). Add `files` (array of strings) beside
  `include` in both the Application and Library schemas there. These schemas are
  `additionalProperties: false`, so without this an author's `files:` is a hard
  `telo check` / editor / `kernel.load` diagnostic. The analyzer never reads the
  assets — it only needs to accept the field.
- **Runtime**: zero controller change. `Http.Static` already resolves `root`
  against `moduleContext.source`
  ([http-static-controller.ts:99-106](../../modules/http-server/nodejs/src/http-static-controller.ts#L99-L106)),
  so once step 6 extracts the tarball into `.telo/manifests/<ns>/<name>/<ver>/`,
  `root: ./public` resolves to the extracted `public/` exactly as in dev.
- **Manifest-only consumers unaffected** — the analyzer/editor/MCP
  `get_module_manifest` never read `files:` assets; they keep fetching
  `telo.yaml`. `files:` only widens the tarball and the fetch trigger (below).

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
   `telo.yaml` + every `pkg:telo` `path` file + every `files:`-globbed asset
   (see [Static assets](#static-assets--arbitrary-bundled-files-files), each at
   its relative path). **Do not reuse `apps/k8s-runner/src/tar.ts`** — it is the
   *runner's* bundle writer, coupled to `@telorun/runner-core`'s `RunBundle` and
   unrelated to publishing. The CLI gets its own writer: add `tar-stream`
   (already a repo dep, used by `modules/tar/nodejs`) to `cli/nodejs` and write a
   small `cli/nodejs/src/bundle/tar.ts` helper (`tar-stream` pack →
   `node:zlib` gzip). No Telo kind — this is plain Node code on the publish path.
5. **PUT** the `.tar.gz` to `…/module.tar.gz` with `content-type:
   application/gzip`. A module with **no** `pkg:telo` controllers **and no**
   `files:` keeps the current `text/yaml` PUT to `…/telo.yaml` — the tar.gz path
   is taken only when there is something beyond the manifest to ship.

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

- For a module that ships a tarball (any `pkg:telo` controller **or** a `files:`
  set), download `module.tar.gz` and **extract** into that dir, so both
  `path: ./nodejs/script.mjs` and `root: ./public` resolve next to the cached
  `telo.yaml` — the identical relative resolution the author uses in dev. The
  extracted asset tree is what makes `Http.Static` work post-install.
- **Fetch trigger** — the consumer must know whether a registry ref has a
  tarball before choosing the URL. The manifest (always fetchable at
  `…/telo.yaml`) carries the answer: if it declares `files:` or any `pkg:telo`
  controller, fetch + extract `…/module.tar.gz`; otherwise the plain
  `telo.yaml` is the whole module.
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

## Editor remote-open (`?open=<url>`) — `files:` over raw HTTP

The editor opens a manifest from a raw URL (e.g.
`raw.githubusercontent.com/.../telo.yaml`) and resolves relative imports as
sibling raw URLs. There is **no directory listing** over raw HTTP, so a glob
pattern in `files:` cannot be expanded — the editor has no filesystem to glob
and no host-agnostic way to enumerate `public/`.

Resolution: the editor reads `files:` and **fetches only the literal entries**
(no glob metacharacters), each as a sibling raw URL through its existing
relative-fetch path. For any **glob entry** (contains `* ? [ ] { }` or a leading
`!`), it cannot enumerate the matches, so it **skips it and surfaces a
warning** — e.g. "`files: public/**` can't be previewed over a remote URL;
list the files explicitly to make them editable here." No host-specific
directory API, no in-browser glob engine.

- Detection is purely lexical: an entry with none of `* ? [ ] { }` and no
  leading `!` is a literal path → fetch; otherwise → warn + skip.
- This makes literal `files:` entries first-class in the remote-open view and
  globs a publish-time-only convenience. An author who wants an example fully
  editable over a raw URL lists the asset paths explicitly; one who only cares
  about publishing keeps the glob and accepts the editor warning.
- Purely an editor concern — no registry, kernel, or publish change. The glob
  still drives publish-time tarball selection unchanged.

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
5. 🟡 **CLI publish bundle path** — the **`files:` static-asset slice is done**:
   `files:` selection (shared `ignore`-based matcher in
   `cli/nodejs/src/bundle/select-files.ts`, replacing `minimatch` for both
   `include:` and `files:`; always-on default-ignore set), `tar-stream` writer
   (`cli/nodejs/src/bundle/tar.ts`, **not** k8s-runner's), and the
   `module.tar.gz` PUT branch in `publish.ts`. The `files:` schema lives in
   `analyzer/nodejs/src/builtins.ts` only (Application + Library) — the kernel
   has no Application/Library schema; it validates via `StaticAnalyzer`.
   **Deferred (esbuild / `pkg:telo` controller bundling):** SDK-bundled esbuild
   build + non-bundleable refusal. No current consumer needs it — `todo-app`
   has no `pkg:telo` controllers — so it was cut from this slice.
6. ✅ **Consumer cache extraction** of `module.tar.gz` into `.telo/manifests`
   (`cli/nodejs/src/bundle/extract.ts`, wired into `telo install` + `telo run`
   after `writeManifestCache`), with the manifest-driven fetch trigger (a module
   whose `telo.yaml` declares `files:` ⇒ fetch + extract the tarball).
7. ⬜ **Editor run-bundle** `.js` collection + relative-import crawl (dev loop;
   parallelizable with 5–6 once 1–2 landed). Part of the deferred controller
   slice.
8. ✅ **Editor remote-open `files:`** — `collectRemoteFiles` in
   `apps/telo-editor/src/loader/remote.ts` fetches literal `files:` entries as
   sibling raw URLs and warns + skips glob entries (surfaced in the import
   preview dialog).

Steps 1–2 (run track) and 4 (registry) were already done. The **`files:`
static-asset slice (5-files, 6, 8) is now implemented**, with CLI unit tests
(`cli/nodejs/tests/bundle.test.ts`) and a CLI-driven e2e round-trip
(`apps/registry/tests/e2e-bundle.ts`, `pnpm run test:e2e:bundle`). The esbuild
controller-bundling half of step 5 and the editor run-bundle (step 7) remain
deferred — no current consumer needs them.

## Testing

- Kernel: bundle load + realm identity; fallback ordering; env-missing recovery.
- CLI: publish dry-run; bundle emitted; non-bundleable dep rejected;
  `files:` selection collected — positive match, `!` negation (last-match-wins),
  default-ignore set never shipped, and a pattern escaping the module root
  rejected; `include:` still resolves the same set after the `minimatch`→`ignore`
  swap; tar.gz round-trips and extracts to the right paths.
- End-to-end: publish `examples/todo-app` (Http.Api + Http.Static `./public`)
  to a local registry, install into a clean cache, run — the SPA serves from the
  extracted `public/` and the API responds. This is the motivating case.
- Prerequisite kinds (gzip/tar/http-server/s3) — tested in their own plan.
- Registry: PUT a tar.gz → GET `telo.yaml` and `module.tar.gz`; manifest indexed.
- Editor: run-bundle includes the `.js` and its relative siblings; docker runner
  executes a `pkg:telo` controller with no install.

## Open items to confirm during implementation

- Exact `REALM_COLLAPSE_NAMES` set the resolve hook must cover (read from the
  npm loader's current list; keep the two in sync via a shared constant).
- Whether the run-bundle relative-import crawl should hard-error on a bare
  third-party import (recommended) or silently drop it.
