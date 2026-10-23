# @telorun/language-server

## 0.121.0

### Minor Changes

- b9e6234: The language-server engine serves the model structured editors read, computed from the analysis its diagnostics come from at the module's own telo version. An engine advertising `experimental.telo.viewModel` answers `telo/viewModel` with an owner module's view model — its module graph, each templated kind's body as a graph, how every kind spelling and reference constraint resolves, the invocation contracts, which of the owner's resources — and, separately, of each template body's entries — every output-constrained slot refuses and why (a slot addressed by its kind and its JSON Pointer in that kind's schema), every reference the owner writes, and the LSP version of each open document the analysis read, so a host can tell a model computed before its latest edit — or `null` for an owner it is not analysing; it sends `telo/viewModelChanged` with a revision after each analysis of an owner and when it drops one; and it answers `telo/celCompletion` with completion for a CEL value typed into a form field, addressed by resource and field path. The protocol stays at generation 1: the additions are negotiated by the capability, and the schema and README document every field.
- 062d4d0: A `Telo.HostPath` slot may say what its path names: `x-telo-type: { name: Telo.HostPath, entry: directory }` (or `entry: file`). Omitted means either, and an absent path is never refused. `telo check` refuses a `!module-path` naming the other kind of entry, a variable declared with the other `entry` read into the field, and one an import passes to a library input declaring the other (`HOST_PATH_ENTRY_MISMATCH`); at a call's `inputs:` the mismatch is `CEL_TYPE_ARGUMENT_MISMATCH`, and a token outside `file` / `directory` is `X_TELO_TYPE_ARGUMENT_INVALID`. The kernel refuses an existing path of the other kind when it creates the resource holding it (`ERR_HOST_PATH_ENTRY_MISMATCH`) and one the filesystem will not answer for (`ERR_HOST_PATH_UNREADABLE`), and an Application variable or secret declaring `entry` at load, inside `ERR_MANIFEST_VALIDATION_FAILED`. `!module-path` completion offers only directories at a directory slot. The value-type data gains a parameter flag, `hostEntry`, which both SDK readers accept on a `fromHost` type only. `ManifestSource.exists` is replaced by `entryAt(base, relative)`, answering `file`, `directory` or nothing; the loader stamps what a single-claim tag names on it. `Telo.DurableDirectory.path` declares `entry: directory`. The Rust kernel now refuses both at creation as the Node kernel does — a path of the other kind (`ERR_HOST_PATH_ENTRY_MISMATCH`) and a relative one, literals included since it runs no analysis (`ERR_HOST_PATH_RELATIVE`) — and both kernels answer one set of vectors, `analyzer/host-path-conformance/`.
- a6d17ff: New package `@telorun/message-format` (with its Rust twin `telorun-message-format`): Telo's message core. It reads a closed profile of Unicode MessageFormat 2 — text with `{$name}` placeholders and the escapes `\{`, `\}`, `\\`, and plural selections `{ plural: count, cases: { "=0": …, one: …, other: … } }` that nest — into a plain-JSON model, and identifies a source text by its all-`other` pattern plus its context. It finds a catalog language by RFC 4647 lookup (`pl-Latn-PL` → `pl-Latn` → `pl`). It formats numbers and selects plural categories from pinned CLDR 48.2 data for every locale, using no `Intl`, so Node, Rust and the browser give the same answer. A number's text depends on its value alone: int64 and uint64 are written exactly, and a double is rounded half-to-even to the language's pattern. `@telorun/sdk` now depends on the core and re-exports it.

## 0.120.1

## 0.120.0

## 0.119.0

### Minor Changes

