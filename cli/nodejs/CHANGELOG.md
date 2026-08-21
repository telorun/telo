# @telorun/cli

## 0.80.0

### Minor Changes

- b66a3bb: Anchor the `.telo` cache at `telo-workspace.yaml`, so one repo has one cache.

  Every entry manifest used to get its own `.telo` beside it — 123 directories and
  1.6 GB in this repo, overwhelmingly duplicated npm install trees, plus a
  controller-bundle rebuild once per test because the test runner loads each test as
  a child kernel that resolved its own root. Precedence is now `TELO_CACHE_DIR` >
  the directory holding the marker > `<entry-dir>/.telo`, and only the marker's
  LOCATION is read, never its `modules:` list. With no marker anywhere above an
  entry the behaviour is exactly what it was, so the file enables the shared cache
  rather than gating one.

  The layout gains `analysis/` and `validators/` beside `manifests/` rather than
  inside it — neither is a cached manifest — and the analysis stamp becomes one file
  per entry. A single stamp file was per-app only because each app had its own
  cache; shared, every app would overwrite the last, which is a permanent 100% miss
  that reports nothing and only makes boots slower.

  **Upgrading:** a warm cache goes cold. That costs only CPU for validators, bundles
  and the npm tree, but manifests cost network, so both halves of a module are read
  from the old `<entry-dir>/.telo/` on a miss — the manifest itself and the layers
  that extract beside it — and a module already installed there boots offline
  without a fetch. The npm tree cannot be covered that way, since a `node_modules`
  tree is used whole or not at all: an offline upgrade of a module delivered through
  npm needs one `telo install` against the new root. Baked images are unaffected —
  `TELO_CACHE_DIR` still outranks the marker.

  Both cargo loaders now build controller crates under `<cache>/cargo/<backend>/`,
  keyed by SDK backend, so alternating between the Node kernel, `telo-rs` and a
  plain `cargo build --workspace` no longer rebuilds the crate and its dependency
  tree each time.

### Patch Changes

- Updated dependencies [b66a3bb]
- Updated dependencies [d267c7f]
- Updated dependencies [839fb45]
  - @telorun/kernel@0.80.0
  - @telorun/sdk@0.80.0
  - @telorun/analyzer@0.64.0
  - @telorun/ide-support@0.16.0
  - @telorun/templating@0.16.0

## 0.79.0

### Minor Changes

- 0910053: `telo run` now collects `.env` / `.env.local` from every directory between the manifest and the workspace root, instead of the manifest's own directory alone. `telo-workspace.yaml` is the bound — only its location, never its `modules:` list — so a monorepo keeps shared development values in one file at the root. With no marker above the manifest the behaviour is unchanged. The nearest declaration wins, `.env.local` beats `.env`, and the real environment still beats every file; `--debug` prints which files were loaded, and a file that exists but cannot be read is always reported rather than treated as absent.
- 18a5d61: An unusable import is reported as itself, and an upgrade only offers a version this telo can run.

  **One shape for every unusable import.** Loading no longer distinguishes _how_ an
  import is broken. Unreachable, malformed, resolving to an application, resolving
  to something that is not a library, resolving to a library that names no module —
  each records a failure against that import, registers no dependency edge, and
  lets the rest of the graph load. The check now runs per import declaration rather
  than once per distinct target, which closes the case where an import pointing at a
  module something else already reached (the entry application above all) skipped it
  entirely. An application target used to abort the whole load; it is now a
  diagnostic on its own line, and still fatal at run time because the runtime
  refuses to start on any of these.

  Three codes, because three different people fix them: `INVALID_IMPORT_SOURCE`
  (not a module reference), `IMPORT_UNRESOLVED` (well-formed but not obtainable) and
  the new `INVALID_IMPORT_TARGET` (obtained, but not importable).

  **No guessing about module identity.** The analyzer used to derive a module name
  from an import's source string whenever the loader had stamped none. For a pinned
  ref that produced a canonical kind no registry can hold —
  `http-dispatch@0.11.1#sha256-….Outcomes` — and every consumer of the alias then
  failed in its own vocabulary, reporting a _dependency_ as schemaless when the real
  fact was that the import never resolved. The fallback is gone: an import with no
  resolved identity registers no alias, and uses of it say `cannot resolve alias
'<X>'`, which names the import the author can fix.

  **Upgrade affordances filter by `requires.telo`.** `manifestCompatibility` moves
  the verdict (`yes` / `too-new` / `unreadable` / `unknown`) into the analyzer, where
  the `requires:` grammar already has its single reader; `telo upgrade` now calls it
  rather than carrying its own copy. `@telorun/ide-support` gains the selection rule
  on top — walk candidates newest-first, stop at the first hostable one, report what
  was held back and why — so the editor's Imports view and the VS Code lenses answer
  "which version does this move to" identically. `buildImportUpgrades` takes an
  environment (`listVersions` + `isCompatible`) instead of a bare lookup, so a host
  cannot silently skip the check; one that genuinely cannot read candidate manifests
  passes `uncheckedVersionCompatibility`, which says so. A version that cannot be
  read or reached is never treated as incompatible, and only the telo axis is checked
  in an IDE — an IDE is not the host that will run the manifest.

- b5dc9d5: `telo install` now resolves sibling module libraries, so a bundled controller that
  imports another module's `exports.code:` entry point (`@telorun/ai`,
  `@telorun/cache`, …) installs instead of failing with "Cannot find package". The
  join `kernel.load()` performs is exported as `buildSiblingLibraries` and computed
  by the install warm pass, which already holds all three inputs.
- 7463386: A DECLARATION-derived contract (`x-telo-schema-projection-from`) is now resolved
  at dispatch as well as at `telo check`. It was static-only, which is a contract
  with a hole exactly where a value is COMPUTED rather than written: a misspelled
  column written as a literal was rejected, and the identical key arriving from a
  CEL expression reached the database — which for a repository kind means arbitrary
  caller text in a SQL identifier position.

  `ProjectionScope` becomes a resolver over the raw slot value rather than a list of
  manifests, because the two hosts see different things there: the analyzer sees the
  `{kind, name, alias?}` reference, while the kernel binds contracts after Phase-5
  injection has replaced it with the live instance. That also makes reference
  resolution alias-aware, so an unambiguous `!ref Alias.users` is no longer refused
  as ambiguous merely because two libraries each export a `users`.

  `x-telo-schema-projection` is read from `schema:` as well as from the kind
  document and reported when it is found there — ignoring a misplaced annotation
  moved the failure onto the consumer's slot and blamed the wrong author.

  A ref slot inside a kind's `schema:` is typed as the published reading it yields,
  so `self.<ref>.status.<field>` is checked instead of being read off the annotation
  node. The runtime view is memoized against a publication counter rather than
  rebuilt on every dispatch.

  A resource rule that throws or exhausts its budget is anchored on the declaring
  definition, and is a warning rather than an error when that definition belongs to
  a published dependency — an error there blocked `telo check` on a line the
  consumer could not change.

  A projection that cannot resolve at dispatch now raises
  `ERR_SCHEMA_PROJECTION_UNRESOLVED` instead of leaving the slot open — the
  analyzer's report is entry-module-scoped, so a dependency's consumer slot was
  unreported at both ends. Rule-declaration validation reads the same merged schema
  the evaluation reads, so a rule declared on an abstract resolves its `in:` pointer
  against the fields a child declares.

  `telo publish` reads the npm controller candidates it may push from the PURL
  parser it already uses, and the self-pin rewrite is anchored on the `controllers:`
  scalars, so a PURL mentioned in a description is no longer a rewrite target. Its
  package directory comes from the candidate's `local_path` rather than an assumed
  layout, an unreachable npm registry is no longer read as "not published", and a
  malformed `package.json` fails instead of silently skipping the pin stamp.

