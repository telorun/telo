# @telorun/language-server

## 0.107.0

## 0.106.0

## 0.105.0

## 0.104.0

## 0.103.2

## 0.103.1

### Patch Changes

- 41d3c60: The engine no longer walks above a Windows drive root when looking for an owner `telo.yaml` or an enclosing `telo-workspace.yaml`: it asked the host about `file:///telo-workspace.yaml`, which a Windows host cannot resolve, so a `telo-workspace.yaml` lost its diagnostics and completions. A relative path can no longer climb out of its drive either.

## 0.103.0

## 0.102.0

### Minor Changes

- eadb75a: Added: `@telorun/language-server`, the telo language-server engine. `dist/language-server.mjs` is one self-contained ES module with no imports; its `serve(port)` speaks LSP over any message port (a Web Worker scope, a `MessagePort`, an adapted Node `parentPort`) and answers `initialize` with `serverInfo: { name: "telo", version: <its identity> }` — the telo version it is, or `X+unreleased` when built while a release of the line is pending, which its `prepack` refuses to publish — and `experimental.telo.protocol: 1`. It publishes the diagnostics `telo check` reports for every file an open module reaches, and serves completion, hover, go-to-definition, rename, signature help, semantic tokens, quick fixes (carried in `Diagnostic.data`), import-upgrade code lenses and the `telo-workspace.yaml` checks and completions. It does no I/O of its own: every file, import and hub answer is a `telo/*` request its host serves, and it expands `include:` globs itself over `telo/listDirectory` with the kernel's matching rule (regular files only, never through a link), every `file:` URI it sends is in the protocol's canonical form (a UNC share's host kept, lowercased), and after each analysis it sends `telo/requirements`. `package.json` declares `teloEditorProtocol: 1`, the generation a host selects it by. It also declares `teloInlines`, the workspace packages its bundle inlines, which its build verifies against the bundle. The analyzer gains `rangeInterval(range)`, a `requires:` range reduced to its `{ min?, max? }` edges with their inclusivity.
- eadb75a: Changed: the telo runtime packages share one version line. `@telorun/sdk`, `@telorun/templating`, `@telorun/analyzer`, `@telorun/kernel`, `@telorun/cli`, `@telorun/ide-support` and `@telorun/language-server` form one changesets `fixed` group (the `linked` group is gone): a changeset naming any of them releases all of them at one version, so this release puts every member on the same number, and that number is the manifest surface generation a module's `requires: telo:` range is written against. `TELO_SURFACE_VERSION` is the line's version with any pending bump applied, and the Rust twins (`telo-kernel`, `telo-cli`, `telo-analyzer`, `telo-templating`, `telorun-sdk`) carry their Node twin's version in `Cargo.toml` and `Cargo.lock`.