- 63c81d0: A failed import is reported the same way by `telo check`, by `ctx.runtime.check` and by a run.

  - **Breaking for a caller of `ctx.runtime.check` that read `loadError` on an import failure.** The seam now answers with exactly the diagnostics `telo check` reports — built by the same assembler, with the same codes, messages and locations (`line` / `column` set wherever `telo check` locates one) — so a failed import is its coded diagnostic at `imports.<alias>` (`INVALID_IMPORT_SOURCE`, `IMPORT_UNRESOLVED`, `INVALID_IMPORT_TARGET`, `KIND_PREFIX_RESERVED`), and `loadError` is set only when the graph could not be loaded at all (an unreadable entry, a refused partial). It used to stop at the first failed import and return its loader message as `loadError`, and to stop at a parse failure before analysing the rest.
  - **A run refused for a failed import carries every import's static diagnostic** under `ERR_INVALID_IMPORT_SOURCE`, `ERR_IMPORT_UNRESOLVED`, `ERR_INVALID_IMPORT_TARGET` or `ERR_KIND_PREFIX_RESERVED` (a loader error carrying a code of its own keeps it), so `telo run` prints the `imports:` line `telo check` prints and a refused child writes `[<CODE>] <message>` for it. The Node kernel used to raise the loader's bare error for every import failure but a reserved prefix. An import of the built-in vocabulary archive is `ERR_INVALID_IMPORT_TARGET` in both kernels (it was `ERR_MANIFEST_VALIDATION_FAILED`). A `Telo.Import` declared in a `with:` scope is loaded, when its scope opens, by the same per-import step the graph walk runs and refused the same way: an unresolvable source is `ERR_IMPORT_UNRESOLVED` and a malformed one `ERR_INVALID_IMPORT_SOURCE` (both were the bare loader error), an application target is `ERR_INVALID_IMPORT_TARGET` in the loader's words (it was `ERR_MANIFEST_VALIDATION_FAILED`), and so is a target with no `Telo.Library` (it was an uncoded error). `@telorun/analyzer` exports that step, `loadImportTarget`, and `importFailureDiagnostics` for it.
  - **A failed `Kernel.reconcile()` leaves the kernel as it was.** A reconcile refused while loading (a failed import, a parse failure) used to keep the refused graph, so the next reconcile diffed against it — missing a library edit, or reporting a spurious `restartRequired` after the edit was reverted.
  - **Breaking for a consumer of `@telorun/ide-support`'s diagnostic assembly**: `assembleGraphDiagnostics`, `compromisedFiles`, `findPositions` and `resolveRange` moved to `@telorun/analyzer`, which also exports `locateDiagnostic` (a diagnostic's file and range, as every host reports it). `@telorun/ide-support` no longer exports them.

## 0.118.0

## 0.117.0

## 0.116.0

### Patch Changes

- f72827b: CEL inside a folded block scalar (`>`, `>-`) or a quoted or plain scalar spanning several lines is located on the characters the author wrote. Before, every node's range in such a body was shifted, so editor colouring, hover, go-to-definition, CEL diagnostics and rename landed on the wrong text.

## 0.115.2

### Patch Changes

- 293b0d8: A YAML file beside a module whose `kind:` is unqualified — a Kubernetes manifest or a Helm template (`kind: Deployment`) — is no longer taken for a partial of that module, and no longer warned as "not listed in the 'include' field". A partial declares a module-qualified kind (`Run.Sequence`), which is what the engine now looks for; a stray file declaring one is still warned.

## 0.115.1

## 0.115.0

## 0.114.0

## 0.113.0

## 0.112.0

## 0.111.0

## 0.110.0

## 0.109.0

### Minor Changes

