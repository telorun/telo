---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Add `ctx.runtime` — the host's own manifest machinery, exposed to controllers as a versioned SDK contract.

`ctx.runtime.run(source, { env })` loads and starts a child manifest isolated from the caller's, resolving as soon as it has **started** with `{ stdout, stderr, exitCode, cancel }`: the two streams are `Stream<string>`, `exitCode` settles at completion, and `cancel()` stops the child and resolves once it has torn down. `ctx.runtime.check(source, { desugarImports })` runs the static-analysis pass and resolves to plain-data diagnostics plus a `loadError`.

This exists so a module that needs either — `test` runs child manifests, `assert`'s `Manifest` kind analyzes one — stops importing `@telorun/kernel` / `@telorun/analyzer`. Importing them made kernel internals an unversioned ABI between a published artifact and whatever kernel loaded it, with a mismatch surfacing as a `TypeError` inside a controller. Every shape crossing the seam is serializable data or a `Stream`, so a kernel in any language can implement it, and isolation stays the kernel's choice (an in-process child kernel today, a subprocess later).

Output is a stream rather than captured text because forwarding it live and retaining it to print on failure are both the caller's to choose, and a value produced at the end forecloses one of them. A stream does not by itself bound the host's memory — an unread one still accumulates — which is why `cancel()` is on the contract from the start rather than added later: it is both the way to stop an open-ended sub-manifest and the only real bound on its output.

`RecordBuffer` — the bounded sink buffer of logging spec §10.3 — moves from `@telorun/kernel` to `@telorun/sdk`, beside the sink contract it composes with. A third-party sink is an ordinary module, so the piece it needs to honour `on_full` belongs on the module-author surface. The kernel re-exports it through `logging/log-sink.ts`, so its own sinks keep one spelling.

The bundled-controller loader learns a `local_path` qualifier naming the TypeScript source `path=` was built from. When the declaring module carries **no artifact handle**, that source resolves on disk, and esbuild is available, the kernel builds it and imports the result — so a checkout runs with no build step, and editing a controller and re-running picks the edit up. The guard is the absence of an artifact rather than the shape of the base URI: a published module served from the on-disk manifest cache also has a local base, and its payload is still its layer.

esbuild is checked at resolve time, so an install that skipped optional dependencies selects the prebuilt `path=` file instead of failing — the fallback belongs to this same PURL, and a candidate list could not supply it. A build *failure* still surfaces; only a missing bundler falls back.

Workspace TS libraries are inlined from their `source` export condition rather than their `dist/`, so building a controller does not depend on having built every library it inlines. Builds are cached under `<entry-dir>/.telo/controller-src/`, keyed on a signature over every input esbuild reported plus the build options, so a changed input is a different key rather than something to invalidate, and concurrent kernel processes write identical bytes to identical paths. Each build prunes the bundle it replaced. `telo run --watch` takes its watch set from that same input list, so an edit to a shared library one directory over restarts the run.
