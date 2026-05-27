# Manifest install cache

Persist every imported manifest's YAML text to `<entry-dir>/.telo/manifests/` at
install time so kernel boot does zero network I/O. Mirrors the existing
`.telo/npm/` pattern for controllers.

## Problem

`telo install` walks the import graph via [`loader.loadGraph(entryPath)`](../../../cli/nodejs/src/commands/install.ts#L58)
and so already fetches every transitively-imported manifest from the registry.
But the fetched text only lives in [`Loader.fileCache`](../../../analyzer/nodejs/src/manifest-loader.ts#L34),
an in-memory `Map` that dies with the process. Only the npm controller packages
get persisted (to `<entry-dir>/.telo/npm/`).

At runtime, `Kernel.load()` calls `loadGraph` again, so every `Telo.Import` with
a registry source (e.g. `std/type@0.1.0`) hits
[`RegistrySource.read`](../../../analyzer/nodejs/src/sources/registry-source.ts#L19)
and `fetch()`es against `registry.telo.run`. Two consequences:

1. **Self-bootstrapping registry**: `apps/registry/telo.yaml` imports from the
   registry it itself serves. Cold-start with no other replica → boot fails.
2. **Hermetic deploys**: any production image deployed into an air-gapped
   network, behind a strict egress allowlist, or during a registry outage
   fails to start even though `telo install` had every manifest in hand at
   build time.

## Solution

A new `LocalManifestCacheSource` registered ahead of `RegistrySource` /
`HttpSource` in the source chain. `telo install` writes the on-disk cache after
its existing `loadGraph` pass; boot reads from disk and never touches the
network. The Docker `COPY --from=build /srv /srv` line already in
[`apps/registry/Dockerfile`](../../../apps/registry/Dockerfile) carries the
cache into the production stage with zero further changes.

## Layout

Cache root: `<entry-dir>/.telo/manifests/`. Same `<entry-dir>` anchor as
`.telo/npm/` — captured by the CLI from the entry manifest path, persisted on
`Kernel._entryUrl`, surfaced as the install root in [`controller-loader.ts`](../src/controller-loader.ts).

Two subtrees, one per source scheme:

- **Registry refs** (`std/type@0.1.0`):
  `<entry-dir>/.telo/manifests/<namespace>/<name>/<version>/telo.yaml`
- **HTTP imports** (`https://example.com/path/telo.yaml`):
  `<entry-dir>/.telo/manifests/__http/<host>/<pathname>` (literal `__http`
  segment to avoid colliding with a hypothetical `http` namespace; pathname
  preserved verbatim with `?` / `#` stripped — query/fragment do not affect
  identity for our purposes since the registry is content-addressed by path).

Registry layout mirrors the URL the registry itself serves, which makes the
cache self-explanatory on disk and parallels `.telo/npm/<namespace>/<name>/...`
naming. The `__http/...` subtree gives transitive HTTP imports the same
benefit; partials reached via `include:` from an HTTP-loaded owner land
alongside the owner without special-casing.

Partials (files reached via `include:`) are stored relative to their owner
under the same versioned dir. The owner's `include:` paths are file-relative,
so writing each partial at `<owner-dir>/<relative-path>` preserves them as-is.

## New source: `LocalManifestCacheSource`

Lives at [`kernel/nodejs/src/manifest-sources/local-manifest-cache-source.ts`](../src/manifest-sources/).
Belongs to the kernel package (uses `fs/promises`); the analyzer must stay
browser-compatible.

```ts
export class LocalManifestCacheSource implements ManifestSource {
  constructor(private readonly entryDir: string) {}

  supports(url: string): boolean {
    return this.tryMap(url) !== null;
  }

  async read(url: string): Promise<{ text: string; source: string }> {
    const mapped = this.tryMap(url);
    if (!mapped) throw new Error(`unsupported: ${url}`);
    const text = await fs.readFile(mapped, "utf-8");
    return { text, source: pathToFileURL(mapped).href };
  }

  resolveRelative(base: string, relative: string): string {
    // Once a file is served from the cache its `source` is a `file://` URL,
    // so transitive `include:` / relative imports resolve through
    // LocalFileSource on the next hop. No work needed here beyond a stub that
    // delegates back to file-URL semantics for the case where another caller
    // happens to invoke us with a cached base.
    const baseDir = base.endsWith("/") ? base : base.slice(0, base.lastIndexOf("/") + 1);
    return new URL(relative, baseDir).href;
  }

  private tryMap(url: string): string | null {
    // 1. Registry ref: namespace/name@version (mirrors RegistrySource.supports)
    if (
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("/") &&
      !url.startsWith(".") &&
      url.includes("@") &&
      url.includes("/")
    ) {
      const atIdx = url.lastIndexOf("@");
      const modulePath = url.slice(0, atIdx);
      const version = url.slice(atIdx + 1).replace(/^v/, "");
      const candidate = path.join(
        this.entryDir, ".telo/manifests", modulePath, version, "telo.yaml",
      );
      return existsSync(candidate) ? candidate : null;
    }
    // 2. HTTP(S) import
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const u = new URL(url);
      const pathname = u.pathname.endsWith(".yaml") ? u.pathname : `${u.pathname}/telo.yaml`;
      const candidate = path.join(this.entryDir, ".telo/manifests/__http", u.host, pathname);
      return existsSync(candidate) ? candidate : null;
    }
    return null;
  }
}
```

`supports()` uses `existsSync` so a miss falls through to the next source in
the chain — `RegistrySource` / `HttpSource` then handle a fresh fetch (dev,
ad-hoc runs without `telo install`, or new imports added after install). This
keeps the cache transparent: present → hermetic, absent → unchanged.

Sync `existsSync` is acceptable here because `supports()` is called once per
dispatch per file and the chain is tiny. The async alternative requires a
breaking signature change on `ManifestSource.supports` that propagates through
every implementation and call site for no measurable benefit.

Exported from [`kernel/nodejs/src/index.ts`](../src/index.ts) alongside
`LocalFileSource` / `MemorySource`.

## Kernel wiring

The cache source has to be registered before `loadGraph` runs, which means
before `Kernel.load()` resolves the entry URL through the source chain — but
the cache root *is* the entry dir, so it's a chicken-and-egg only if the
entry URL itself is a registry ref. In practice entry manifests are always
local files (or HTTP for the `telo <url>` shorthand), and the source-chain
fallback handles those entries unchanged. The cache is only consulted for
imports.

Resolution order:

1. CLI knows the entry manifest path → derives `entryDir` synchronously.
2. CLI constructs `Kernel` with `sources: [new LocalFileSource(), new
   LocalManifestCacheSource(entryDir)]`. Last-wins, so the cache source ends
   up at the top of the chain (it's `unshift`ed in `Loader.register`).
3. `Kernel.load(entryPath)` proceeds. `LocalFileSource` claims the entry file
   (cache source doesn't `supports()` local paths anyway). For each
   `Telo.Import`, `LocalManifestCacheSource.supports()` checks the disk →
   hits go through `fs.readFile`, misses fall through to
   `RegistrySource` / `HttpSource`.

The CLI is the single registration point. `Kernel` does not auto-register the
cache source: programmatic callers (tests, the editor, the docker-runner) get
to opt in explicitly so an unexpected `.telo/manifests/` dir in their cwd
never silently shadows live registry data.

Files touched:

- [`cli/nodejs/src/commands/run.ts`](../../../cli/nodejs/src/commands/run.ts#L123) — add the cache source to the `sources` array, anchored to `path.dirname(path.resolve(argv.path))`.
- [`cli/nodejs/src/commands/install.ts`](../../../cli/nodejs/src/commands/install.ts#L55) — same wiring on the `new Loader([...])` line so the install pass *itself* prefers the cache when it's already populated (idempotent re-installs and partial re-installs benefit).

## Install-time write

In [`installOne`](../../../cli/nodejs/src/commands/install.ts#L50), after the
existing `loader.loadGraph(entryPath)` succeeds and before the controller pass:

1. Compute `entryDir = path.dirname(fileURLToPath(graph.rootSource))` (entry
   is always a local file at install — `installOne` already guards URLs).
2. For every `[canonicalSource, module]` in `graph.modules`:
   - Skip if `canonicalSource === graph.rootSource` (the entry manifest is
     already on disk where it belongs).
   - Map `canonicalSource` to its cache path:
     - The canonical source is whatever the originating `ManifestSource.read()`
       returned. `RegistrySource` returns the *resolved* URL (the registry
       HTTP URL), not the original `std/type@0.1.0` ref — so the cache path
       has to be derived from the registry URL structure
       (`<registryUrl>/<modulePath>/<version>/telo.yaml`) rather than from the
       import ref. Strip the registry URL prefix and reuse the trailing path
       segments verbatim.
     - HTTP-source canonical URLs are file URLs of the fetched resource —
       extract host + pathname, prepend `__http/`.
     - File-URL canonical sources (transitive `include:` from a cached owner,
       or local-file imports) are skipped — they belong to whatever owner
       directory already holds them on disk.
   - Write `module.owner.text` to that path.
   - For each `partial` in `module.partials`, derive its path relative to the
     owner (already in `partial.source` as the canonical URL the owner's
     `resolveRelative` produced) and write `partial.text` next to the owner.
3. Use `fs.mkdir(..., { recursive: true })` + `fs.writeFile` atomically per
   file. Cache writes are append-only from the install's perspective; we do
   not delete stale entries (install is meant to be additive across pinned
   versions; users who want a fresh cache delete `.telo/manifests/` by hand,
   matching the `.telo/npm/` convention).

Helper: `writeManifestCache(entryDir, graph, registryUrl)` lives next to
`LocalManifestCacheSource` (kernel package) so the URL→path mapping has one
home shared by reader and writer. Exported from
[`kernel/nodejs/src/index.ts`](../src/index.ts).

## What this does not do

- **No lockfile.** Pinned versions in the manifest already serve as the
  lock; the cache simply makes those pins offline-resolvable. A separate
  lockfile is a separate problem (transitive version selection, integrity
  hashes); add later if needed.
- **No integrity hashes.** `.telo/manifests/` is a local cache anchored to
  the entry dir, not a redistributable artifact format. Trust boundary is
  the install step, same as `.telo/npm/`.
- **No editor / IDE wiring.** The analyzer keeps using its own `Loader`
  with `RegistrySource` enabled — editors expect live registry data, not a
  build-time snapshot. If we ever want offline editor support we'd register
  the cache source there too, but that's out of scope here.
- **No cache eviction.** Manual deletion only.

## Test plan

New tests under `cli/nodejs/tests/`:

1. `install-manifest-cache.test.ts` — given a fixture manifest that imports
   one std module, run `installOne`, assert
   `<entry-dir>/.telo/manifests/std/<name>/<version>/telo.yaml` exists and
   matches the manifest served by the test registry.
2. `boot-from-manifest-cache.test.ts` — populate the cache from fixture
   bytes, point `registryUrl` at a sink that always 500s, assert
   `Kernel.load(entry)` succeeds and the imported kinds are registered.
   Proves the cache short-circuits the network.
3. `cache-miss-falls-through.test.ts` — entry imports `std/foo@1.0.0` which
   is NOT in the cache, registry returns the manifest, assert load succeeds.
   Proves the cache is transparent on miss.
4. HTTP-import variant of (1): import `https://example.invalid/lib/telo.yaml`
   from a fixture HTTP source, assert it lands under
   `<entry-dir>/.telo/manifests/__http/example.invalid/lib/telo.yaml`.

Existing tests:

- `apps/registry/telo.yaml` boot test (whatever currently covers it) — add a
  pass with `TELO_REGISTRY_URL=http://127.0.0.1:1/` (unreachable) after
  `telo install`, assert boot succeeds. This is the regression target.

## Documentation

- Update [`cli/README.md`](../../../cli/README.md#L125) (the section that
  documents `<entry-manifest-dir>/.telo/npm/`) to also describe
  `.telo/manifests/` and the offline-boot guarantee.
- Module docs unaffected — this is a CLI + kernel-internal feature.

## Changesets

Two changeset entries (one logical change, two affected packages):

- `@telorun/kernel`: minor — adds `LocalManifestCacheSource` export and
  `writeManifestCache` helper.
- `@telorun/cli`: minor — `telo install` now writes `<entry-dir>/.telo/manifests/`;
  `telo run` registers the cache source so production images can boot without
  registry network I/O.