- 3fe9d3d: The analyzer's CEL half now runs on `@telorun/cel`; `@marcbachmann/cel-js` is no longer a dependency of it. The editor's CEL symbols read the new engine's types with it, so completion and hover answer what `telo check` resolves, and the engine bundle declares `@telorun/cel` among the workspace packages it inlines.

  **A module's own names are NAMESPACES on the environment a site is read against.** Resolution used to be a rewrite applied to a parsed tree after the fact; a qualified call is now a node of its own, produced as the expression is READ over the name set, so every walk — access chains, the unused-declaration pass, the durable-nondeterminism pass, a callable's derived flags, a rule's condition — sees the resolved shape instead of re-deriving it. A namespace is declared **open**, with each reachable callable's declared result and no parameter list: whether a call reaches a function at all, and whether its arity and arguments fit, rest on the export gate, the dependency edge and a JSON Schema per parameter, which is `FUNCTION_UNRESOLVED` / `_NOT_EXPORTED` / `_NOT_CALLABLE` / `_ARITY_MISMATCH` / `_ARGUMENT_MISMATCH` — the analyzer's own verdicts, withheld by the engine by construction rather than suppressed after the fact.

  **A name a module declares that CEL cannot read as a namespace is filtered, not refused.** A module name, an import alias and a library's `metadata.name` are YAML scalars nothing lexes where they are written — which is what `INVALID_NAME` / `INVALID_TYPE_NAME` exist to report — so a set reaching the engine routinely holds `my-module`, and the engine refuses such a set whole. Letting that throw would turn one reportable name into a crash losing every other diagnostic in the file.

  **Reading never throws and never discards what it read**, so a `try { parse } catch` is now a check for one ranged diagnostic, and a scalar an author is mid-way through typing keeps its longest-prefix tree. Three verdict MESSAGES are the engine's own words now, with the same codes: an undeclared field reads `"dbb" is not declared here (declared: db)`, an operator with no overload `no "+" is declared over int, string`, and a repair the checker builds writes CEL's own string quoting (`a.b.startsWith("x")`).

  **A branded CEL value is a plain object, so two structural walks stopped asking the prototype.** `precompileDoc` and the plain-literal decoder rebuilt a container from its entries, which drops the symbol a duration, a uint or a timestamp carries its brand under — silently turning a decoded duration into a pair of numbers — where the class instance they were written against came back untouched. Both now ask `isCelRecord`.

  `steps` is registered as a closed record rather than a named type with an `in` operator of its own, since a record is a map with named keys and the standard library's `K in map<K, V>` already answers `'<step>' in steps`.

## 0.108.0

### Minor Changes

- 8c94cc0: The analyzer's CEL half now runs on `@telorun/cel`; `@marcbachmann/cel-js` is no longer a dependency of it. The editor's CEL symbols read the new engine's types with it, so completion and hover answer what `telo check` resolves, and the engine bundle declares `@telorun/cel` among the workspace packages it inlines.

  **A module's own names are NAMESPACES on the environment a site is read against.** Resolution used to be a rewrite applied to a parsed tree after the fact; a qualified call is now a node of its own, produced as the expression is READ over the name set, so every walk — access chains, the unused-declaration pass, the durable-nondeterminism pass, a callable's derived flags, a rule's condition — sees the resolved shape instead of re-deriving it. A namespace is declared **open**, with each reachable callable's declared result and no parameter list: whether a call reaches a function at all, and whether its arity and arguments fit, rest on the export gate, the dependency edge and a JSON Schema per parameter, which is `FUNCTION_UNRESOLVED` / `_NOT_EXPORTED` / `_NOT_CALLABLE` / `_ARITY_MISMATCH` / `_ARGUMENT_MISMATCH` — the analyzer's own verdicts, withheld by the engine by construction rather than suppressed after the fact.

  **A name a module declares that CEL cannot read as a namespace is filtered, not refused.** A module name, an import alias and a library's `metadata.name` are YAML scalars nothing lexes where they are written — which is what `INVALID_NAME` / `INVALID_TYPE_NAME` exist to report — so a set reaching the engine routinely holds `my-module`, and the engine refuses such a set whole. Letting that throw would turn one reportable name into a crash losing every other diagnostic in the file.

  **Reading never throws and never discards what it read**, so a `try { parse } catch` is now a check for one ranged diagnostic, and a scalar an author is mid-way through typing keeps its longest-prefix tree. Three verdict MESSAGES are the engine's own words now, with the same codes: an undeclared field reads `"dbb" is not declared here (declared: db)`, an operator with no overload `no "+" is declared over int, string`, and a repair the checker builds writes CEL's own string quoting (`a.b.startsWith("x")`).

  **A branded CEL value is a plain object, so two structural walks stopped asking the prototype.** `precompileDoc` and the plain-literal decoder rebuilt a container from its entries, which drops the symbol a duration, a uint or a timestamp carries its brand under — silently turning a decoded duration into a pair of numbers — where the class instance they were written against came back untouched. Both now ask `isCelRecord`.

  `steps` is registered as a closed record rather than a named type with an `in` operator of its own, since a record is a map with named keys and the standard library's `K in map<K, V>` already answers `'<step>' in steps`.

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