- 9ac2b8a: The step grammar becomes shared vocabulary, and its execution moves to the SDK.

  `$ref: "telo://manifest#/$defs/Step"` on an array's items declares a step body —
  `invoke` / `value` / `if` / `while` / `switch` / `try` / `throw`, the
  `steps.<name>.result` accumulator and the `error` variable inside a `catch:`. Any
  kind can carry one now; a composite kind that wraps a region of work no longer
  needs a `!ref` to an executable and a second document to hold it. The grammar was
  declared four times inside `modules/run/telo.yaml`, and `$defs` are local to the
  schema that declares them, so four kinds in one module could not share one.

  `StepEngine` moves from `modules/run` to `@telorun/sdk` beside the
  `executeInvokeStep` leaf it already delegated to, against a structural context
  (`StepEngineContext`) so it depends on neither the kernel nor `run`. The SDK is
  the one name the bundle loader symlinks onto the kernel's own copy, so the engine
  is one version per process and reachable from a controller bundle and the
  kernel's boot runner alike.

  Two consequences for a kind author. `while/do` is admitted in every step body —
  a fragment cannot be narrowed by its consumer, and the copies that dropped it did
  so editorially rather than for soundness. And `x-telo-step-context` is now the
  legacy spelling: it is read forever (published artifacts carry it, and no
  migration entry can synthesize a `$ref`) but a new step body is declared by
  pointing at the fragment, which the derived `x-telo-fragment: Step` stamp makes
  recognizable with no marker to remember.

  A forward-declared `requires.telo` lower bound is now its own verification state.
  Adopting new syntax means declaring the release that will carry it, so on that
  commit the edge names a version npm does not have — and spawning
  `npx @telorun/cli@<unpublished>` there produced an `ETARGET` wrapped in install
  noise, reported as "could not run", indistinguishable from being offline. The
  registry is now asked before any edge runs, such an edge is never spawned, and it
  is reported as `pending` alongside the latest published version (which is what
  makes a typo'd bound visible). Informational in `telo release check`, fatal in
  `telo publish`, where npm has already published and the floor must exist.

### Patch Changes

- b5dc9d5: Controller progress now reports the wait itself instead of guessing around it.

  A new `ControllerWorkStarted` event is emitted by the sub-loader that is about to install, compile or fetch — past every cache check and re-check, at the point the package manager, `cargo`, esbuild or a layer transfer actually runs. It is the only in-progress signal, and a warm start enters no such branch, so nothing is emitted and nothing has to be taken back. `ControllerLoading` now carries the resolve `source`, and `ControllerLoaded`'s `durationMs` measures from the first work branch entered (falling back to the import call), so a 40-second install is no longer reported as `(npm-install, 12ms)`. `ControllerLoader.resolve()` emits work and candidate-fallthrough events; `load()` is now that resolve plus the import half.

  The CLI's `⬇` line is opened by the work event and closed in place by `Loaded`/`Failed`, so it is on screen for the whole of a real wait and never printed at all for a `cache`/`local` hit — replacing the speculative line that was printed and then erased.

- Updated dependencies [b5dc9d5]
- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [321f153]
- Updated dependencies [321f153]
- Updated dependencies [b5dc9d5]
- Updated dependencies [18a5d61]
- Updated dependencies [b5dc9d5]
- Updated dependencies [7463386]
- Updated dependencies [c7fdbd9]
- Updated dependencies [7463386]
- Updated dependencies [321f153]
- Updated dependencies [9ac2b8a]
- Updated dependencies [321f153]
  - @telorun/kernel@0.79.0
  - @telorun/sdk@0.79.0
  - @telorun/analyzer@0.63.0
  - @telorun/ide-support@0.15.0
  - @telorun/templating@0.16.0

## 0.78.0

### Minor Changes

- afb2b05: Publish the manifest the payload builder produced.

  The `layers:` index was injected into `telo.yaml` during the push, after the
  builder had already returned the manifest — so for every module shipping a
  payload layer, the text a dependent hashed to derive its import pin was a
  document no registry holds. 18 standard-library modules carried a pin that
  could not resolve, and their consumers failed at load with an integrity error
  naming a republish that never happened.

  `ModulePayloadBuilder` now writes the index, so `publishedManifest()` returns
  the shipping bytes. That requires layer framing to be a pure function of the
  files it covers: `makeTarGz` pins every tar header field that is not the name
  or the contents, which also makes artifacts reproducible. The index itself
  comes from the transport (`Transport.layerIndex`), which owns that framing, and
  publish now verifies each pushed blob against what the manifest already claims
  rather than rewriting it.

  Modules shipping a payload must republish — the wrong pins are in artifacts
  that cannot be edited.

### Patch Changes

- Updated dependencies [afb2b05]
  - @telorun/kernel@0.78.0
  - @telorun/analyzer@0.62.1
  - @telorun/ide-support@0.14.1

## 0.77.0

### Minor Changes

- d08c3bd: Add declared runtime requirements: a module states, in a top-level `requires:` block,
  the range of Telo it is verified against.

  Telo closes every extension vocabulary and rejects an unknown token, which is right for
  a typo and wrong for a version — so a module adopting new syntax broke on older runtimes
  with a message blaming its own author. A declared range turns that into one accurate
  diagnostic (`MODULE_REQUIRES_NEWER_RUNTIME`), and stops `telo upgrade` selecting versions
  the running Telo cannot read at all.

  `telo:` is a semver range over the manifest surface generation — one scale every kernel
  reports, so there is no range per kernel — and host requirements nest under `host:`, where
  `node` is the only axis for now, since an axis is added when something compares it and not
  before. `^` and `~` are rejected: pre-1.0 they allow only one minor, and Telo
  ships breaking changes as minor bumps, so they would pin a module to a single release
  generation. An upper bound must name a version that already exists.

  The claim is verified by running the CLI at each edge of the declared range, in
  `telo publish`'s preflight and across the workspace in `telo release check`. A module
  declaring nothing carries no requirement.

### Patch Changes

- Updated dependencies [17584a7]
- Updated dependencies [17584a7]
- Updated dependencies [987decd]
- Updated dependencies [d08c3bd]
  - @telorun/analyzer@0.62.0
  - @telorun/ide-support@0.14.0
  - @telorun/kernel@0.77.0
  - @telorun/sdk@0.77.0
  - @telorun/templating@0.16.0

## 0.76.0

### Minor Changes

- f4efb4b: A module-owned library is resolved at load through the import graph instead of
  being copied into every dependent's controller bundle, and a module builds one
  bundle rather than one per kind.

  Both halves fix the same defect: a bundle is a module graph, so a shared source
  file compiled into two bundles is two module scopes, and any state a module keeps
  beside its instances — a registry, a `WeakMap`, a counter — silently becomes two
  of them. `sql` had six controller bundles and therefore six copies of its
  connection registry.

  - A module's kinds now select their controllers out of its single bundle with the
    PURL fragment (`…&local_path=./nodejs/src/index.ts#SqlQueryController`).
  - A `Telo.Library` may declare `exports.code:` — entries naming the bare
    specifier dependents import it by and the file that resolves to
    (`{ specifier, format, path, source }`, plus `os` / `arch` / `libc` for a
    native entry). The kernel joins that to the consumer's `imports:` during
    `load()` and resolves the import to that module's own entry point.
  - The artifact spec gains a `library` layer role, per selector, carrying that
    entry point; a file claimed as both a controller and a library entry ships in
    the library layer, and materializing either code role pulls both plus `common`.
  - Three build-time guards keep the property from decaying: importing a subpath of
    a declared specifier, reaching a declared library's entry-source directory by
    any other route, and inlining a module-owned library the manifest never
    declared an import for — each a hard build error rather than a silent extra
    copy. The last is the one that matters most: the other two are derived from the
    `imports:` edges, so they are vacuous exactly where the mistake is made.
  - An unknown layer role in a published index is now skipped rather than rejected,
    so a module that gains a layer for a newer runtime does not become unreadable
    on an older one.

  Deduplication is per (module, resolved version): two dependents pinning different
  versions of one library still resolve two copies — that is different code — and
  the kernel warns rather than pretending otherwise.

### Patch Changes

- b8be55b: Two places converted a `file://` URL to a filesystem path by hand rather than
  through `fileURLToPath`, and both failed on Windows.

  The napi controller loader sliced the seven-character `file://` prefix off the
  declaring manifest's URL. A file URL's path is not a filesystem path: on Windows
  `file:///D:/a/telo/telo.yaml` sliced that way leaves `/D:/a/telo/telo.yaml`, whose
  leading slash makes `path.resolve` graft the current drive on and produce
  `D:\D:\a\telo\…`, so every `pkg:cargo` controller resolved to a crate directory
  that does not exist. It also left percent-escapes undecoded on every platform, so
  a manifest under a directory with a space resolved to a path that is not there.

  The CLI's diagnostic formatter called `fileURLToPath` unguarded when shortening a
  manifest source for display. That function throws rather than returning null, and
  on Windows it throws for any file URL without a drive letter — so
  `file:///app/telo.yaml`, perfectly ordinary from a Linux-authored manifest or a
  container path, replaced the diagnostic being reported with an
  `ERR_INVALID_FILE_URL_PATH` from the code reporting it. A `file://` URL that names
  no path on this host now renders as the URL, which is what the `http(s)://` branch
  beside it already did.

- b8be55b: The controller installer spawns its package manager through a shell on Windows.
  There is no executable named `npm` there — npm, pnpm and every corepack shim are
  `.cmd` files, which libuv's PATH search (`.com`/`.exe` only) never finds and
  which Node has refused to spawn without a shell since CVE-2024-27980. Every
  `pkg:npm` controller was therefore unloadable on Windows, and the failure was
  reported as `'npm' not found on PATH … Install Node.js`, which told a user with
  npm already installed to install the thing they had.

  Going through `cmd.exe` moves the quoting obligation to the caller: Node builds
  `cmd.exe /d /s /c "<file> <args joined by spaces>"` and quotes nothing, so the
  installer quotes each argument itself. Both hazards are live in the arguments it
  actually passes — a space in a `file:` install spec would re-split into two
  arguments, and `^` in a semver range is cmd's escape character and is eaten
  outside quotes. A literal `"` is rejected rather than escaped, since the escape
  that restores cmd's quote state differs from the batch shim's own parser.

  The COMMAND is quoted only when it cannot be left bare, because quoting a bare
  one breaks the shim it resolves to. `npm.cmd` locates the CLI it exists to
  launch as `%~dp0\node_modules\npm\bin\npm-cli.js`, and cmd substitutes the
  resolved script path for `%0` only when the token was bare; quoted, `%~dp0`
  expands against the current directory, so the shim looked for npm inside Telo's
  own install root and failed with MODULE_NOT_FOUND on a path that never existed.
  A command that does need quoting is a path rather than a name, and there `%0`
  already carries a directory — so both cases are correct.

  The not-found detection moved with it. Through a shell the binary always
  resolves — `cmd.exe` exists — so a genuinely missing package manager arrives as
  exit 9009 and "is not recognized as an internal or external command", matching
  neither the `ENOENT` nor the wording the old check looked for; it would have
  fallen through to the generic install-failure branch and buried the line naming
  what to install.

  The POSIX path is unchanged in both halves.

- Updated dependencies [b8be55b]
- Updated dependencies [f4efb4b]
- Updated dependencies [b8be55b]
- Updated dependencies [b8be55b]
  - @telorun/kernel@0.76.0
  - @telorun/analyzer@0.61.0
  - @telorun/ide-support@0.13.3

## 0.75.0

### Minor Changes

- 58bc988: One release system for Telo modules, in the CLI: `telo release add | status | order | check | apply | verify`, over the modules discovered inside a workspace declared by a `telo-workspace.yaml`. A module has one version across `telo.yaml`, `nodejs/package.json` and `rust/Cargo.toml`, and one changelog.

  A Telo module's artifact **embeds its dependencies** — esbuild inlines a sibling library's source into the controller bundle, and publish pins each relative import to a hash of the sibling's manifest — so bumping the dependents is a correctness requirement rather than a courtesy. Neither previous ledger could see that: changie has no dependency graph, and changesets' stops at the npm boundary. Two mechanisms now cover it. A **payload digest**, exact and taken from the bytes, decides _whether_ a module bumps, so it fires for an inlined sibling, a shared-library fix and a lockfile-only transitive bump alike. An **edge graph**, built from the controller build's own metafile plus in-repo relative `imports:`, decides _at what level_, mirroring a dependency's level onto its dependents. A digest that moved with nothing to attribute it to takes a patch and is reported as unattributed rather than passing silently. Both are recorded in `.changes/ledger.yaml`, so the PR gate and the publish gate compute the same number — and the PR gate needs no credentials, which is what lets a fork run it.

  Three changes make the published bytes a pure function of the commit, which is what makes "the same number" true rather than aspirational. Import pins are **authored and verified, never discovered**: `telo publish` no longer fetches a hash for an unpinned remote import (previously best-effort, so one commit produced different bytes depending on network reachability, and an unresolvable import shipped silently unpinned) — it refuses one, and verifies the pins the author wrote. Manifest re-serialization is unconditional. And a relative sibling's pin is derived from the sibling's own locally-built published bytes, in topological order, so a whole release batch is plannable offline.

  The controller layer is now **built by the kernel on the publish path**, as it already was on the run path (`buildControllerBundle`), instead of read as a prebuilt `.mjs` staged by `pnpm run build:bundles`. The shipped bytes and the digested bytes are the same bytes by construction, and the edge graph gets its metafile from the same run. On this path a host without esbuild is a hard failure rather than a fallthrough to a possibly-stale file.

  New CEL binding **`module.<field>`** — the declaring module's own `metadata`, typed per field and closed, so `module.version` reads a module's version instead of restating it and `module.verison` is a diagnostic. An imported library reads its own metadata, not its importer's; the loader's derived stamps (`source`, `sourceLine`, …) are filtered out.

  `ModuleFileClaim` for a bundled controller now carries `localPath`, the source its entry point is built from. `assertWithinModule` aggregates missing payload files into one message and takes a set of paths whose content the caller supplies in memory — a built controller entry point is gitignored and legitimately absent, so the guard runs _after_ the build rather than demanding a prestep that no longer exists. `--frozen` is removed from `telo publish`: it selected between best-effort pinning and a hard error, and best-effort is gone.

  `Output` gains `progress()`, a stderr write gated on the stream being a TTY. `errLine` must write in every format because silencing it loses the reason a command failed; a progress tick explains nothing, so its gate is whether a human is watching rather than which format was asked for.

### Patch Changes

- Updated dependencies [831c0c4]
- Updated dependencies [58bc988]
- Updated dependencies [831c0c4]
  - @telorun/sdk@0.75.0
  - @telorun/analyzer@0.60.0
  - @telorun/templating@0.16.0
  - @telorun/kernel@0.75.0
  - @telorun/ide-support@0.13.2

## 0.74.0

### Patch Changes

- Updated dependencies [ccf56f5]
- Updated dependencies [35e1a58]
  - @telorun/sdk@0.74.0
  - @telorun/analyzer@0.59.0
  - @telorun/templating@0.15.0
  - @telorun/kernel@0.74.0
  - @telorun/ide-support@0.13.1

## 0.73.0

### Minor Changes

- a434722: Manifest migrations: one registry and one driver for rewriting a legacy
  spelling to the current one.

  Telo rewrote a manifest between parsing it and analyzing it in six places, and
  two different things were tangled there. Most are **normalizations** — sugar
  folded into the internal form, never written back, correctly invisible. A
  growing minority are **migrations**: an old spelling rewritten because published
  artifacts carry it and cannot be edited. Each re-invented the same four things by
  hand — where to walk, how to report without blaming a dependency the author
  cannot fix, how an author is meant to _act_ on the warning, and when the code may
  be deleted. The last two were usually skipped: a deprecation warning told an
  author something was wrong and offered no repair but hand editing.

  Adding a migration is now one JSON file in `analyzer/migrations/`. **An entry
  contains no code** — both what a rule matches and what it patches are data, so
  one file is read identically by every kernel; a predicate expressed in one
  language would mean one artifact is read two ways, invisibly, since a migration
  that succeeds is silent. JSON rather than YAML because it is the only format all
  three runtimes embed with no generation step (Rust `include_str!`, Go
  `//go:embed`, TypeScript `resolveJsonModule` and nothing else).

  - **The patch names what it targets**: `rename-key`, `set-value`, `set-tag`,
    `insert-item`, `remove-entry`. Every operation has a known YAML edit form,
    which is what makes a migration applicable to a _file_ and what lets the driver
    **derive** whether a quick fix exists — read off the verb, never declared, so a
    missing repair is stated rather than silent. A lone `set-value` yields a
    `DiagnosticFix`; anything else says `no quick fix (removes an entry) — run
\`telo migrate\``instead of offering one that would corrupt the file. A
written value must be a scalar, refused when the entry is *read*: the file
applier re-quotes a value in the author's own style at the node's own span,
which has no meaning for a mapping, so accepting one would hide the limitation
until a user ran`telo migrate` and was told, permanently, to fix it by hand.
  - **The matcher's containment is positive and required**: `inKind` names the
    document kinds a rule may touch and `under` the region within them it may
    reach; nothing outside is reachable. `under` is **anchored at the document
    root** — it names top-level keys — which is what makes that claim true rather
    than decorative: a `Telo.Definition`'s `resources:` template body carries other
    kinds' configuration, so a rule matching "any path segment spelled `schema`"
    would reach the very user JSON blob the positive form exists to keep out.
    Walking everything and subtracting cannot be made sound — the set to subtract
    is unbounded, since any kind whose config carries a user JSON blob can hold
    something shaped like the node a rule looks for — and it cannot express the
    guarantee the module surface is promised to carry. Both halves are closed
    vocabularies at every level; an unknown token is refused, `$comment` aside.
    Both gates bound the _walk_ rather than filter its output, so a document no
    rule targets is never walked and a region no rule names is never descended
    into — this runs on the kernel's boot path for every file in the graph.
  - **The phase runs in the loader**, after parse and before both the CEL
    precompile and import desugaring, so a rule only ever matches author-written
    nodes — a synthetic import manifest has no YAML document to edit, would record
    a path the file never had, and shares `variables` / `secrets` by reference with
    the module doc.
  - **Composition is the driver's guarantee**: one pass with the match set frozen
    against the pre-migration tree, rules ordered within an entry, entries
    independent. Idempotency follows from that rather than from every author
    getting it right. A patch that cannot apply in full applies not at all. A
    frozen match reaches through a sequence by index, and an index is not an
    identity, so a match under an array a sibling patch resized is refused rather
    than rewriting the element that patch produced.
  - **Rewrite always, report locally.** Every file in the graph is rewritten, so a
    module published years ago keeps loading; only the entry module's own files
    report, because a published dependency is not the consumer's to fix.
    `LoadedGraph` gains `migrationDiagnostics`, `LoadedFile` gains `migrations`.
  - **Path provenance is in the driver's contract.** Each rewrite records the path
    it matched beside the migrated one, and every downstream diagnostic is mapped
    back through it before its position is resolved — without which a key rename
    would silently downgrade every squiggle on that node to a parent squiggle, and
    let a fix among them write across a parent's span. The general index is by
    FILE, so a diagnostic that names only its file (as many do) and a rewrite in a
    document with no `metadata.name` (every `Telo.Import`) are both reachable;
    resource identity narrows within a file rather than being the only key.
  - **A migration is reported everywhere the manifest is read.** `telo run` warns
    through the kernel logger, alongside the version-hoist warning it already
    emitted — otherwise the one command an author actually uses would be the only
    surface that rewrote their manifest silently. The SDK's `check` seam remaps
    paths like every other consumer, so a module acting on `path` and an editor
    rendering a squiggle never disagree about what a manifest says.
  - **`LoadOptions.migrate`** is a new, opt-in third cache axis beside `compile`
    and `desugarImports`. Every resolved consumer passes it; a round-trip view must
    not, since the editor writes its manifest/YAML pair back on save.
    `ctx.loadModule`'s `LoadOptions` (SDK) gains the same flag.
  - **`telo migrate <paths..>`** applies pending migrations to a file, through
    byte-level splices — comments, indentation, block scalars and quote style are
    preserved, exactly as `telo upgrade`'s rewrite already is. Imported modules are
    left alone. A location whose YAML cannot carry the edit is reported rather than
    silently skipped, since the diagnostic that sent the author here says to run
    this command. Removing a mapping entry that _opens_ a sequence item
    (`- type: string`, the shape a legacy `anyOf` branch takes) splices out to the
    following key instead of deleting the line, which would take the `- ` with it.

  - **The scalar re-quoting rule and the byte-splice loop are one primitive**
    (`yaml-source-edit.ts` in `@telorun/analyzer`, browser-safe), read by the
    migration applier, `@telorun/ide-support`'s quick fix and `telo upgrade`'s pin
    rewrite. Three surfaces now write repairs into the same files; two copies of a
    subtle quoting rule would eventually quote one value two ways and nothing would
    catch it. `@telorun/ide-support` re-exports `renderFixReplacement`,
    `quoteStyleOf` and `isPlainSafe` unchanged.

  **Breaking:** `normalizeRefSlots` is removed from `@telorun/templating`. It
  dropped the legacy scalar `type:` at an `x-telo-ref` slot at every
  schema-compile site, which the shipped `ref-slot-scalar-type` entry now does once
  at load. Keeping both would have left one rewrite with two traversals that match
  different node sets, and it falsified the design's own safety property — a
  consumer who forgot `migrate` behaved identically apart from the missing warning,
  so the entry could not prove the mechanism it demonstrates. Nothing outside this
  repo is known to call it; a manifest still carrying that spelling is repaired by
  the migration on every load, and `telo migrate` fixes the file.

### Patch Changes

- Updated dependencies [a434722]
- Updated dependencies [c8d457b]
  - @telorun/analyzer@0.58.0
  - @telorun/templating@0.14.0
  - @telorun/ide-support@0.13.0
  - @telorun/kernel@0.73.0
  - @telorun/sdk@0.73.0

## 0.72.0

### Minor Changes

- 55a7bef: Make CEL diagnostics actionable, and let an instant leave an expression.

  cel-js reports one sentence for three unrelated mistakes, and two of the three
  readings actively mislead: `no matching overload for 'startsWith(dyn, string)'`
  names argument types, so the repair looks like a cast when the real fix is
  `key.startsWith('x')`; `no matching overload for 'now()'` reads as wrong arity
  when the function does not exist. Each wrong repair cost a full check cycle and
  landed back on the same message.

  Every call is now classified against the CEL function registry
  (`Environment.getDefinitions()`), which reports call form and parameters for
  cel-js built-ins and Telo's catalog alike. Name existence, call form and arity
  are decided by lookup, so nothing parses cel-js's message text and a cel-js
  version bump cannot silently degrade the classification. New codes:
  `CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`, and
  `CEL_NONDETERMINISTIC_IN_COMPILE_FIELD` (a warning: `nowIso()` in an
  `x-telo-eval: compile` field bakes once at load).

  - **Breaking:** `TemplatingEngine.analyze` returns `AnalyzeResult`
    (`{ diagnostics, type?, calls }`) instead of `EngineDiagnostic[]`. The engine
    now owns the type-check, so one expression produces one verdict against one
    environment — previously two passes with two environments let the opaque
    residual survive beside the diagnostic that explained it, and left `${{ }}`
    interpolations chain-validated but never type-checked.
  - **Breaking:** CEL failures no longer report as `SCHEMA_VIOLATION`; the
    residual type error is `CEL_TYPE_ERROR`.
  - **Breaking:** `NormalizedDiagnostic.suggestions` entries are
    `kind: "replace"` (was `"replace-kind"`).
    Diagnostics with a decidable repair stamp a generic `fix` (`{ replacement }`
    — the whole corrected value, with no sub-range) that flows unchanged to CLI
    JSON and IDE CodeActions; `UNDEFINED_KIND`'s suggestion collapses into it.
  - The VS Code extension offers those repairs as quick fixes. `ide-support`
    gains `renderFixReplacement`, which re-quotes a replacement in the style the
    author used: the span a fix replaces is the value node as written, so it
    includes the scalar's quotes (the YAML tag sits outside it), and writing a
    bare CEL expression into a quoted span would unquote text that a `: ` or a
    trailing `#` stops parsing as one scalar. Shared with the Tauri editor so
    both surfaces write a repaired scalar identically. It refuses a multi-line
    span: a block scalar's span covers its `|`/`>-` indicator and its trailing
    newline, so a single-line replacement would delete the break that ended the
    mapping entry and glue the next key onto the value — the quick fix is simply
    not offered there.
  - `telo check -o json` diagnostics gain `resource`, `path` and `fix`.
  - `telo cel functions` lists CEL's own built-ins alongside Telo's catalog,
    grouped by receiver type (appended to the `--json` array as
    `category: "builtin"`, so an existing consumer keeps working). They were
    absent entirely — which is why an author could read that command end to end
    and still call a method as a global, and why every new diagnostic pointing at
    it would otherwise have pointed at a list missing the functions it was about.
  - `CheckDiagnostic` (the SDK's static-analysis seam, `ctx.runtime.check()`) gains
    `resource`, `path` and `fix`, so a module can act on a repair instead of
    recovering it from prose. `path` travels with `fix` because the repair
    replaces the value AT that path — a consumer holding only `line`/`column`
    could not apply it to a parsed manifest.
  - CEL gains `string(timestamp)` (RFC 3339) and `int(timestamp)` (epoch
    seconds), the two conversions cel-go defines and cel-js omits. Without them
    an expiry could be computed and not stored, which is also why three parallel
    encodings of "now" exist.
  - `UNCOVERED_THROW_CODE` reports one diagnostic per `catches:` block naming
    every uncovered code and the handler, instead of one per code.

- e801bd2: Embed a file that ships beside the manifest, with `!include-text` and `!include-bytes`.

  A brand font, a background SVG, a `.sql` file, a system prompt — each is a file
  next to `telo.yaml`, and until now there was no way to make one a manifest
  value. `Fs.File` reads at _invocation_ time, resolves against the process cwd
  rather than the module, and cannot supply a field read at construction; pasting
  base64 into a scalar is unreviewable and contradicts the rule `x-telo-binary`
  exists to enforce — that bytes always arrive by reference and are never authored
  inline.

  ```yaml
  kind: PdfMake.Document
  fonts:
    Brand:
      normal: !include-bytes assets/Brand-Regular.ttf
  background:
    svg: !include-text assets/page-background.svg
  ```

  - **Paths are module-root-relative**, never relative to the file the tag was
    written in. That is the rule a controller's `path=` qualifier and
    `files:`/`assets:` patterns already follow, and it is what makes a path mean
    the same thing after publish, which inlines every `include:` partial into a
    single published `telo.yaml` — a per-file-relative path would silently move,
    passing `telo check` locally and failing only for consumers.
  - **Confinement is decided from the written path alone** (`INCLUDE_PATH_INVALID`,
    `INCLUDE_PATH_ESCAPES_MODULE`), so the browser-side analyzer enforces it
    without a filesystem. The kernel re-checks rather than trusting that
    `telo check` ran. A computed path is deliberately not expressible: a file that
    ships inside the artifact has a name known at publish time, so the dynamic
    case belongs to `Fs.File`.
  - **The read happens when the resource holding it is created**, not at manifest
    load — `telo.yaml` is its own artifact layer precisely so reading a manifest
    cannot pull the payload, and an app loads every imported library's manifest.
    A `with:`-scoped resource pays only when its scope runs. An embed on a doc
    that is never instantiated is therefore read by nothing, and reported
    (`INCLUDE_OUTSIDE_RESOURCE`) rather than silently ignored.
  - **Publish adds a named file to the artifact automatically** — nothing is
    restated in `files:`.

  Payload membership is now one generic mechanism rather than two derivations that
  happened to agree:

  - `TemplatingEngine` gains an optional `fileClaims(source)` hook, so an engine
    declares what its tag embeds. The `ref-slot.ts` precedent: one accessor on the
    contract, no consumer pattern-matching a shape.
  - `collectModuleFileClaims` (`@telorun/analyzer`, browser-safe) is the single
    reader — engine claims plus the controller `path=`/`siblings=` claims, each
    carrying its path, layer role and selector. Deliberately **not** part of
    `analyze()`, whose pass is flattened and import-inclusive: its claims would
    mix in imported libraries' files and would make packaging depend on resolving
    the whole import graph.
  - **Breaking:** `partitionLayers` takes that claim set instead of manifest text,
    and `unmatchedSiblings` entries carry `origin` (was `purl`). `readControllerClaims`
    moves out of the CLI. Publish now recognises neither a PURL nor a YAML tag, and
    refuses to publish when a named file does not exist.

  **Fixed: an imported library measured module-relative files from the CONSUMER's
  directory.** An import's child `ModuleContext` carried the importing manifest's
  URL rather than the library's own, and `source` is what every module-relative
  reference resolves against. So a library reading its own asset looked in the
  app's directory — and if the app happened to have a file at the same relative
  path, it silently got the app's. This was never specific to embeds: it is the
  same `source` `ctx.resolveModuleFile` reads, so `Http.Static`, `mcp-client`,
  `assert`'s manifest loader and `Test.Suite` were mis-resolving for an imported
  library too, and one fix covers all of them. It also contradicted packaging,
  which is per-module and had already placed the library's file in the library's
  own artifact.

  **Fixed: a file embed's type is now checked statically.** `substituteCelFields`
  collapsed every tagged sentinel to a slot-shaped placeholder — right for `!cel`,
  whose type is only derivable from the expression, wrong for these two, whose
  result type is a constant of the tag. So `!include-bytes` at a `type: string`
  slot passed `telo check` and failed at resource creation, and the reverse did
  too. The substitution now uses the real type, and AJV plus the existing
  `x-telo-binary` keyword reject both directions with no new diagnostic code.

  Two latent bugs surfaced and are fixed, both from config-resident values that
  previously could not exist:

  - The CEL expansion walker rebuilt **any** object from its entries, so a byte
    buffer in a config field would have reached the controller as `{"0":137,…}`
    with nothing raising. It now recurses only into plain containers, the rule
    `precompileDoc` already followed.
  - The same rule fixes a stack overflow: a template kind expands
    `${{ self.connection }}` to a live `ResourceInstance`, whose object graph is
    cyclic.

  The Rust half mirrors the tag set and the path grammar, and resolves
  `!include-text` at resource creation. `!include-bytes` fails there with an
  explicit message: that kernel carries a manifest as JSON, which has no value for
  raw bytes.

### Patch Changes

- Updated dependencies [55a7bef]
- Updated dependencies [e801bd2]
  - @telorun/templating@0.13.0
  - @telorun/analyzer@0.57.0
  - @telorun/ide-support@0.12.0
  - @telorun/sdk@0.72.0
  - @telorun/kernel@0.72.0

## 0.71.0

### Minor Changes

- 418a70b: Global `-o, --output text|json` for the CLI's own output, and colour decided per stream.

  Every command routes its output through one seam (`cli/nodejs/src/output.ts`) instead of writing `console.*` or `process.stdout.write` directly — enforced by a test, so the invariant is checkable rather than a convention.

  **stdout is the machine surface; stderr stays human.** Under `-o json` stdout carries the payload and nothing else, so a caller reads `telo check`'s diagnostics by `code` and location instead of parsing prose. Prose keeps flowing to stderr in both formats — the convention npm, cargo and kubectl follow — because silencing it would swallow the reason a command failed, leaving `{"ok":false}` with no cause.

  Two payload shapes share one serializer. `emit` writes a result envelope (`check`, `install`, `publish`, `upgrade`) and is silent under `text`. `document` writes a bare document (`cel`, `search`, `module versions|manifest|digest|resources|kinds`) in either format, since those commands' `--json` flags predate `-o` and keep working. A document command's stdout is the document or empty, never an error envelope — a CEL expression evaluating to `{"ok":false,…}` would otherwise be indistinguishable from a failure report — so its errors are prose on stderr plus a non-zero exit.

  **`telo run` is exempt from `-o json`.** The kernel runs in-process and stdout/stderr are copied rather than redirected, so the app writes to those same descriptors and neither is the CLI's to claim; an envelope appended after app output would be unparseable. The machine surface for a run is `--debug`, whose wire protocol is framed per event precisely because it shares a stream.

  Colour is decided separately for stdout and stderr rather than once from `process.stdout.isTTY`. Diagnostics go to stderr, so redirecting one stream and not the other previously emitted escapes where nothing could render them. stdout is never coloured under `-o json`, whatever `FORCE_COLOR` says.

  A payload write is now followed by `process.exitCode` rather than `process.exit()`: on a pipe `write` is asynchronous and `exit` does not flush, so a large diagnostic set truncated into invalid JSON.

  `yaml` is deliberately unimplemented — `-o` is an enum so it can gain that value without a second flag, and an unrecognized format throws instead of silently degrading to text.

## 0.70.0

### Minor Changes

- 0ea1b8b: A CEL integer crosses a JSON boundary without a cast.

  CEL models `int` as int64, which this runtime evaluates to a BigInt, and both doors out were shut. A JSON response body with no declared schema reached `JSON.stringify`, which throws on a BigInt; declaring the schema traded that for an AJV rejection (`must be integer` — its type check is `typeof data == "number"`) before the value was ever serialized. The only way through was `double(...)`, a cast that says "float" about a value that is an integer and silently truncates past 2^53 — and it had spread into the standard library's own examples, its docs, and the hub.

  The kernel now installs `BigInt.prototype.toJSON` at `boot()` (`enableBigIntJson`, exported from `@telorun/kernel` — installing a global is a composition-root action, not something a controller should reach for), built on `JSON.rawJSON` so a BigInt serializes as its exact decimal digits rather than a lossy Number or a type-changing string. The rule is normative in `kernel/specs/invocation-contract.md` §4.4, so a second-language runtime has something to implement against. That is not a new policy: it is what `fast-json-stringify` already emitted for a schema-typed `integer`, so the runtime's two JSON serializers now agree at every magnitude instead of only below 2^53. Being a process-global patch — in the same spirit as the existing `process.env` guardrail — it covers every JSON boundary in the process: the kernel's, the standard library's, a third-party module's, and one not yet written.

  The validator half moved with it. `ctx.validateSchema` and every `SchemaValidator.compile()` validator now check a BigInt-normalized view and merge the `useDefaults` fills back, so a computed integer satisfies a declared `integer` slot while the value that reaches the controller keeps its 64-bit range. That merge now recurses index-wise through arrays: AJV writes a default at every level it finds one, `items` included, and stopping at the array boundary dropped those fills silently. The contract binding no longer normalizes on its own — one layer owns the concern, and a contracted dispatch no longer walks its input and output trees twice.

  Serializers that deliberately encode a BigInt differently were updated to keep doing so, since `toJSON` runs before a replacer: `encodeJsonValue` still tags one so a persisted value replays as the same type, the `json` log encoding still quotes a value beyond the safe range as OTLP does for its 64-bit fields, and the `pretty` console encoding still renders one as text. `bigIntAt` is exported from `@telorun/sdk` for a sink or codec that needs the same.

### Patch Changes

- Updated dependencies [0ea1b8b]
- Updated dependencies [0ea1b8b]
- Updated dependencies [07fca98]
  - @telorun/kernel@0.70.0
  - @telorun/sdk@0.70.0
  - @telorun/analyzer@0.56.1
  - @telorun/templating@0.12.0
  - @telorun/ide-support@0.11.3

## 0.69.0

### Patch Changes

- Updated dependencies [8cede51]
  - @telorun/analyzer@0.56.0
  - @telorun/kernel@0.69.0
  - @telorun/ide-support@0.11.2

## 0.68.0

### Patch Changes

- Updated dependencies [2373398]
- Updated dependencies [2373398]
- Updated dependencies [2373398]
  - @telorun/kernel@0.68.0
  - @telorun/sdk@0.68.0
  - @telorun/analyzer@0.55.0
  - @telorun/templating@0.12.0
  - @telorun/ide-support@0.11.1

## 0.67.0

### Minor Changes

- 8a9b494: `telo check` now reports execution-zone diagnostics: a statement declaring a
  `transaction:` wired onto a path that reaches it outside any transaction is an
  error at check time rather than a throw the first time that route is exercised.

  The command feeds the analyzer each imported library's full documents
  (`collectZoneModuleDocuments`) alongside the flattened manifest list. The
  flattened view carries only each library's export surface, never its internal
  dispatch chain, so without this the zone stage cannot derive what an exported
  resource requires of its importers — and `ZONE_EXPORT_UNSATISFIABLE` would
  never fire at the library that owns the fix.

### Patch Changes

- e7853d5: `telo install` now hands each controller pre-install job its module's
  `ModuleArtifact`, the same handle the kernel supplies at run time. Previously
  the pass called the controller loader with no artifact, so every `pkg:telo`
  bundled candidate of a published (`oci://`) module was env-missing and the
  install failed on modules `telo run` loads fine — only legacy `pkg:npm`
  modules passed. `warmModuleLayers` now returns the artifact handles it already
  built (keyed by module source) instead of discarding them.
- Updated dependencies [8a9b494]
- Updated dependencies [e7853d5]
- Updated dependencies [0938ed4]
  - @telorun/kernel@0.67.0
  - @telorun/sdk@0.67.0
  - @telorun/analyzer@0.54.0
  - @telorun/ide-support@0.11.0
  - @telorun/templating@0.12.0

## 0.66.0

### Minor Changes

- 3bd2de9: Modules now report which kernels can run them, and deprecation is structured
  rather than prose.

  `telo module manifest --json` gains a `runtime` block classifying every kind by
  the kernels that can host it, derived from its `controllers:` PURL candidates:
  `pkg:cargo` runs on both kernels (the Node kernel builds the crate as a napi
  addon, the Rust kernel opens it as a cdylib), `pkg:npm` and a bundled
  `pkg:telo/local/js` on Node alone, and a format no kernel hosts contributes
  nothing. Telo is polyglot, so this is a capability rather than trivia — without
  it a consumer composing for the Rust kernel is offered kinds it cannot load.

  The classification is per KIND, and the module roll-up distinguishes full from
  partial coverage, because coverage genuinely differs within one module:
  `std/console` ships Rust controllers for two of its four kinds, so a boolean
  would claim the whole module runs on the Rust kernel. A kind declaring no
  controllers is reported as `portable` — no kernel constraint — rather than
  having today's kernels enumerated into it, which would make the record wrong
  the day a third kernel ships. Language is tracked as a separate axis from
  runtime and is left blank for a `napi`/`wasm` bundle, whose source language the
  PURL does not determine.

  `@telorun/analyzer` gains the first validation of the `metadata:` block on
  `Telo.Application` / `Telo.Library` docs, which previously had no schema at all.
  Known fields are type-checked, the vocabulary stays open, and an unknown key is
  reported only when it is a near-miss of a known one — nothing in the kernel
  reads these fields, so a mistyped `licence:` or `deprecatd:` has no runtime
  failure mode and would otherwise ship unnoticed.

  Two new fields are recognized: `metadata.homepage`, and `metadata.deprecated`
  with a `reason` and an optional `replacedBy`. The replacement is resolvable
  rather than free text, and its form follows the level — a module doc names
  another module ref, a kind doc names an alias-qualified kind (`Self.Migrations`,
  `Telo.JsonSchema`) resolved through the declaring file's own imports, exactly as
  `extends:` is. `INVALID_DEPRECATION` and `DEPRECATION_REPLACEMENT_UNRESOLVED`
  report a replacement a consumer could not follow.

### Patch Changes

- Updated dependencies [3bd2de9]
- Updated dependencies [0b971d6]
  - @telorun/analyzer@0.53.0
  - @telorun/kernel@0.66.0
  - @telorun/ide-support@0.10.1

## 0.65.0

### Minor Changes

- bd6398e: Upgrading an import from an editor now writes the new version's integrity pin
  instead of dropping it.

  `telo module manifest --json` emits an `integrity` field — the owning
  transport's `manifestHash`, never a hash re-derived from the manifest text,
  since only the transport knows what its own reads verify against. The hub stores
  it per version and serves it from `/module/versions`, so an editor gets the pin
  in the request it already makes and no browser has to speak OCI to produce one.

  In `@telorun/ide-support`, `ModuleVersionLookup` now returns
  `{version, integrity?}` entries, and `buildImportUpgrades` reports two
  categories: imports that are behind (bumped and re-pinned in one edit) and
  imports at the newest version carrying no pin (pinned in place, matching
  `telo upgrade`'s `ensurePinned`). Pins are written in the shape the author
  wrote — a scalar shorthand takes a `#sha256-…` fragment, an object-form
  `integrity:` has its value replaced — which also lets a flow-style
  `{source: …, integrity: …}` entry be re-pointed instead of skipped. With no pin
  available for the target version the previous behaviour is unchanged: the
  version is bumped, the stale pin removed, and the host told to say so.

  A pin arriving over the network is spliced into the author's YAML, so it is
  validated before it is written: `@telorun/analyzer` exports
  `isCanonicalIntegrity`, and a value that is not `sha256-<43 base64url chars>`
  is treated as no pin rather than written through — a malformed one would
  corrupt the manifest, which is the one failure install-time verification cannot
  catch. `parseModuleVersions` (also new, in `@telorun/ide-support`) is the single
  reader for the route's body, so a host no longer hand-rolls the parse.

### Patch Changes

- Updated dependencies [bd6398e]
- Updated dependencies [f94ff85]
- Updated dependencies [0bbbc3f]
  - @telorun/ide-support@0.10.0
  - @telorun/analyzer@0.52.0
  - @telorun/kernel@0.65.0
  - @telorun/sdk@0.65.0
  - @telorun/templating@0.11.1

## 0.64.0

### Minor Changes

- c28ee72: Present OCI as the primary module ref form in CLI help and docs. `telo module`'s
  `<ref>` help text now leads with `oci://host/repo@1.2.0` instead of a `std/`
  registry ref; the bare `<namespace>/<name>@<version>` form still resolves and is
  still listed. No behavioural change — help and comment text only.

### Patch Changes

- Updated dependencies [c28ee72]
- Updated dependencies [424aacf]
- Updated dependencies [a8402d9]
- Updated dependencies [642b057]
  - @telorun/ide-support@0.9.0
  - @telorun/analyzer@0.51.0
  - @telorun/kernel@0.64.0
  - @telorun/sdk@0.64.0
  - @telorun/templating@0.11.1

## 0.63.0

### Minor Changes

- e52a2bf: `telo publish`: a bundled controller's entry point no longer has to be restated in `files:`.

  `controllers:` already names it, so it joins the payload from there — matching the module-artifact spec, which defines a controller layer by its candidates' entry points and says nothing about `files:`. A module whose only payload is its controller now declares no `files:` at all, and `files:` keeps its role for what the manifest cannot otherwise name: assets, static files, sidecars. Symlink confinement moved from the pattern match to the whole partition, so it covers every file that actually ships.

  `telo publish` also refuses to publish changed bytes at an unchanged `metadata.version`. A bundle inlines its dependencies, so a fix in a shared TS library — or a transitive bump the lockfile alone moved — changes a module's shipped bytes while touching no file under its own directory and moving no package version; no path-scoped rule and no version ledger can see that, and the fix would ship to nobody. Publish now builds the payload and compares each layer's `integrity` digest against the artifact already published under that version, naming the digest that moved. Exact rather than inferred: it cannot miss what no version records, and identical bytes hash identically so it cannot fire spuriously.

  The analyzer accepts `local_path` as a known qualifier on a bundled-controller PURL. It names the source `path=` was built from, contributes nothing to the layer selector, and is inert in a published artifact.

### Patch Changes

- 3e9f802: Surface outdated `imports:` entries in the IDE, the way the telo editor's Imports view already does.

  `@telorun/analyzer` gains `newestModuleVersion(versions, { includePrerelease })` beside `isNewerModuleVersion`. Both halves of an upgrade check have to come from one rule: a host that decides "behind" through the shared ordering but reads "latest" off the head of a version list is answering with whatever order its index happened to return. For a module whose newest tag is a prerelease, list-order said the import was behind while the ordering rule said it was current — the same manifest against the same hub, two answers. Unparseable tags (an OCI digest, a moving `latest`) are dropped rather than ordered, and prereleases are excluded unless asked for, matching `telo upgrade`'s default. The editor's Imports view now derives its "latest" through it, so its badge no longer offers `-rc` builds as automatic upgrade targets; the per-import dropdown still lists every version for a deliberate pick.

  `@telorun/ide-support` gains `buildImportUpgrades(text, listVersions, docs?)` — a host-neutral builder that locates every `imports:` entry of a module document, asks a caller-supplied `ModuleVersionLookup` for each distinct base ref's versions, and returns the source edits that re-point the ones that are behind. Both authored shapes are handled: for the object form the now-stale `integrity:` line is deleted alongside the source rewrite, because the pin hashes the `telo.yaml` of the version being replaced and carrying it forward would turn the next install into a tamper error. An entry whose pin shares a line with other fields is reported as a skip — carrying its anchor and versions, so a host renders it in place of the upgrade affordance rather than showing nothing for an import that is behind.

  The VS Code extension renders it as CodeLenses: a summary lens on the `imports:` key (`2 imports outdated · Upgrade all`), a per-entry lens (`↑ 0.9.0 → 1.0.0`), and a warning lens for a skip. Version lists come from the hub, memoized so lens resolution stays off the keystroke path — failures are memoized too, on a shorter clock, or an unreachable hub would fire a request per base ref on every keystroke. A click that changes nothing now says which of the three reasons applied: a lookup that failed, a skip that named a reason, or genuinely current. Hub failures go to a new `Telo` output channel, reachable from the failure notification. New setting `telo.importUpgrades.enabled` turns the feature and its hub traffic off; new command `Telo: Check Imports for Updates` drops the memo and re-checks.

  `@telorun/cli` drops its private copy of the module-kind list in favour of the analyzer's `isModuleKind`.

- Updated dependencies [e52a2bf]
- Updated dependencies [e52a2bf]
- Updated dependencies [3e9f802]
  - @telorun/analyzer@0.50.0
  - @telorun/sdk@0.63.0
  - @telorun/kernel@0.63.0
  - @telorun/ide-support@0.8.0
  - @telorun/templating@0.11.1

## 0.62.0

### Minor Changes

- 15acf14: `telo check` no longer re-downloads every import on every run.

  It built its `Loader` from `[LocalFileSource, ...transports]` — `LocalManifestCacheSource` was absent, and nothing wrote the cache afterwards. So every `oci://` and registry import was pulled from the origin on every invocation, including fully digest-pinned ones whose bytes cannot change. The loader was also constructed per input path, so one `telo check a b c` re-fetched a module shared between them once per file. Checking the repo's examples took 41s of which 35s was network, with `http-server` and `console` each fetched six times inside a single process.

  `check` now registers the same manifest cache `run` reads and write-throughs after a successful load, and shares one loader across every input path (its `urlToSource` / `fileCache` dedupe by canonical URL, so the resolution result never depended on which entry asked). A cache source is registered per input path's cache root; entries are content-addressed, so a hit under any root is as good as a hit under the one that path would write to.

  Freshness is kept honest rather than assumed, per cache-key shape:

  - A **pinned** import — what `telo install` writes and what every published manifest carries — is verified against its inline `sha256-` hash on read, so it needs no network at all.
  - An import naming a **mutable OCI tag** is revalidated with one `HEAD` per reference (once per invocation, not once per input path) against the digest that produced the cached copy, recorded in `.telo/manifests/.origins.json`. A tag that has moved, or was never recorded — e.g. a cache written by `telo run` — drops that one entry and reloads it.
  - A **registry** ref is always version-segmented, and a published version is immutable by the same convention npm relies on, so it is served without revalidation. This is a deliberate call: the registry origin has no cheap freshness probe (`digest()` downloads the manifest to hash it), so revalidating would cost exactly what re-fetching costs.
  - An arbitrary **HTTP(S) URL** import is never read from the cache by `check`. Its key carries no version segment — one URL is one path forever — so a hit would be served for the lifetime of the directory regardless of what the server now returns. Re-fetching costs one request, which is exactly what revalidating would cost, so the honest option is also the cheap one. `check` still writes these entries, since `telo run` reads them.

  So `check` cannot report a clean bill of health against a manifest that has changed upstream.

  On the kernel side, read-side `OciClient`s are pooled per `(host, repo)` on the `OciTransport` instance instead of built per operation. The client caches bearer tokens per scope, but a per-operation client discarded that cache immediately, so every manifest and every blob paid its own 401→challenge→token round trip plus a `~/.docker/config.json` read and possibly a credential-helper subprocess. An expired token still self-heals through the existing 401 retry. The pool belongs to the instance rather than the module so a second transport — a test, or a second in-process kernel — never inherits another's credentials; `defaultTransportRegistry` is memoized per registry URL, so the production lifetime is unchanged. Publishing keeps its own client.

  `Loader.forget(url)` drops one file's memo (every parse variant, plus every request URL that canonicalised to it) so a single stale manifest can be re-resolved without discarding the whole loader and every unrelated file's cached resolution with it. The loader already documented needing this for watch mode.

  Checking the examples now takes 1.2s warm; a single pinned manifest resolves with no network at all.

### Patch Changes

- 89ffea7: `telo run` points a manifest error at its line again, exactly as `telo check` does.

  A failure the kernel raises from static analysis converted the analyzer's diagnostics into `RuntimeDiagnostic`s while dropping their `data` — the file, the field path within it, and the owning resource. That is precisely what `findPositions` resolves a position from, so the CLI had nothing left to locate and printed the message alone. The same manifest checked with `telo check` still named the line, which made the two commands disagree about the same error.

  `RuntimeDiagnostic` gains `origin` (`DiagnosticOrigin`: `filePath`, field `path`, `resource`, and the diagnostic's own `range`), carried through verbatim so a renderer resolves `file:line:col` against the loaded graph rather than re-parsing a rendered message. `range` is what locates a failure with no field path to look up: a YAML parse error knows where the syntax broke but has no parsed tree to index.

  All four raise sites now go through one mapper (`static-analysis-diagnostics.ts`, sibling of the init-failure one): the pre-flight validation pass, Phase-3 reference resolution, YAML parse failures, and major-version conflicts. The last two used to flatten their diagnostics into a joined message string, so a syntax error and a bad `imports:` pin were the two failures `run` could not locate at all. Their `error.message` is unchanged for consumers that only read it. The loaded graph is now recorded before the parse-failure throw, since that is the failure that most needs to name a line.

  The position itself comes from `resolveRange`, the rule the VS Code extension already uses, rather than a third copy of it in the CLI: it walks parent paths when the exact field path is absent from the index (an `imports.<alias>` conflict lands on the import entry) and prefers an entry's key over its value. `resolveRange` now takes just the position half of a `DiagnosticContext`, so a caller holding only a located file does not have to invent an `AnalysisRegistry` to reuse it. A located static failure renders byte-identically under `run` and `check`. A diagnostic nothing can locate falls back to naming the resource rather than pointing at line 1 — a wrong line sends the reader somewhere the error is not. Runtime failures are unchanged: they are pinned to a resource, not to a spot in the YAML, and keep the kind + name form.

- 0bbfa77: `telo run --watch` keeps reloading after an editor's atomic save.

  Watch mode reloaded a few times and then went permanently silent. `fs.watch` binds to the file's **inode**, not to its path, so the save style most editors and formatters use — write a temp file, then rename it over the target — leaves the watcher attached to the replaced inode. It never fires again, and it emits no `error` event, so the re-establish handler never ran and `sync` skipped the path as already watched. Every file died on its first atomic save, which is why the session survived exactly as many reloads as it happened to get in-place writes.

  The watcher now records the inode it is bound to and re-binds when it changes. The event that accompanies the replacement is the dying watcher's last gasp, which is enough to notice and re-arm — the strategy chokidar uses. The check is keyed on the inode rather than on a `rename` event type, because bun reports the replacement as `change`, so a rename-keyed variant would do nothing under the runtime the CLI actually runs on.

  A change arriving while no cycle was waiting on its gate — during teardown and the next load, which take seconds — is no longer dropped. It was resolving an already-settled promise; it is now held and consumed by the next cycle, so an edit made while the app is restarting still triggers the reload it should.

- Updated dependencies [15acf14]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
- Updated dependencies [89ffea7]
  - @telorun/kernel@0.62.0
  - @telorun/analyzer@0.49.1
  - @telorun/sdk@0.62.0
  - @telorun/ide-support@0.7.10
  - @telorun/templating@0.11.1

## 0.61.0

### Minor Changes

- bf324d2: Init failures now report the root cause instead of the whole cascade.

  When a resource fails to initialize, every resource downstream of it is unfinished too, and the multi-pass init loop used to report all of them flat — shadows first, since a resource that never got created was listed before one whose `init()` threw. A ten-resource chain printed one actionable line buried under nine repetitions of it.

  The kernel now classifies the failure set before raising `ERR_RESOURCE_INITIALIZATION_FAILED`. An entry is **derived** — collapsible — only when it carries `ERR_LOCAL_REF_PENDING` or `ERR_CROSS_MODULE_REF_PENDING`: a deferral, which says the resource never ran and so has nothing of its own to report. A reference edge into the failure set is **attribution only**, never grounds for collapsing: it proves an edge exists, not that this entry's failure came from it, so a resource that references a failed dependency _and_ fails its own validation keeps its line. `RuntimeDiagnostic` gains `derived` and `blockedBy` — the **root** of the chain, not the immediate blocker, since that is the name to go fix. If no entry survives as a root, the whole set is reported unclassified rather than collapsed to nothing.

  A nested context's failures — an import initializing its library's resources — are attached to the importing entry as `RuntimeDiagnostic.children` instead of being flattened into its message, so the child's own root causes stay distinguishable from the child's cascade and the CLI's error count reflects the real leaves rather than one `Telo.Import`. They are reported even when the wrapping entry is itself collapsed.

  `ModuleContext.getInstance` no longer reports a declared-but-uninitialized resource as `Resource 'X' not found in module context. Available resources: …`. That message listed the module's imports and read as a typo in a name that was in fact declared right there. While the context is still initializing the name now defers with `ERR_LOCAL_REF_PENDING`, exactly as Phase-5 injection does, so the loop retries and the failure is attributed to the dependency. **After** init — at dispatch, where no later pass is coming — it raises `ERR_RESOURCE_NOT_FOUND` saying the resource was declared but never initialized, rather than promising a retry that will never happen. An unknown name still gets the original message.

  The CLI prints root causes in full and collapses each blocked chain to a single line (`3 resources blocked by GrantDb: GrantStore, GuardedWork, OnceWork`); `--verbose` prints every entry.

### Patch Changes

- Updated dependencies [bf324d2]
- Updated dependencies [2ee3598]
- Updated dependencies [bf324d2]
- Updated dependencies [bf324d2]
  - @telorun/kernel@0.61.0
  - @telorun/sdk@0.61.0
  - @telorun/analyzer@0.49.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.9

## 0.60.0

### Minor Changes

- d23de89: Layered module artifacts: a published module is now one artifact of several layers instead of one tarball, and each layer is materialized only when something needs it.

  `telo.yaml` gets its own layer, so reading a manifest no longer downloads (and discards) the whole payload. The rest of `files:` is partitioned into one layer per bundled-controller selector — `format` plus optional `os`/`arch`/`libc` PURL qualifiers — plus an `assets` layer for what the new optional `assets:` list claims and a `common` layer for everything else. A Node kernel never fetches a `napi` layer, a `linux/amd64` host never fetches the `darwin/arm64` binary, and an app that imports a module for its API alone never fetches its frontend.

  This fixes a cold-start failure: bundled controllers used to resolve against an `oci://` base URI that was read as a filesystem path, because the payload was written to disk by a CLI hook running _after_ `kernel.load()`. The first run of any OCI-imported module with bundled controllers failed and the second succeeded. Controller layers now materialize at resolve time through a module-scoped `ModuleArtifact`, built during load where the pinned import ref and the verified manifest are both available — so verification stays anchored to the importer's `#sha256-` pin rather than to whatever is in the cache.

  `ctx.resolveModuleFile(relative)` is the new, URI-returning way to reach a file that ships with a module; it materializes the asset layer on first use. `Http.Static`, `mcp-client`, `assert`'s manifest loader and `Test.Suite` all use it, which also fixes a silent bug where a non-`file://` module resolved a relative root against the process working directory and served the wrong directory instead of failing.

  Also: `telo install --platform os/arch[/libc]` pre-fetches layers for a platform other than the build machine's, the layer index and selector grammar are specified normatively in `kernel/specs/module-artifact.md`, and the cross-process cache lock is shared between the npm loader and layer materialization instead of duplicated.

  Modules published before layers keep resolving: the manifest read path still accepts a single-blob artifact, which contains `telo.yaml` — so nothing that ships no payload needs anything done to it, and npm-backed modules are entirely unaffected. What such an artifact cannot supply is a layer index, so a module that _does_ ship a payload resolves its manifest and then fails at the controller with an actionable "republish" error. That is the six modules shipping `files:` — `oauth-client`, `scheduler`, `kv-store-memory`, `kv-store-redis`, `kv-store-sql`, `idempotency` — which must be republished, with consumers bumping to the new versions.

### Patch Changes

- Updated dependencies [d23de89]
  - @telorun/analyzer@0.48.0
  - @telorun/kernel@0.60.0
  - @telorun/sdk@0.60.0
  - @telorun/ide-support@0.7.8
  - @telorun/templating@0.11.0

## 0.59.0

### Patch Changes

- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
- Updated dependencies [6376a66]
  - @telorun/analyzer@0.47.0
  - @telorun/kernel@0.59.0
  - @telorun/sdk@0.59.0
  - @telorun/ide-support@0.7.7
  - @telorun/templating@0.11.0

## 0.58.0

### Patch Changes

- Updated dependencies [8353d0e]
  - @telorun/sdk@0.58.0
  - @telorun/kernel@0.58.0
  - @telorun/analyzer@0.46.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.6

## 0.57.0

### Patch Changes

- Updated dependencies [3729559]
  - @telorun/analyzer@0.45.0
  - @telorun/kernel@0.57.0
  - @telorun/ide-support@0.7.5

## 0.56.0

### Minor Changes

- f3b044d: Remove `metadata.namespace` as a structural field. Five subsystems read it;
  each now uses something the module already has.

  `x-telo-ref` names its target as an **alias-qualified kind** — the same grammar
  `kind:` and `extends:` use: `KvStore.Store` for a module in this file's
  `imports:` map, `Self.Store` for a kind in this library, `Telo.Invocable` for a
  built-in. The analyzer canonicalizes each constraint in the _declaring_ module's
  scope before registration, so the definition registry answers ref queries with
  no module context and a constraint stays correct whatever alias a consumer
  picks. The legacy `"<namespace>/<module>#<Kind>"` identity form still resolves
  for already-published module versions and now warns as
  `X_TELO_REF_LEGACY_IDENTITY`; `metadata.namespace` feeds nothing else.

  A constraint whose prefix names no alias is now `X_TELO_REF_UNRESOLVED` (or
  `KIND_NOT_EXPORTED` when the alias is known but the target gates the kind),
  quoting the slot's path and the aliases in scope. Previously — and for the old
  identity form before it — an unresolvable constraint made the reference check
  treat the slot as partial context and skip it, so a typo silently let the slot
  accept any resource. All three diagnostics are scoped to the modules the author
  can edit, so a published dependency never reports against its consumers.

  Definition schema `$id`s move onto `telo://<module>/<Name>`, the scheme named
  `Telo.Type`s already register under. One id space per module means a kind and a
  named type may no longer share a name; that collision is reported as
  `DUPLICATE_SCHEMA_ID` rather than silently dropping the type's schema.

  Version reconciliation keys on the **import ref minus its version** rather than
  `<namespace>/<name>`, so OCI and `https://` modules are hoisted for the first
  time and two same-named modules published to different origins are no longer
  conflated. A relative path addresses one file on disk, not a published
  location, and is not reconciled.

  `Transport.cacheLocation` is replaced by `Transport.cacheCoords`, returning the
  `{ transport, host, path, version }` coordinates that `manifestCacheKey`
  renders. The local manifest cache therefore uses the same layout as the
  discovery hub's static bucket:
  `.telo/manifests/<transport>/<host>/<path…>/<version>/<file>`. Registry entries
  now carry the registry host, so two registries' copies of one path and version
  no longer share a cache entry. **Existing `.telo/manifests` trees are orphaned
  by the new layout and are re-downloaded on the next `telo install`.**

  `telo publish` derives a relative sibling import's ref from the publish
  destination — the destination's last segment is the module's own directory, so
  `../bar` under `oci://ghcr.io/acme/foo` resolves to `oci://ghcr.io/acme/bar` —
  and reads only the sibling's version from its manifest. `SiblingIdentity` is
  gone.

### Patch Changes

- Updated dependencies [f3b044d]
  - @telorun/analyzer@0.44.0
  - @telorun/kernel@0.56.0
  - @telorun/sdk@0.56.0
  - @telorun/ide-support@0.7.4
  - @telorun/templating@0.11.0

## 0.55.0

### Patch Changes

- Updated dependencies [cae53b0]
  - @telorun/kernel@0.55.0

## 0.54.0

### Patch Changes

- Updated dependencies [942c176]
- Updated dependencies [adc8459]
- Updated dependencies [adc8459]
- Updated dependencies [adc8459]
  - @telorun/sdk@0.54.0
  - @telorun/kernel@0.54.0
  - @telorun/analyzer@0.43.0
  - @telorun/templating@0.11.0
  - @telorun/ide-support@0.7.3

## 0.53.0

### Patch Changes

- Updated dependencies [de6c2aa]
  - @telorun/kernel@0.53.0
  - @telorun/analyzer@0.42.0
  - @telorun/ide-support@0.7.2

## 0.52.0

### Minor Changes

- 84002d3: Remove the Telo module registry as a publish/discovery surface; the hub is now the discovery path.

  The `registry.telo.run` origin stays a read-only resolution source, so apps that
  import bare `namespace/name@version` refs keep resolving and running unchanged.
  `telo run` / `install` / `check` / `module` / `upgrade` are unaffected — they
  resolve and enumerate versions against the still-deployed origin. What is removed:

  - **`telo publish` targets OCI only.** A non-OCI (HTTP registry / bare-host)
    destination is rejected with a clear error; publish to `oci://host/repo`.
    `--registry` remains, used solely to resolve/pin dependencies read-only.
  - **`RegistryTransport.publish()` now throws** — the transport is read/resolve
    only. Resolution, cache placement, version listing, digest, and manifest
    hashing are unchanged.

### Patch Changes

- Updated dependencies [ab4a911]
- Updated dependencies [84002d3]
  - @telorun/templating@0.11.0
  - @telorun/kernel@0.52.0
  - @telorun/analyzer@0.41.1
  - @telorun/ide-support@0.7.1

## 0.51.2

### Patch Changes

- 2e1bb5c: Fix `telo publish` for OCI imports and directory arguments.

  - The pre-flight analysis loader now uses the kernel's transport sources (same
    chain as `telo check`), so a manifest whose `imports:` reference an `oci://`
    dependency — pinned (`#sha256-…`) or not — resolves for analysis instead of
    failing with `No source found for: oci://…`. Previously it used the analyzer's
    `defaultSources()` (HTTP + registry only), which owns no `oci://` scheme.
  - A directory argument now resolves to its `telo.yaml` (standard Telo path
    resolution, matching `run` / `check`), instead of failing with
    `Cannot read file: <dir>`.

- Updated dependencies [0c1c8fd]
- Updated dependencies [2e1bb5c]
  - @telorun/analyzer@0.41.0
  - @telorun/ide-support@0.7.0
  - @telorun/kernel@0.51.2

## 0.51.1

### Patch Changes

- Updated dependencies [bdc21e9]
  - @telorun/ide-support@0.6.0

## 0.51.0

### Minor Changes

- 6418e2a: `telo check` now resolves every import scheme the runtime does — `oci://`
  included — and reports locations as CWD-relative paths.

  `check` built its loader from the analyzer's browser-safe `defaultSources()`
  (HTTP + registry only), so an `oci://` import failed with "No source found for".
  It now uses the kernel's `defaultTransportRegistry(registryUrl).sources()` — the
  same origin-direct chain `install` / `run` use — so OCI resolves straight from
  the origin registry, never through the hub cache (the discovery plan's invariant:
  CLI resolution never routes through the hub; the `manifests.telo.sh` cache is the
  browser editor's read path only). A `--registry-url` option is added, matching
  the `--registry-url → TELO_REGISTRY_URL → https://registry.telo.run` fallback of
  `run` / `install` / `upgrade`.

  Diagnostic locations for on-disk manifests are now printed relative to the
  working directory (e.g. `examples/hello-world/telo.yaml:12:12`) instead of an
  absolute `file://` URL; genuine `http(s)://` sources stay absolute.

  `@telorun/kernel` gains a `./transports` subpath export (re-exporting
  `defaultTransportRegistry` and the transport registry) and a
  `./manifest-sources/local-file-source` subpath so a Node consumer can pull just
  the transport-resolution sources and the local-file source without the
  controller/bundler machinery the package root drags in. `telo check` and the VS
  Code host both import through these subpaths.

- 6418e2a: Surface broken `imports:` sources as structured diagnostics through one shared
  code path, so every host reports them identically.

  Import-resolution failures were collected into `LoadedGraph.errors` as raw
  `Error`s with no diagnostic code. Each host assembled its own diagnostic list
  from the graph, and they drifted: the CLI re-threw the first error as a bare
  message, while the VS Code extension dropped the channel entirely — a manifest
  with an unresolvable import showed **no** in-editor diagnostic.

  The channels split cleanly across two layers:

  - The analyzer owns the raw conversion: `importResolutionDiagnostics(graph)`
    turns `graph.errors` into coded `AnalysisDiagnostic`s — `INVALID_IMPORT_SOURCE`
    for a source no transport can ever resolve (e.g. `not-found@whatever`) and
    `IMPORT_UNRESOLVED` for a well-formed ref that failed to fetch (404, missing
    file). Each adopts the `{ filePath, path: "imports.<alias>" }` shape
    version-reconciliation diagnostics already use, so the shared `findPositions` /
    `resolveRange` routing anchors them on the offending import line with no
    host-specific code.
  - `@telorun/ide-support` owns the presentation policy:
    `assembleGraphDiagnostics(graph, analysis)` folds parse, version, import, and
    static analysis into one list and partitions out the cascade that would bury
    the real cause — the analysis diagnostics of any file that failed to parse
    **or** whose import failed to resolve (both have unreliable kind resolution).
    It returns `{ diagnostics, suppressed }`: hosts surface `diagnostics` and may
    render `suppressed` dimmed. The compromised-file set is exposed on its own as
    `compromisedFiles(graph)` so the multi-closure telo-editor applies the exact
    same policy the single-closure VS Code host does — the two show identical
    info. The CLI, VS Code extension, and telo-editor all route through this one
    source, so a channel can never again be surfaced by some hosts and forgotten
    by others.

  `GraphLoadError` gains `alias`, `source` (the author-written import string), and
  `sourceLine` to support precise anchoring and messages that quote what the
  author wrote rather than a resolved `file://` URL.

  `telo check` now renders import-resolution failures as coded diagnostics
  alongside everything else — with a file:line:col and code — instead of throwing
  the first as an uncoded message, and suppresses the secondary kind-resolution
  cascade a broken import would otherwise trigger.

- 6418e2a: `telo upgrade` now upgrades OCI imports and can follow relative imports
  recursively.

  Version enumeration, ref reconstruction, and integrity hashing during an
  upgrade are delegated to the transport that owns each ref's scheme, so every
  backend the kernel can resolve is also upgradeable. Previously the command used
  a registry-only ref classifier that skipped `oci://host/repo@tag` imports as
  "not a registry ref"; they are now bumped in place like registry refs. The
  `Transport` interface gains two methods for this — `refVersion(ref)` (the
  version segment currently named) and `withVersion(ref, version)` (the ref
  rewritten at a new version) — implemented by `RegistryTransport` and
  `OciTransport`.

  A new `--recursive` / `-r` flag follows relative (local) imports into their
  sibling manifests and upgrades those too. It is cycle-safe and upgrades each
  file at most once even when a sibling is reached from several manifests. Remote
  refs are always upgraded in place; recursion only descends into on-disk
  siblings. Without the flag, a relative import is reported skipped with a hint to
  use `--recursive`.

### Patch Changes

- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
- Updated dependencies [6418e2a]
  - @telorun/kernel@0.51.0
  - @telorun/analyzer@0.40.0
  - @telorun/ide-support@0.5.0

## 0.50.0

### Minor Changes

- c1fef72: Implement the structured logging specification (`kernel/specs/logging.md`).

  Records carry an OTel severity number, a message, structured attributes, the
  emitting resource's identity, its import-alias scope, and the active dispatch
  span's trace and span ids — all attached automatically. Controllers emit through
  the new ambient `ctx.log`.

  Logging is configured by a `logging:` block on the root `Telo.Application`:
  `level`, `attributes`, `redact`, `sampling`, and a `sinks:` list of ref-or-inline
  entries. `Telo.ConsoleSink` and `Telo.FileSink` are kernel built-ins resolvable
  without an import; omitting `sinks:` yields exactly one console sink, so the
  zero-config case stays "pretty on a terminal, JSON when piped". An `imports:`
  entry may carry its own `logging:` block to raise verbosity for that dependency's
  subtree; config cascades and may be narrowed at each hop. There is no
  `TELO_LOG_*` variable and no logging CLI flag — a level derived from the host
  environment goes through a `variables:` entry read with `!cel`.

  New `Telo.Sink` capability and `Telo.LogSink` abstract, so the sink set is open
  to the ecosystem: a third party ships a sink by publishing a module whose kind
  extends `Telo.LogSink`. The new `std/otlp` module does exactly that.

  Behaviour changes:

  - The CLI now honours `NO_COLOR` and implements the spec's full color-precedence
    order. `FORCE_COLOR=0` disables color rather than enabling it.
  - `TracePayload.spanId` / `parentSpanId` on the debug wire are now 16-character
    lowercase hex strings rather than numeric counters, matching the ids log
    records carry. The internal counter is unchanged; hex is rendered only at the
    encoding boundary and is salted per process so two services in one distributed
    trace cannot mint the same id.
  - `Http.Server`'s `logger:` field now means "enable request logging" rather than
    being a raw Fastify passthrough. Fastify's Pino instance is replaced with a
    Telo-backed adapter, so request records inherit the root `logging:` block's
    level, encoding, redaction, and sinks.
  - The kernel no longer writes diagnostics to `process.stderr` or `console.*`;
    everything routes through the logger. The ad-hoc `TELO_BUNDLE_DEBUG` env var is
    replaced by ordinary trace-level records.
  - `on_full: block` and invalid redaction paths are now caught by `telo check`
    (static analysis), not only at boot — `on_full: block` is unimplementable on a
    single-threaded runtime and a bad redaction path would otherwise silently fail
    to redact. Both remain enforced at runtime as a backstop.

  Two pre-existing bugs fixed along the way:

  - A CEL expression feeding **any** enum-constrained field produced a spurious
    `SCHEMA_VIOLATION`, because the placeholder substituted for the expression
    satisfied `type` but violated `enum`. Fixed in both the analyzer and the
    kernel.
  - `teardownResources` aborted the whole cascade on the first throwing resource,
    with no aggregation and no reporting. Failures are now collected into
    `ERR_TEARDOWN_FAILED` so one bad teardown cannot skip the rest — including the
    log sinks, which are pinned to tear down last.
  - The inline `imports:` desugaring silently dropped unknown entry fields, so a
    per-import `logging:` block never reached the import controller.

### Patch Changes

- Updated dependencies [c1fef72]
  - @telorun/sdk@0.50.0
  - @telorun/kernel@0.50.0
  - @telorun/analyzer@0.39.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.45

## 0.49.0

### Patch Changes

- Updated dependencies [2395a4a]
  - @telorun/sdk@0.49.0
  - @telorun/kernel@0.49.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1

## 0.48.0

### Minor Changes

- 0368e6f: Pin `oci://` imports on publish, restoring the integrity chain for OCI modules.

  `fetchManifestHash` recognised only bare registry refs and `http(s)` URLs, so an
  `oci://` import fell through to "cannot hash non-remote import" and `telo
publish` skipped it as best-effort-unresolved. Published OCI artifacts therefore
  carried unpinned dependencies, and the Merkle chain that makes an importer's
  hash transitively cover its dependencies stopped at the first OCI ref — leaving
  integrity to rest on registry trust alone, contrary to the inline hash being
  authoritative across transports.

  Hashing moves onto the `Transport` interface as `manifestHash(ref)`, so each
  transport hashes exactly what its own `read()` verifies — registry/HTTP the raw
  response bytes, OCI the UTF-8 encoding of the `telo.yaml` extracted from the tar
  layer — and a pin written at publish always matches at import. `fetchManifestHash`
  is now transport dispatch rather than a scheme chain.

  That placement is the actual fix. The bug was the failure mode of a caller-side
  `isRegistryRef`/`http(s)`/else chain: a ref whose scheme nobody had added a branch
  for degraded silently to best-effort-unresolved. A fourth transport would have
  reproduced it identically. Since `manifestHash` is required on the interface, one
  cannot now be added without deciding what it hashes.

### Patch Changes

- Updated dependencies [8af345f]
- Updated dependencies [8af345f]
- Updated dependencies [0368e6f]
- Updated dependencies [0368e6f]
- Updated dependencies [0368e6f]
- Updated dependencies [8af345f]
  - @telorun/kernel@0.48.0
  - @telorun/sdk@0.48.0
  - @telorun/analyzer@0.38.0
  - @telorun/templating@0.10.1
  - @telorun/ide-support@0.4.44

## 0.47.0

### Patch Changes

- Updated dependencies [ec524cd]
  - @telorun/analyzer@0.37.0
  - @telorun/kernel@0.47.0
  - @telorun/sdk@0.47.0
  - @telorun/ide-support@0.4.43
  - @telorun/templating@0.10.1

## 0.46.0

### Minor Changes

- bd4f3ac: Support direct `https://` module refs in the manifest-cache key contract. `analyzer` gains `isHttpsModuleRef` and `urlManifestCacheCoords(ref, version)` — a URL addresses one file whose version lives inside it, so the version is supplied by the caller rather than parsed from the ref; a trailing `telo.yaml` is dropped so the key doesn't duplicate the filename, and refs carrying a query or userinfo are rejected (both would let distinct URLs collide onto one key, or smuggle an authority). `telo module manifest --json` now emits a `cacheKey` for `https://` refs, built from the `metadata.version` the fetched manifest declares.

### Patch Changes

- Updated dependencies [bd4f3ac]
- Updated dependencies [bd4f3ac]
  - @telorun/kernel@0.46.0
  - @telorun/analyzer@0.36.0
  - @telorun/ide-support@0.4.42

## 0.45.0

### Minor Changes

- d88a397: Federated discovery, phase 1 — the ingest/search spine behind the telo hub.

  - **analyzer**: browser-safe `manifestCacheKey` / `manifestCacheUrl` /
    `ociManifestCacheCoords` helpers plus `ManifestCacheSource`, resolving
    `oci://` imports against the hub's static manifest cache
    (`manifests.telo.sh`) with `#sha256-…` verification for pinned refs. The OCI
    ref grammar (`parseOciRef` / `isOciRef` / `OCI_SCHEME`) moves here from the
    kernel so the tracker's write key and the editor's read key share one source
    of truth. The throws-coverage check now reads `when:` clauses written with
    the `!cel` tag (previously only the inline `${{ }}` string form parsed).
  - **kernel**: `Transport.digest(ref)` — a cheap content-identity digest per
    version (OCI: `Docker-Content-Digest` via HEAD; HTTP: hash of the
    `telo.yaml` bytes) so the discovery tracker can detect re-pushed tags
    without re-downloading. OCI `tags/list` now follows pagination `Link`
    headers. New `TELO_EGRESS=public-only` egress guard refuses transport
    fetches to private/loopback/link-local/CGNAT hosts (SSRF guard for
    deployments that fetch registered, attacker-suppliable refs).
  - **cli**: `telo module digest <ref>` (the digest verb the tracker records and
    re-checks), `telo module manifest --json` (emits `{ ref, cacheKey,
manifest }` with the shared cache key), and `telo search "<query>"` /
    `telo search --kinds` — a thin client of the hub's `/search/*` endpoints
    (`TELO_HUB_URL`, default `https://telo.sh`).

### Patch Changes

- Updated dependencies [56c810b]
- Updated dependencies [d88a397]
- Updated dependencies [d88a397]
  - @telorun/analyzer@0.35.0
  - @telorun/kernel@0.45.0
  - @telorun/ide-support@0.4.41

## 0.44.1

### Patch Changes

- Updated dependencies [cd3ec0b]
  - @telorun/analyzer@0.34.1
  - @telorun/kernel@0.44.1
  - @telorun/ide-support@0.4.40

## 0.44.0

### Patch Changes

- Updated dependencies [8c24da2]
  - @telorun/kernel@0.44.0
  - @telorun/analyzer@0.34.0
  - @telorun/sdk@0.44.0
  - @telorun/ide-support@0.4.39
  - @telorun/templating@0.10.1

## 0.43.0

### Minor Changes

- 3961e35: Add a `telo module` inspection command group — generic, transport-neutral verbs
  (the `npm view` / `docker manifest inspect` analog):

  - `versions <ref>` — published versions newest-first (`--json`); for a local
    path or direct URL it reports the single declared `metadata.version`.
  - `manifest <ref>` — the module's `telo.yaml`, verified against the inline hash
    when pinned.
  - `resources <ref>` — the resource instances declared in the manifest (`--json`).
  - `kinds <ref>` — the resource kinds the module defines: kind suffix, owning
    module, capability, export status, and description (`--json`). The prefix in a
    `kind:` field is the consumer's own import alias, so a kind's identity is
    reported as the `(module, name)` pair, not a fixed dotted string.

  Every verb resolves a ref uniformly across sources — a local path, a direct
  `https://` URL, a registry `ns/name[@ver]` ref, or an `oci://host/repo[@tag]`
  ref — dispatching through the existing `TransportRegistry` with no scheme
  branching. This is the read seam the federated-discovery hub's tracker consumes.

- 9a92bf1: Add a `Transport` abstraction that owns everything ref-scheme-specific about a
  module's lifecycle — manifest read, full-artifact fetch, cache path, version
  list, and publish — and ship two implementations behind it: the existing HTTP
  registry (`RegistryTransport`) and a new OCI transport (`OciTransport`). The
  loader, cache, `telo upgrade`, `telo install`, and `telo publish` no longer
  branch on ref shape; they ask the transport registry which transport owns a ref
  and delegate, so adding a backend is "implement one interface and register it."

  `OciTransport` resolves and publishes `oci://host/repo@version` modules to any
  OCI distribution registry (GHCR / ECR / Docker Hub / Harbor) over a hand-rolled
  minimal client — pull/push manifest + blob, the `WWW-Authenticate` token
  handshake, and the ambient Docker credential chain (`~/.docker/config.json` +
  `docker-credential-*`). A module is one artifact: a single tar blob carrying
  `telo.yaml` and the `files:` payload, pushed under a standard OCI artifact
  manifest (`artifactType: application/vnd.telo.module.v1+tar`).

  `telo publish` gains a destination-first positional — `telo publish
<destination?> <paths…>` — whose scheme selects the transport (`oci://` → OCI,
  `https://` / bare host → HTTP registry, omitted → the default registry). Bare
  `telo publish .` is unchanged. Relative sibling imports are canonicalized
  against the destination (OCI: via the destination repo; HTTP: the sibling's
  `<namespace>/<name>`), pinned to the sibling's own version, and every derived
  ref is verified to resolve at its published location before publishing.

  Telo's inline `#sha256-…` hash stays authoritative across transports: the
  manifest is verified against it and the payload against the manifest's
  `filesIntegrity`, the same Merkle chain regardless of backend. A tamper failure
  is a distinct `IntegrityError` (always terminal, never a best-effort skip). The
  `isRegistryRef` shape-test now rejects any `scheme://`, so an `oci://…` ref can
  never be misrouted to the default registry or a garbage cache path. The tar and
  `filesIntegrity` helpers moved from the CLI into the kernel so both transports
  share one implementation.

### Patch Changes

- Updated dependencies [3961e35]
- Updated dependencies [b5a325f]
- Updated dependencies [9a92bf1]
- Updated dependencies [9a92bf1]
  - @telorun/analyzer@0.33.0
  - @telorun/templating@0.10.1
  - @telorun/kernel@0.43.0
  - @telorun/ide-support@0.4.38

## 0.42.0

### Minor Changes

- 2ff9027: Add inline module integrity — remote imports may carry a `#sha256-<base64url>`
  fragment (or an `integrity:` sibling on the object form) that pins the fetched
  `telo.yaml` bytes. Every source `read()` (registry, HTTP, and the kernel's
  on-disk manifest cache) hashes the fetched bytes and fails the load on a
  mismatch — a terminal error, never a self-healing cache miss. A canonical
  `parseModuleRef`/`splitIntegrity` in the analyzer strips the fragment at every
  path-building site so it never pollutes fetch URLs or cache paths.

  Bundle modules (`files:` → `module.tar.gz`) pin their payload with a
  `filesIntegrity` field on the manifest — a canonical per-file content digest
  that `telo publish` writes and `extract` verifies before unpacking. Because the
  importer's hash covers the manifest, the payload is pinned transitively.

  `telo publish` pins each remote import to its dependency's hash (best-effort:
  unresolvable imports are warned, not fatal; `--frozen` makes them hard errors).
  `telo upgrade` re-pins on a version change and also pins already-current imports
  in place (so a rarely-changing module whose version never moves still gets a
  hash), both best-effort.

### Patch Changes

- Updated dependencies [b7d378a]
- Updated dependencies [2ff9027]
  - @telorun/kernel@0.42.0
  - @telorun/analyzer@0.32.0
  - @telorun/ide-support@0.4.37

## 0.41.0

### Patch Changes

- Updated dependencies [721a241]
- Updated dependencies [721a241]
  - @telorun/kernel@0.41.0
  - @telorun/sdk@0.41.0
  - @telorun/analyzer@0.31.0
  - @telorun/templating@0.10.0

## 0.40.2

### Patch Changes

- 36af5f5: Surface YAML parse failures as error diagnostics. A document that fails to
  parse (e.g. an unquoted scalar containing `: ` that the parser reads as a
  nested mapping) previously produced a mangled `toJSON()` projection that
  static analysis silently accepted — `telo check` reported "passed" while the
  registry rejected the same file on push. The loader now aggregates every
  file's YAML `parseErrors` into `LoadedGraph.parseDiagnostics` (fatal `Error`
  diagnostics carrying the parser's line/column range), surfaced by `telo check`
  / `telo publish` / the editor / VS Code and treated as fatal by the kernel at
  load.
- Updated dependencies [36af5f5]
  - @telorun/analyzer@0.31.0
  - @telorun/kernel@0.40.2
  - @telorun/ide-support@0.4.36

## 0.40.1

### Patch Changes

- Updated dependencies [5dd71ee]
  - @telorun/analyzer@0.30.1
  - @telorun/kernel@0.40.1
  - @telorun/ide-support@0.4.35

## 0.40.0

### Patch Changes

- Updated dependencies [4e5d861]
- Updated dependencies [2d9323c]
- Updated dependencies [4e5d861]
  - @telorun/kernel@0.40.0
  - @telorun/analyzer@0.30.0
  - @telorun/ide-support@0.4.34

## 0.39.1

### Patch Changes

- Updated dependencies [ef511d9]
  - @telorun/kernel@0.39.1

## 0.39.0

### Minor Changes

- d84a585: Give the `telorun/node` image a smart entrypoint, modeled on the official node image's `docker-entrypoint.sh`. It prepends `telo` only when the first argument is a flag (`-…`), an unknown command, or a non-executable file — so `docker run telorun/node ./telo.yaml` and `docker run telorun/node --watch ./telo.yaml` both reach the CLI, while `bash`, `sh`, and `node` still run verbatim as escape hatches. A derived image may write either the explicit `CMD ["telo", ".", "--watch"]` or the terse `CMD ["./telo.yaml"]` — both work; the bare image runs the CLI via the default `CMD ["telo"]`.

### Patch Changes

- d84a585: Honor `--no-cache-write` when fetching the on-demand debug UI for `--inspect`. Previously the bundle was always written into `TELO_CACHE_DIR`, so in the k8s runner — where `/telo-cache` is the baked, read-only deps cache and the workload runs with `--no-cache-write` — the cache write failed (`EROFS` / `ENOENT mkdir '/telo-cache/debug-ui'`) and the inspect UI came up unavailable. Under `--no-cache-write` the fetched bytes are now served in-memory via `DebugServer` and never touch disk.
- d84a585: Unify glob matching across the monorepo onto a single dependency-free engine in a new `@telorun/glob` package. It exports `selectByPatterns` (plus `HARD_IGNORE` / `DEFAULT_IGNORE` / `GLOB_PRUNE_DIRS`) as the one matcher used everywhere a `.gitignore`-style pattern set is resolved: `files:` bundling (`telo publish` + the editor run bundle), `include:` expansion (kernel `LocalFileSource` + the editor adapters), and test discovery (`@telorun/test`).

  This removes four divergent implementations — the kernel's `minimatch`, the editor's hand-rolled glob→regex, the test runner's own `globToRegex`, and an `ignore`-based pass — in favor of a small matcher implementing a documented **Telo glob** subset of gitignore. The subset and its exact behavior are pinned by a language-neutral conformance suite (`packages/glob/conformance/glob.json` + `README.md`) so any runtime (Node today; Rust / Go later) can reimplement it identically rather than chasing one library's quirks. The kernel drops `minimatch` and the CLI drops its direct `ignore` dependency; the matcher lives in its own package rather than the static analyzer, so consumers depend on it directly instead of reaching into `@telorun/analyzer` for a non-analysis primitive.

  The deny set is split into a non-overridable **hard** tier (`node_modules`/`.git`/`.telo`) and a soft, opt-out-able tier (`.telobundle.*`). `applyDefaultIgnore: false` (used by `include:` resolution to reach co-located partials) now only skips the soft tier — a broad `**` `include:` can no longer recurse into the manifest cache, and resolves identically in the kernel and the editor.

- Updated dependencies [ebca26a]
- Updated dependencies [d84a585]
  - @telorun/analyzer@0.29.0
  - @telorun/kernel@0.39.0
  - @telorun/glob@0.2.0
  - @telorun/ide-support@0.4.33

## 0.38.0

### Patch Changes

- Updated dependencies [a9ac4ba]
- Updated dependencies [a125804]
  - @telorun/sdk@0.38.0
  - @telorun/analyzer@0.28.1
  - @telorun/kernel@0.38.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.32

## 0.37.0

### Minor Changes

- 5ea5ff3: Reconcile module versions to one version per identity within an import graph.

  When the same `<namespace>/<module-name>` is reached at multiple versions (a diamond import), the loader now collapses them onto a single version before any controller, definition, or kind is registered — fixing the spurious `DUPLICATE_IMPORT_ALIAS` and the silent last-writer-wins controller collision that two versions of one module previously caused.

  - Same major → the highest version wins (a non-lossy hoist given the additive-only pre-1.0 policy), reported as a `MODULE_VERSION_HOISTED` warning on the lower-version import line.
  - Different major → a fatal `MODULE_VERSION_CONFLICT`; `telo run` refuses to start and `telo check` errors.
  - Same version from two sources with differing content → a `MODULE_VERSION_HOISTED` warning; identical content is deduplicated silently.

  Reconciliation lives in the shared analyzer loader, so `telo check`, the kernel runtime, and the editor all resolve the same single version. `LoadedGraph` gains `overrides` and `versionDiagnostics`.

### Patch Changes

- 5ea5ff3: Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

  `new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

  This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.

- Updated dependencies [5ea5ff3]
- Updated dependencies [5ea5ff3]
  - @telorun/analyzer@0.28.0
  - @telorun/kernel@0.37.0
  - @telorun/ide-support@0.4.31

## 0.36.0

### Patch Changes

- Updated dependencies [dded615]
  - @telorun/kernel@0.36.0
  - @telorun/sdk@0.36.0
  - @telorun/analyzer@0.27.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.30

## 0.35.0

### Minor Changes

- 12f6d6f: Add `files:` for bundling static assets into a published module. A `Telo.Application` or `Telo.Library` may declare a `files:` list of ordered, `.gitignore`-style patterns (matched with the `ignore` engine: positive patterns opt in, `!` patterns carve out, last-match-wins). When present, `telo publish` packs `telo.yaml` plus the selected files into a `module.tar.gz` and PUTs it to the registry; `telo install` / `telo run` extract that archive into the local cache next to the cached `telo.yaml`, so a relative `Http.Static` `root:` (e.g. a built SPA in `./public`) resolves on the consumer exactly as it does in development. An always-on ignore set (`node_modules/`, `.git/`, `.telo/`, `.telobundle.*`) is never shipped. The CLI's `include:` resolver moves from `minimatch` to the same `ignore` engine.

### Patch Changes

- Updated dependencies [12f6d6f]
  - @telorun/analyzer@0.26.0
  - @telorun/kernel@0.35.0
  - @telorun/ide-support@0.4.29

## 0.34.0

### Patch Changes

- Updated dependencies [d7fda97]
  - @telorun/sdk@0.34.0
  - @telorun/analyzer@0.25.0
  - @telorun/kernel@0.34.0
  - @telorun/templating@0.10.0
  - @telorun/ide-support@0.4.28

## 0.33.0

### Patch Changes

- Updated dependencies [95f168e]
- Updated dependencies [95f168e]
  - @telorun/kernel@0.33.0
  - @telorun/sdk@0.33.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.32.0

### Patch Changes

- Updated dependencies [a8c99ab]
  - @telorun/sdk@0.32.0
  - @telorun/kernel@0.32.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.31.0

### Patch Changes

- b41012f: cli: two debug event serializer fixes.

  - The serializer no longer mislabels a **shared reference** as `[Circular]`. `toWire`'s cycle detection is now path-scoped (a value is "circular" only while it's an ancestor on the current descent), so an object reachable by two sibling paths — a DAG, common in invocation `inputs` where a sub-value is shared — serializes fully. Genuine cycles still collapse to `[Circular]`.
  - A **bigint** now serializes as a plain number when it fits a JS safe integer (CEL models small integers as bigint, so `${{ size(x) }}` reads as `3`, not `[BigInt 3]`), falling back to its decimal digits as a string for out-of-range values so no precision is lost.

- Updated dependencies [b41012f]
- Updated dependencies [b41012f]
  - @telorun/kernel@0.31.0
  - @telorun/sdk@0.31.0
  - @telorun/analyzer@0.24.1
  - @telorun/templating@0.10.0

## 0.30.2

### Patch Changes

- Updated dependencies [912044a]
  - @telorun/kernel@0.30.2

## 0.30.1

### Patch Changes

- b1dd65c: Inspect debug UI: surface an explicit failure (including the exact fetch URL and HTTP status / error) when the on-demand UI bundle can't be resolved or fetched, instead of a generic "not available" notice — the reason is shown in the endpoint's 503 and logged at startup. Add a `TELO_DEBUG_UI_VERSION` override so the version to fetch can be set when the CLI manifest doesn't carry a concrete one (e.g. container images built via `pnpm deploy`, where `workspace:*` isn't rewritten).
- Updated dependencies [0c16f41]
  - @telorun/templating@0.10.0
  - @telorun/analyzer@0.24.1
  - @telorun/kernel@0.30.1
  - @telorun/ide-support@0.4.27

## 0.30.0

### Patch Changes

- Updated dependencies [aaa760d]
- Updated dependencies [aaa760d]
- Updated dependencies [cce2caa]
  - @telorun/analyzer@0.24.0
  - @telorun/templating@0.9.0
  - @telorun/kernel@0.30.0
  - @telorun/ide-support@0.4.26

## 0.29.0

### Patch Changes

- Updated dependencies [b4e6ac8]
  - @telorun/kernel@0.29.0

## 0.28.0

### Minor Changes

- d59e847: Debug stream now carries **logs as well as events**, and the editor embeds the
  debug UI.

  - New `@telorun/debug-wire` package: the language-neutral frame contract shared
    by the producer, the runner, the editor, and the debug UI. A stream now carries
    two discriminated frame kinds on one channel — `kind: "event"` (kernel events)
    and `kind: "log"` (one stdout/stderr line). Browser-safe; `wire-schema.json` is
    the source of truth a non-TypeScript producer conforms to. `@telorun/debug-ui`
    re-exports its types.
  - `@telorun/cli`: `--inspect` / `--debug` now tee the run's stdout/stderr into the
    stream as `log` frames (the terminal is untouched; the tee is restored on stop).
    The inspect server adds permissive CORS so an embedding webview can read it.
  - `@telorun/debug-ui`: the watcher is now a **Logs / Events** tab split over one
    frame stream (`DebugPanel` + `LogView`); `DebugWatcher` wraps it for the
    standalone app. `connectDebugStream` delivers `DebugFrame`s routed by `kind`.
    Components take a `theme` prop (`"light" | "dark" | "system"`, default
    `"system"` — follows `prefers-color-scheme` live); `DebugPanel` also takes a
    `logsSlot` (an embedding host can render its own interactive terminal in the
    Logs tab) and a `defaultTab`. When **no** `theme` is supplied the panel owns
    its mode and shows a system/light/dark toggle in its header; when a host
    passes `theme`, the host owns it and the toggle is hidden.

  The editor (private) embeds `DebugPanel` in the run view's Debug tab: remote
  HTTP/k8s runners relay frames over the existing `/v1/sessions/:id/events`
  transport (the security/ingress boundary), while the local runner reads the
  workload's loopback `--inspect` port directly — both surface identical `debug`
  run events. Blob payloads aren't resolvable in the editor embed yet (the
  workload's blob endpoint isn't reachable from the editor); events and logs work.

- d59e847: Debug UI now links to the running application's exposed ports.

  - `@telorun/debug-ui`: `DebugPanel` takes an `endpoints` prop and renders each as
    a link in its header (tcp → clickable `http://host:port`, udp → plain label).
    New `AppEndpoint` type + `endpointHref` / `endpointLabel` helpers (browser-safe,
    no runner/kernel dependency). The standalone `DebugWatcher` sources endpoints
    from the producer's `/json/version` handshake, filling a blank host from the
    page origin so the link points where the viewer reached the server (localhost
    locally, the bound host remotely).
  - `@telorun/kernel`: new `Kernel.getResolvedPorts()` — the root Application's
    resolved `ports:` (integer + declared protocol per name), available after
    `load()`. Empty when the root declares no ports.
  - `@telorun/cli`: the `--inspect` server advertises the app's resolved ports as
    `appEndpoints` in its `/json/version` handshake. The UI now opens once the
    ports are known (deferred from server start to first load), so the discovery
    handshake already carries the endpoints.

  The editor (private) renders the same links inside `DebugPanel` from its resolved
  run endpoints, replacing the separate chips in the run-view header.

### Patch Changes

- Updated dependencies [d59e847]
- Updated dependencies [d59e847]
  - @telorun/analyzer@0.23.2
  - @telorun/kernel@0.28.0
  - @telorun/ide-support@0.4.25

## 0.27.0

### Minor Changes

- 9ef48a6: Add a live debug-event inspection UI. `telo run --inspect` starts a
  localhost-only inspection endpoint and prints its URL — a single page that
  watches the kernel event stream in real time (SSE), with text/kind/suffix
  filtering, expandable payloads, pause, and replay of events that fired before
  the page was opened. (`--debug` independently writes the `.telo.debug.jsonl`
  event log; the two compose. See the `--inspect` flag set for delivery details.)

  New `@telorun/debug-ui` package: the browser-safe, runtime-agnostic consumer
  surface — the debug wire-format types + JSON Schema, filter logic, an SSE client,
  and React components (incl. the standalone app served by the inspection server).
  It has no Node-only dependency so it also runs in the editor webview.

  Binary payloads (images and any other file kind) are not inlined: the producer
  offloads each `Uint8Array`/`Buffer` to an in-memory, content-addressed LRU blob
  store and emits a small `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }`
  pointer in its place (the key it sits under is preserved). The `DebugServer`
  serves the bytes at `GET /blobs/:id`; the UI renders `image/*` inline and other
  types as download links. Content addressing dedupes repeated buffers (e.g. a
  redraw loop).

  The producer (serializer + `DebugServer` + blob store) stays Node-side in the
  CLI; the cross-runtime contract is the wire format
  (`@telorun/debug-ui/wire-schema.json`), so a future Rust/Go kernel can serve the
  same UI by conforming to it. The inspection server binds `127.0.0.1` and is
  `unref`'d, so a one-shot `--inspect` run still exits normally.

- 9ef48a6: Ship the debug UI on demand instead of bundling it in the CLI, and give the
  inspection endpoint its own composable flag set.

  - `telo run --inspect[=[host:]port]` starts the live inspection endpoint
    (default `127.0.0.1:9230`; non-loopback binds print a security warning) and
    serves the UI same-origin, with a `/json/version` discovery handshake.
    `--no-open` suppresses auto-opening the browser. `--debug` is a separate,
    composable flag that writes only the `.telo.debug.jsonl` event log (no network,
    no UI).
  - The CLI does not bundle `@telorun/debug-ui` (it's a `devDependency`). The UI is
    fetched on demand from npm via jsDelivr and cached under the `.telo` cache
    root; in the monorepo it resolves from the workspace, so local builds are
    testable offline. `TELO_DEBUG_UI_PATH` overrides the bundle path; `TELO_DEBUG_UI_URL`
    overrides the CDN base.
  - `@telorun/debug-ui` builds a self-contained single-file bundle
    (`app-single/index.html`) alongside `app-dist/`.

### Patch Changes

- 9ef48a6: Move the `--debug` event log out of the kernel into the CLI. The kernel no
  longer monkeypatches `EventBus.emit` with an always-installed streaming wrapper;
  debugging is now a plain `kernel.on("*", …)` subscriber (`DebugEventSubscriber`,
  attached by the CLI only when `--debug` is set). A normal run registers no `*`
  listener, so the event bus carries zero added overhead.

  Serialization is cycle- and value-safe and logs only plain data. Stream-bearing
  payloads (e.g. an Invocable's `{ outputs: { output: Stream } }`) whose
  async-generator closures form reference cycles previously threw `cannot serialize
cyclic structures` and dropped the event. Live runtime objects — a resolved
  `!ref` is a controller instance whose `.ctx` back-references the whole Kernel —
  previously serialized into multi-megabyte heap dumps. Now: a resolved `!ref`
  renders as the `{ kind, name }` reference it stands for; every other live object
  collapses to a one-token `[ClassName]` / `[Stream]` / `[Circular]` marker;
  object/array literals still log in full.

  BREAKING (kernel public API): `EventStream`, `Kernel.enableEventStream`,
  `Kernel.disableEventStream`, and `Kernel.getEventStream` are removed. The CLI was
  the only consumer.

- 9ef48a6: Fix `telo run --watch --inspect` dropping the debug UI on every reload. The
  inspection server is now created once per session and the rebuilt kernel
  re-attaches to it each cycle, so the browser's SSE connection (and replay buffer
  - JSONL) survive reloads instead of the UI showing the process as terminated.
- Updated dependencies [9ef48a6]
- Updated dependencies [9ef48a6]
  - @telorun/kernel@0.27.0

## 0.26.1

### Patch Changes

- Updated dependencies [5973024]
- Updated dependencies [a592710]
  - @telorun/analyzer@0.23.1
  - @telorun/kernel@0.26.1
  - @telorun/ide-support@0.4.24

## 0.26.0

### Minor Changes

- 1ddd803: Add a single, threaded cache-root resolution and a read-only cache mode for ephemeral runs.

  - **`TELO_CACHE_DIR` reinstated** as the override for the `.telo` cache root, resolved once per load via the new `resolveCacheRoot(entryUrl)` and threaded to the manifest cache, compiled validators, analysis stamp, and npm install root — no consumer re-derives it or reads the env independently. `Kernel.load` gains a `cacheDir` option so a CLI caller resolves it once and the kernel reads no env.
  - **`telo run --no-cache-write`** (kernel `writeCache: false`) keeps the cache read-only: baked validators/manifests are still loaded, anything uncached validates in-memory, and nothing is persisted — so a read-only, ephemeral session rootfs validates without touching (or failing to write) the cache. Validation errors still surface normally.
  - **SDK**: `ResourceContext` gains `getInstallRoot()`, the threaded npm install root, so controllers honour a relocated cache root.

### Patch Changes

- Updated dependencies [1ddd803]
  - @telorun/kernel@0.26.0
  - @telorun/sdk@0.26.0
  - @telorun/analyzer@0.23.0
  - @telorun/templating@0.8.0

## 0.25.0

### Patch Changes

- 206cf98: fix(cli): restore `telo run --watch`

  Watch mode was inert — its file watching and reload were stubbed out against
  two kernel methods (`getSourceFiles`, `reloadSource`) that no longer exist.
  Reimplement it as a full-restart loop: load → derive the graph's local files
  (entry, `include:` partials, imported libraries) → start (held alive so
  one-shot apps don't exit) → reload on any change by cancelling and tearing the
  kernel down, then rebuilding. Load/boot failures are reported as diagnostics
  and watch keeps running so the next edit retries. The watcher set is persistent
  across reloads (one long-lived `fs.watch` per file) rather than torn down and
  recreated each cycle — under bun, re-`fs.watch`-ing a just-closed path never
  fires again, which limited reloads to exactly one.

- Updated dependencies [c89e79b]
- Updated dependencies [c89e79b]
- Updated dependencies [1098ad0]
- Updated dependencies [4794671]
  - @telorun/kernel@0.25.0
  - @telorun/analyzer@0.23.0
  - @telorun/ide-support@0.4.23

## 0.24.2

### Patch Changes

- 004a848: Warm analysis caches at `telo install` time so a prebuilt image boots without re-deriving them.

  `kernel.load` now accepts an `analyzeOnly` option that runs the static-analysis pre-flight and persists its caches (the `.validated.json` analysis stamp and the compiled `__validators/` schema cache) but stops before module instantiation, target wiring, and application-env resolution. It also pre-compiles the application-env residual validators (`variables`/`secrets`/`ports`), which the runtime would otherwise recompile on every boot. `telo install` invokes this offline `kernel.load` to bake the caches onto a writable filesystem, so the runtime `load()` on a read-only session rootfs hits the stamp and skips the validation walk instead of failing to persist the caches (EROFS/ENOENT) on every boot.

- Updated dependencies [004a848]
  - @telorun/kernel@0.24.2

## 0.24.1

### Patch Changes

- Updated dependencies [9a305e6]
  - @telorun/kernel@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [ee8926f]
- Updated dependencies [ee8926f]
  - @telorun/kernel@0.24.0
  - @telorun/templating@0.8.0
  - @telorun/analyzer@0.22.0
  - @telorun/ide-support@0.4.22

## 0.23.0

### Patch Changes

- Updated dependencies [8586b39]
- Updated dependencies [2292a84]
  - @telorun/kernel@0.23.0
  - @telorun/analyzer@0.21.0
  - @telorun/sdk@0.23.0
  - @telorun/templating@0.7.0
  - @telorun/ide-support@0.4.21

## 0.22.0

### Minor Changes

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

### Patch Changes

- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
- Updated dependencies [06cfcbf]
  - @telorun/kernel@0.22.0
  - @telorun/analyzer@0.20.0
  - @telorun/templating@0.6.0
  - @telorun/ide-support@0.4.20

## 0.21.0

### Patch Changes

- Updated dependencies [64debb5]
  - @telorun/templating@0.5.0
  - @telorun/sdk@0.21.0
  - @telorun/analyzer@0.19.1
  - @telorun/kernel@0.21.0
  - @telorun/ide-support@0.4.19

## 0.20.1

### Patch Changes

- Updated dependencies [81ebf47]
- Updated dependencies [ea57e10]
- Updated dependencies [81ebf47]
  - @telorun/analyzer@0.19.0
  - @telorun/kernel@0.20.1
  - @telorun/ide-support@0.4.18

## 0.20.0

### Patch Changes

- Updated dependencies [2864c4d]
  - @telorun/kernel@0.20.0

## 0.19.0

### Minor Changes

- 5331205: Add cooperative invoke cancellation via an out-of-band `InvokeContext`.

  Every `invoke(inputs, ctx?)` now receives a second argument carrying a read-only
  cancellation token (`ctx.cancellation`): poll `isCancelled`, subscribe via
  `onCancelled`, bail with `throwIfCancelled`, or hand its `signal` to a Web API.
  The SDK exposes the source/token split (`createCancellationSource`,
  `CancellationSource`/`CancellationToken`), a never-cancellable sentinel, and the
  `isCancellationError` helper. Deadlines are scheduled cancellation
  (`source.cancelAt(epochMs)` / `cancelAfter(ms)`).

  The kernel mints one cancellation scope per invocation tree (inherited by nested
  invokes via a kernel-internal `AsyncLocalStorage`, always passed to controllers
  as the explicit argument), refuses a not-yet-dispatched invoke whose tree was
  cancelled with `ERR_INVOKE_CANCELLED`, and emits a scoped `InvokeCancelled`
  event. `Kernel.invoke(ref, inputs, opts?)` accepts `{ signal, deadlineAt }`.
  Sources are allocated lazily, so invokes that never touch cancellation pay no
  extra allocation.

  The boot `targets` run is also cancellable: `Runnable.run(ctx?)` now receives
  the token, `Kernel.cancel(reason?)` cancels the boot scope, and the CLI's
  SIGINT/SIGTERM handler calls it so Ctrl-C cooperatively stops honoring targets
  and in-flight invoke trees (then unblocks graceful exit via `forceIdle`).

  Honoring leaves: `Ai.Text` / `Ai.TextStream` / `Ai.Agent` forward the token's
  signal into the model (aborting a live LLM stream on cancel); `http-client`
  merges it with its request timeout. Triggers: `http-server` cancels on client
  disconnect and returns 499; `lambda` arms cancellation at the AWS deadline.

### Patch Changes

- Updated dependencies [5331205]
  - @telorun/sdk@0.19.0
  - @telorun/kernel@0.19.0
  - @telorun/analyzer@0.18.0
  - @telorun/templating@0.4.1

## 0.18.0

### Patch Changes

- Updated dependencies [d2294de]
  - @telorun/analyzer@0.18.0
  - @telorun/sdk@0.18.0
  - @telorun/kernel@0.18.0
  - @telorun/ide-support@0.4.17
  - @telorun/templating@0.4.1

## 0.17.3

### Patch Changes

- Updated dependencies [69a0a8d]
  - @telorun/analyzer@0.17.0
  - @telorun/kernel@0.17.3
  - @telorun/ide-support@0.4.16

## 0.17.2

### Patch Changes

- 0505e9b: cli + ide-support: operate on the inline `imports:` map instead of standalone `Telo.Import` documents

  `telo upgrade` and `telo publish` now read and rewrite import sources from the
  `imports:` map on the `Telo.Application` / `Telo.Library` doc, covering both the
  scalar shorthand (`Alias: <src>`) and the object form (`Alias: { source: <src>, … }`).
  Standalone `Telo.Import` document handling is dropped from both commands. `upgrade`
  keeps its byte-level splice (quote style, comments, and folded block scalars are
  preserved); `publish` canonicalizes relative `imports:` sources to
  `<namespace>/<name>@<version>` and now loads the pre-flight analysis graph with
  `desugarImports` so inline imports resolve during static validation. `telo install`
  likewise loads its graph with `desugarImports`, so transitive inline imports are
  discovered, cached, and analyzed.

  ide-support source autocomplete fires on `imports:` entries (scalar value or the
  `source:` under the object form), gated on the enclosing path so unrelated `source:`
  fields never trigger it. `Telo.Import` is removed from the no-registry kind
  completion fallback.

- Updated dependencies [0505e9b]
  - @telorun/ide-support@0.4.15

## 0.17.1

### Patch Changes

- Updated dependencies [c1432a6]
  - @telorun/analyzer@0.16.1
  - @telorun/kernel@0.17.1
  - @telorun/ide-support@0.4.14

## 0.17.0

### Patch Changes

- 0cd36a1: inline imports — `imports:` map on Telo.Application / Telo.Library

  Add an optional name-keyed `imports:` map to `Telo.Application` and
  `Telo.Library` as additive sugar for separate `Telo.Import` documents. Each
  entry's key is the PascalCase alias; its value is either a bare source string
  (`Console: std/console@1.2.3`, shorthand for `{ source }`) or the full object
  form carrying `variables` / `secrets` / `runtime`. Authored `Telo.Import`
  documents keep working unchanged and both forms may coexist.

  The loader desugars inline entries into synthetic `Telo.Import` manifests via a
  new `desugarImports` `LoadOptions` flag (folded into the file cache key; mirrored
  on the SDK's `ResourceContext.loadModule` options). The flag is on for every
  resolved consumer — the kernel's analysis and runtime loads, the
  import-controller's child-module load, the analyzer, `telo check`, and the
  `Assert.Manifest` test helper — and off for the editor's round-trip view, which
  reads the raw `imports:` map and pairs manifests to YAML nodes by index. Inline
  imports therefore resolve and execute identically to authored docs.

  Adds a `DUPLICATE_IMPORT_ALIAS` diagnostic: an alias declared twice in one
  module scope (across either form) is now an error instead of silently
  shadowing.

- Updated dependencies [0cd36a1]
  - @telorun/analyzer@0.16.0
  - @telorun/kernel@0.17.0
  - @telorun/sdk@0.17.0
  - @telorun/ide-support@0.4.13
  - @telorun/templating@0.4.1

## 0.16.1

### Patch Changes

- Updated dependencies [acb8996]
  - @telorun/kernel@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [55b4ec5]
- Updated dependencies [adc248b]
  - @telorun/analyzer@0.15.0
  - @telorun/kernel@0.16.0
  - @telorun/sdk@0.16.0
  - @telorun/templating@0.4.1
  - @telorun/ide-support@0.4.12

## 0.15.0

### Patch Changes

- Updated dependencies [ae0bf77]
- Updated dependencies [222b3d6]
  - @telorun/sdk@0.13.0
  - @telorun/kernel@0.15.0
  - @telorun/analyzer@0.14.0
  - @telorun/templating@0.4.0
  - @telorun/ide-support@0.4.11

## 0.14.0

### Patch Changes

- Updated dependencies [bfe4967]
- Updated dependencies [1c37ee1]
  - @telorun/kernel@0.14.0
  - @telorun/analyzer@0.13.0
  - @telorun/templating@0.3.1
  - @telorun/ide-support@0.4.10

## 0.13.2

### Patch Changes

- Updated dependencies [6ce1a52]
- Updated dependencies [6ce1a52]
  - @telorun/analyzer@0.12.1
  - @telorun/kernel@0.13.2
  - @telorun/ide-support@0.4.9

## 0.13.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.13.0

### Minor Changes

- f3e5fbc: Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

  - **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
  - **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
  - **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.

- 768f5d7: Add `telo upgrade <paths..>` — scans the given manifest files for `Telo.Import` declarations whose `source` is a registry ref (`<namespace>/<name>@<version>`), queries the registry for the latest published version, and rewrites the source in place when a newer version is available.

  The command uses the same registry-URL fallback as `install` / `run` (`--registry-url` flag > `TELO_REGISTRY_URL` > `https://registry.telo.run`). Pre-release versions are excluded by default; pass `--include-prerelease` to consider them. `--dry-run` reports the proposed upgrades without touching the file.

  Non-registry sources (relative paths, HTTP URLs) and unparseable versions are skipped with a notice rather than treated as errors.

### Patch Changes

- Updated dependencies [c0129c0]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.8

- Updated dependencies [0331069]
- Updated dependencies [0331069]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.7

- Updated dependencies [77c1c86]
- Updated dependencies [7889023]

  - @telorun/analyzer@0.12.0
  - @telorun/templating@0.3.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.6

- Updated dependencies [f3e5fbc]
- Updated dependencies [f3e5fbc]

  - @telorun/analyzer@0.12.0
  - @telorun/kernel@0.13.0
  - @telorun/ide-support@0.4.5

- 3e3f134: Migrate Docker image publishing to a per-runtime-repo scheme with variant + multi-arch tagging.

  **Kernel image** moves from `telorun/telo` to `telorun/node`, reserving the namespace for future polyglot kernels (`telorun/rust`, `telorun/go`). The previous monolithic image is split into four variants per release:

  - `telorun/node:<v>` / `telorun/node:<v>-slim` — lean variants, no Rust toolchain.
  - `telorun/node:<v>-rust-<rust-version>` / `telorun/node:<v>-rust-<rust-version>-slim` — opt-in Rust toolchain layered on top.

  Rolling tags (`latest`, `<major>`, `<major>.<minor>`) compose with the variant suffixes. Release tags are immutable; pin to exact versions for reproducible builds. Release images are multi-arch (`linux/amd64` + `linux/arm64`). Dev tags (`sha-<short>-*`) appear on every main-branch push, slim variants only.

  **Lambda base images** newly published as `telorun/lambda-node-managed:<lambda-version>` (managed nodejs runtime) and `telorun/lambda-node-custom:<lambda-version>` (custom `provided.al2023` runtime). Both pre-install `@telorun/lambda` and its workspace deps at `${LAMBDA_TASK_ROOT}`; user images derive from them and add only their manifest + install root. The `-node-` segment in the repo name reserves the namespace for future `telorun/lambda-rust-*` images.

  **CI**: docker publishing now runs from `.github/workflows/publish-docker.yml`, called by `publish.yml` after `changesets/action` actually publishes packages. Per-image gating reads `outputs.publishedPackages` so kernel images rebuild only when `@telorun/cli` bumps and lambda images only when `@telorun/lambda` bumps.

- Updated dependencies [39aef08]

  - @telorun/kernel@0.13.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.4

- Updated dependencies [849f57a]
- Updated dependencies [e411584]
- Updated dependencies [e411584]
- Updated dependencies [be79957]
  - @telorun/kernel@0.13.0
  - @telorun/sdk@0.12.0
  - @telorun/analyzer@0.12.0
  - @telorun/ide-support@0.4.3
  - @telorun/templating@0.3.0

## 0.12.0

### Patch Changes

- Updated dependencies [67a9b31]
- Updated dependencies [0f80fc5]
  - @telorun/kernel@0.12.0
  - @telorun/analyzer@0.11.0
  - @telorun/ide-support@0.4.2

## 0.11.1

### Patch Changes

- Updated dependencies [58362c4]
- Updated dependencies [58362c4]
  - @telorun/kernel@0.11.1
  - @telorun/sdk@0.11.1
  - @telorun/analyzer@0.10.1
  - @telorun/templating@0.2.3
  - @telorun/ide-support@0.4.1

## 0.11.0

### Minor Changes

- f61b36a: `telo install` now also persists every imported manifest's YAML to `<entry-dir>/.telo/manifests/` (registry refs under `<namespace>/<name>/<version>/telo.yaml`, HTTP imports under `__http/<host>/<pathname>`). `telo run` registers a new `LocalManifestCacheSource` ahead of the registry / HTTP sources, so production images that ran `telo install` at build time boot with zero registry network I/O — fixing the self-bootstrap loop in the registry image and unblocking air-gapped deploys. Cache misses fall through to the network source transparently; dev runs without a prior install are unchanged. New CLI flag `telo install --registry-url <url>` mirrors `telo run` for consistency.

  The reader and writer share a single URL→path function so direct-URL imports of a registry-served manifest (`source: https://registry.telo.run/...`) hit the same cache file as the corresponding `source: namespace/name@version` ref. HTTP URLs with a query string or fragment are disambiguated with a 12-char content hash on the filename so two different manifests never collide. All cache paths are validated to stay under the cache root, guarding against `..` segments in module refs.

  - `@telorun/kernel`: adds `LocalManifestCacheSource`, `writeManifestCache`, `cachePathForCanonical`, and `resolveEntryDir` exports.
  - `@telorun/cli`: `telo install` writes the manifest cache; `telo run` registers the cache source; new `--registry-url` flag on `telo install`.

### Patch Changes

- Updated dependencies [d9df589]
- Updated dependencies [f61b36a]
- Updated dependencies [65647e0]
  - @telorun/ide-support@0.4.0
  - @telorun/kernel@0.11.0
  - @telorun/analyzer@0.10.0

## 0.10.0

### Patch Changes

- 5c49834: Loader returns the canonical load result; editor stops re-parsing.

  The analyzer's `Loader` now produces a single `LoadedFile` / `LoadedModule` / `LoadedGraph` that carries text, parsed `yaml.Document` ASTs, manifests, position metadata, and canonical identity together. Hosts consume the same parse — the editor no longer runs a parallel YAML pipeline, the VS Code extension and CLI no longer read positions from non-enumerable manifest metadata, and the kernel uses the same primitive for static analysis and runtime entry loads.

  **Breaking changes** in `@telorun/analyzer`. The deprecated methods are removed in this release rather than kept as shims:

  - `Loader.loadModule(url, opts)` now returns `LoadedModule` (was `ResourceManifest[]`).
  - `Loader.loadModuleGraph` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadManifests` removed — use `loadGraph` + `flattenForAnalyzer`.
  - `Loader.loadModuleForFile` legacy shape removed; the replacement is `loadGraphForFile(url) → { graph, ownerUrl } | null`.
  - `attachPositionIndex` (the non-enumerable-metadata helper) removed; positions live on `LoadedFile.positions` and consumers look them up via `findPositions(graph, …)` from `@telorun/ide-support`.
  - `LoadedGraph.importEdges` is now `Map<string, Map<string, ImportEdge>>` carrying `{targetSource, targetModuleName, targetNamespace}` rather than a bare target URL — `flattenForAnalyzer` reads library identity off the edge directly instead of re-deriving from manifest metadata.

  **New surface**:

  - `parseLoadedFile(source, requestedUrl, text, opts?)` — pure, I/O-free parse primitive shared between the editor's source-view debounce and the loader's `read()` post-processing.
  - `Loader.loadFile(url, opts?)`, `Loader.loadGraph(entry, opts?)`, `Loader.loadGraphForFile(fileUrl)` — new methods returning the canonical types.
  - `flattenForAnalyzer(graph)` and `flattenLoadedModule(mod)` — produce the flat `ResourceManifest[]` `analyze()` consumes (graph-wide vs. single-module).
  - `@telorun/ide-support`: `findPositions(graph, diagnosticData)` returns `{file, positionIndex?, sourceLine?}` and replaces every host's hand-rolled "look up the file owning this diagnostic + its positions" loops.

  **Internal effects**:

  - `@telorun/cli`: migrated `check`, `install`, and `publish` to the new API; `formatAnalysisDiagnostics` takes a `LoadedGraph`.
  - `@telorun/kernel`: the kernel's facade methods (`loadModule`, `loadManifests`) preserve their `ResourceManifest[]` API so module controllers don't need to migrate; internally they project from the new types via `flattenForAnalyzer` / `flattenLoadedModule`.
  - The editor's `ModuleDocument` collapses to `{filePath, loaded: LoadedFile, dirty: boolean}`; the previous parallel `parseModuleDocument` pipeline (`text` / `docs` / `loadedJson` / `parseError` snapshots, in-memory adapter, chained adapter, populate/collect-partial passes, `mergeSubGraph`) is gone. Source-view edits and form edits both flow through `parseLoadedFile`; saves re-parse the just-written text to refresh the load-time snapshot.

- f1c35bc: Split `Kernel.start()` into `boot()` / `runTargets()` / `teardown()`, add public `Kernel.invoke()`, rename `Kernel.shutdown()` → `Kernel.forceIdle()`.

  Embedders that want "boot once, invoke many" (e.g. an AWS Lambda managed-runtime adapter, IDE previews, programmatic tests) can now drive each lifecycle phase explicitly without owning the wait loop. `start()` stays as a convenience method with no observable behaviour change — its `try` widens to cover `boot()` and `runTargets()` so init-time failures still drive teardown and still emit `Kernel.Stopping` / `Kernel.Stopped`, matching the pre-split contract that the CLI and test runner rely on.

  **New methods**:

  - `boot(): Promise<void>` — initialize resources, emit `Kernel.Initialized`. Does not run targets, does not wait.
  - `runTargets(): Promise<void>` — emit `Kernel.Starting`, run `targets:` from the manifest, emit `Kernel.Started`. Throws `ERR_KERNEL_STATE_INVALID` if called before `boot()` or after `teardown()`, or a second time.
  - `teardown(): Promise<void>` — emit `Kernel.Stopping`, tear down every initialized resource, emit `Kernel.Stopped`. Idempotent on the second call (no-op, no re-emit). Tolerates partial state — a `boot()` that threw mid-init still cleans up.
  - `invoke<TInputs, TOutput>(ref, inputs): Promise<TOutput>` — invoke a `Telo.Invocable` resource by `<Kind>.<Name>` (dot-form string) or `{ kind, name }`. Throws `ERR_KERNEL_STATE_INVALID` before `boot()` or after `teardown()`.

  **Breaking**:

  - `Kernel.shutdown(): void` is renamed to `Kernel.forceIdle(): void`. Same semantics (force-resolve a pending `waitForIdle()` regardless of active holds; used by SIGINT/SIGTERM handlers). The name disambiguates from the new `teardown()`. The only known external caller is the CLI's signal handler, updated in this changeset.
  - New `ERR_KERNEL_STATE_INVALID` runtime error code on `RuntimeErrorCode`.

  No migration needed for callers that only use `start()` — its semantics are unchanged.

- 47f7d83: Single-realm controller install: every controller in a kernel process now resolves through one `<entry-manifest-dir>/.telo/npm/` tree, with the kernel's own `@telorun/sdk` wired in as a `file:` dep. The realpath collapse this produces fixes class-identity bugs across the kernel/controller boundary — most visibly cel-js's `registerType("Stream", Stream)` matching `Stream` instances created on either side of the realm split.

  - `@telorun/kernel`: `Kernel.load(url)` records the entry URL; `getEntryUrl()` is exposed via `ResourceContext`. `NpmControllerLoader` rewrites every load — registry tag or `local_path` — as an `npm install <spec>` into the per-manifest install root. A filesystem lock at `<root>/.lock` (atomic `fs.open(path, 'wx')`, PID + start-time inside) makes the install cross-process safe; a hash of the materialized `package.json` short-circuits repeat installs. The legacy `~/.cache/telo/npm/` global cache is no longer consulted (existing trees are safe to delete by hand). `TELO_PKG_MANAGER` overrides the default `npm` invocation.
  - `@telorun/cli`: `telo install` passes the manifest's entry URL through to the kernel-side loader so the install root lands next to the manifest. `TELO_CACHE_DIR` is no longer consumed.
  - `@telorun/sdk`: `ResourceContext` gains a `getEntryUrl()` method.
  - `@telorun/assert`: `package.json` `exports` map now declares the Bun/Node conditional split (`bun → src/*.ts`, `import → dist/*.js`). The previous bare-`./src/*.ts` entries only worked because the old controller loader silently rewrote `src→dist`; that rewriter is gone.

- Updated dependencies [07c881a]
- Updated dependencies [5c49834]
- Updated dependencies [50ae578]
- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/analyzer@0.9.0
  - @telorun/ide-support@0.3.0
  - @telorun/kernel@0.10.0
  - @telorun/sdk@0.10.0
  - @telorun/templating@0.2.2

## 0.9.2

### Patch Changes

- Updated dependencies [30bcfef]
  - @telorun/analyzer@0.8.1
  - @telorun/templating@0.2.1
  - @telorun/kernel@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [543b91f]
  - @telorun/kernel@0.9.1

## 0.9.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.

### Patch Changes

- Updated dependencies [88e5cb4]
- Updated dependencies [88e5cb4]
  - @telorun/analyzer@0.8.0
  - @telorun/templating@0.2.0
  - @telorun/kernel@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [019c62a]
- Updated dependencies [c792025]
  - @telorun/kernel@0.8.0
  - @telorun/analyzer@0.7.0

## 0.7.3

### Patch Changes

- 84e9edf: `telo publish` now canonicalizes relative `Telo.Import.source` paths (e.g. `../ai`) into absolute registry references of the form `<namespace>/<name>@<version>` before pushing the manifest. Relative paths are only meaningful on the publisher's filesystem; once a manifest reached the registry, the leading `..` collapsed the version segment of the registry URL (so e.g. a sibling import at `…/<package>/<version>/` + `../<sibling>` resolved to `…/<package>/<sibling>`, dropping the version), and any consumer that imported a published library which itself used relative imports got a 500 from the registry. Sibling-module metadata (`namespace` / `name` / `version`) is read from the local target's `telo.yaml` at publish time.

## 0.7.2

### Patch Changes

- Updated dependencies [40ae3ea]
- Updated dependencies [0335074]
  - @telorun/analyzer@0.6.1
  - @telorun/kernel@0.7.2

## 0.7.1

### Patch Changes

- 024debe: Declare `engines.node: ">=24"` on `@telorun/cli` and `@telorun/kernel`. Makes the supported Node version explicit (and fixes the npm Node-version badge in the README, which previously rendered "not specified").
- Updated dependencies [024debe]
  - @telorun/kernel@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [6d4280e]
- Updated dependencies [b62e535]
  - @telorun/kernel@0.7.0
  - @telorun/sdk@0.7.0
  - @telorun/analyzer@0.6.0

## 0.6.1

### Patch Changes

- 0c4d023: Surface controller-download progress as kernel events and render them in the CLI.

  `ControllerLoading` / `ControllerLoaded` / `ControllerLoadFailed` /
  `ControllerLoadSkipped` are now emitted from `ControllerLoader` itself, one
  cycle per attempted PURL candidate so env-missing fallback chains are visible.
  Payloads carry the single attempted `purl` instead of the full candidate
  array, plus `source` (`local` | `node_modules` | `cache` | `npm-install` |
  `cargo-build`) and `durationMs` on `Loaded` so consumers can distinguish real
  work from cache hits. `pkg:cargo` resolutions through `local_path` (the only
  cargo mode currently wired up) report `source: "local"` — cargo's incremental
  cache makes every run after the first effectively a no-op build, the same
  mental model as the npm `local_path` branch. `cargo-build` is reserved for a
  future distribution mode (fetch from a registry + compile). `Skipped` is
  emitted for recoverable env-missing fallbacks (e.g. `pkg:cargo` with no
  `rustc` on PATH) so consumers can close out per-attempt UI state without
  conflating it with a hard failure.

  The CLI renders a `⬇ <purl>` line at `Loading` and rewrites it in place to
  `✓ <purl> (<source>, <ms>)` (or `✗ …`) at `Loaded` / `Failed`. By default the
  renderer activates only when stdout is a TTY, so CI logs and the dockerised
  `telorun/telo` service stay silent. `--verbose` forces rendering on regardless
  of TTY (so captured/piped logs get the lines too).

  By default, resolutions reporting `source: cache` or `local` have their line
  erased once `Loaded` arrives — they're sub-millisecond and don't represent
  work worth surfacing. `--verbose` bypasses this filter and prints every
  resolution, including cache/local, which is useful for debugging which branch
  the loader took. Other sources (`node_modules`, `npm-install`, `cargo-build`)
  always render their `✓` line.

  The cargo / napi loader now also accepts an optional PURL fragment. When
  present, `pkg:cargo/foo?local_path=...#bar` projects to `module.bar` after
  loading the dylib (each sub-export must itself have `create` or `register`);
  without a fragment the whole module is the controller, as before. This
  mirrors the npm `#entry` semantics for crates that want one source file per
  controller. The raw module is cached per crate, so two PURLs differing only
  by fragment share one cargo build.

- Updated dependencies [0c4d023]
  - @telorun/kernel@0.6.1

## 0.6.0

### Minor Changes

- 2e0ad31: In-memory kernel bootstrap and `Adapter` → `Source` rename.

  **Breaking changes:**

  - `Kernel.loadFromConfig(path)` → `Kernel.load(url)`. The new method dispatches the URL through the registered `ManifestSource` chain unchanged — no implicit `file://` cwd-wrapping. The `loadDirectory` deprecation shim is removed.
  - `KernelOptions.sources: ManifestSource[]` is now required. Callers must pass an explicit list, e.g. `new Kernel({ sources: [new LocalFileSource()] })`. The previous hardcoded `LocalFileAdapter` registration in the `Kernel` constructor is gone.
  - `ManifestAdapter` interface renamed to `ManifestSource`. Per-scheme classes renamed: `LocalFileAdapter` → `LocalFileSource`, `HttpAdapter` → `HttpSource`, `RegistryAdapter` → `RegistrySource`. Files and directories renamed in turn (`manifest-adapters/` → `manifest-sources/`, `analyzer/.../adapters/` → `.../sources/`).
  - `LoaderInitOptions` field renames: `extraAdapters` → `extraSources`, `includeHttpAdapter` → `includeHttpSource`, `includeRegistryAdapter` → `includeRegistrySource`.
  - The dead-stub `kernel/nodejs/src/manifest-adapters/manifest-adapter.ts` (an unused parallel interface that drifted from the live one in `@telorun/analyzer`) is deleted.

  **New:**

  - `MemorySource`: an in-memory `ManifestSource` for embedders and tests. Available as a top-level export from `@telorun/kernel` and as a subpath export at `@telorun/kernel/memory-source`. Bare module names register under `<name>/telo.yaml` (mirroring disk's "module is a directory containing telo.yaml" convention) so relative imports (`./sub`, `../sibling`) work transparently with POSIX path resolution. `set(name, content)` accepts either YAML text or an array of parsed manifest objects (serialized via `yaml.stringify`).

  **Internal:**

  - `Loader.moduleCache` is now per-instance rather than `private static readonly`. Multiple in-process kernels (the headline use case for `MemorySource` — test runners, IDE previews) no longer share a process-wide cache.

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0
  - @telorun/kernel@0.6.0
  - @telorun/analyzer@0.5.0

## 0.5.0

### Patch Changes

- Updated dependencies [fc4a562]
- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/kernel@0.5.0
  - @telorun/analyzer@0.4.0
  - @telorun/sdk@0.5.0

## 0.4.1

### Patch Changes

- 2900b1c: `telo publish` now retries transient registry push failures with exponential backoff (up to 4 attempts). Retries on network errors (DNS, reset, `fetch failed`) and on `408`, `425`, `429`, and `5xx` responses so flaky CI pushes no longer fail the whole workflow.
- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
  - @telorun/kernel@0.4.1

## 0.4.0

### Minor Changes

- 6a61dbf: Add `telo install <path>` — pre-downloads every controller declared by a manifest and its transitive `Telo.Import`s into the on-disk cache. At runtime the kernel finds each controller already cached and skips the boot-time `npm install`, removing the startup delay and the network dependency from production containers.

  Reuses the existing `ControllerLoader`, so resolution semantics (local_path, node_modules, npm fallback, entry resolution) are identical to runtime loading. Jobs run in parallel via `Promise.allSettled`; failures are reported per controller and the command exits non-zero if any failed.

  `ControllerLoader` is now exported from `@telorun/kernel`.

  **Cache location**: defaults to `~/.cache/telo/` (XDG-style, shared across projects for a user). Override via `TELO_CACHE_DIR` — set it per-project to bundle the cache alongside the manifest. The registry image now uses `TELO_CACHE_DIR=/srv/.telo-cache` so `telo install` at build time and `telo run` at boot both read/write the same project-local cache, and a single `COPY --from=build /srv /srv` carries the full bundle into the production stage.

### Patch Changes

- Updated dependencies [6a61dbf]
  - @telorun/kernel@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [f75a730]
- Updated dependencies [f75a730]
  - @telorun/kernel@0.3.3

## 0.3.2

### Patch Changes

- 3c4ac58: Resource initialization errors now carry the resource `kind`, an underlying error `code`, and a structured `details` block extracted from the original error — AWS SDK service exceptions expose HTTP status / request ID / fault, pg database errors expose severity / detail / hint / SQLSTATE / routine, Node system errors expose syscall / address / port, and the full `cause` chain is walked. The CLI renders runtime diagnostics distinctly from static-analysis diagnostics: no redundant file path, `kind` and `name` shown as the heading, details indented below.
- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2
  - @telorun/kernel@0.3.2
  - @telorun/analyzer@0.2.1

## 0.3.1

### Patch Changes

- 2d866be: Add `--skip-controllers` flag to `telo publish`. When set, skips the controller build/publish/PURL-rewrite loop and only runs static analysis and pushes the manifest to the Telo registry. Used by the Changesets-driven CI release flow, where controller packages are already published by `changeset publish`.

## 0.3.0

### Minor Changes

- 31d721e: feat: bearer-token auth for the Telo module registry publish endpoint

  The registry's `PUT /{namespace}/{name}/{version}` now requires an `Authorization: Bearer <token>` header. Reads stay anonymous. Tokens are provisioned declaratively at boot via `TELO_PUBLISH_TOKEN` and stored as SHA-256 hashes in a `tokens` table joined to `users` and `namespaces`.

  **Analyzer** (`@telorun/analyzer`) — **breaking for direct API consumers**

  - `StaticAnalyzer` and `Loader` now accept an optional `{ celHandlers }` in their constructors. Analyzer-only callers (VS Code extension, Docusaurus preview, CLI `check`/`publish`) can omit it and get throwing stubs. Runtime callers (kernel) must supply real handlers.
  - The module-level `celEnvironment` singleton is removed — `precompile.ts` now takes the `Environment` as a parameter.
  - New CEL stdlib function: `sha256(string): string`. Always registered with the correct signature so `env.check()` type-checks; behaviour depends on the supplied handler.
  - The throws-union resolver recognises the new `throw:` step shape (see Run module) and resolves its code at the call site using the same rules as passthrough invocables (literal / `${{ 'LIT' }}` / `${{ error.code }}` in catch).
  - CEL type-check failures now surface as diagnostics. Previously the analyzer only reported schema/type mismatches on valid expressions; `env.check(...)` returning `{ valid: false }` (wrong method, wrong operand types, wrong overload — e.g. `s.slice(7)` on a dyn) was silently dropped. Now surfaces as `SCHEMA_VIOLATION` with a `CEL type error:` message.

  **Kernel** (`@telorun/kernel`)

  - Constructs `StaticAnalyzer` and `Loader` with a `node:crypto`-backed `sha256` handler, so CEL templates invoking `sha256()` evaluate at runtime.

  **Run module** (`@telorun/run`) — **breaking**

  - `Run.Sequence` gains a first-class `throw:` step variant: `- name: X; throw: { code, message?, data? }` — throws `InvokeError` directly from inside the sequence. Works inside `catch:` blocks via `code: "${{ error.code }}"` for re-raise. A malformed `throw.code` (non-string or empty after expansion) is itself reported as `InvokeError("INVALID_THROW_STEP", …)` rather than a plain Error, so the failure stays in the structured-error channel and a surrounding `catches:` can map it.
  - The `Run.Throw` invocable is removed. Existing `invoke: { kind: Run.Throw }` call sites must migrate to `throw:` steps. The separate kind was redundant with the new step form, and the `throw:` step expresses the intent more directly inside sequences.
  - **Event-stream change:** `throw:` steps do **not** emit a scoped `<Kind>.<name>.InvokeRejected` event the way `Run.Throw` did. The error is thrown from inside the sequence's own `invoke()`, so the enclosing kind's event is what fires (e.g. `Run.Sequence.<handlerName>.InvokeRejected` — or nothing, when an enclosing `try` absorbs the throw). Downstream observers that filtered on `Run.Throw.*.InvokeRejected` must switch filters.

  **CLI** (`@telorun/cli`)

  - `telo publish` reads `TELO_REGISTRY_TOKEN` and sends it as `Authorization: Bearer <token>`. Without the env var, publishes to auth-gated registries fail with 401.

  See `apps/registry/plans/registry-auth.md` for the full plan.

### Patch Changes

- Updated dependencies [353d7e5]
- Updated dependencies [31d721e]
  - @telorun/sdk@0.3.0
  - @telorun/kernel@0.3.0
  - @telorun/analyzer@0.2.0

## 0.2.9

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.4
  - @telorun/kernel@0.2.9

## 0.2.8

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.3
  - @telorun/kernel@0.2.8

## 0.2.7

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.2
  - @telorun/kernel@0.2.7

## 0.2.6

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/analyzer@0.1.1
  - @telorun/kernel@0.2.6

## 0.2.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.5

## 0.2.4

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/kernel@0.2.4

## 0.2.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.3

## 0.2.2

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/runtime@0.2.2
