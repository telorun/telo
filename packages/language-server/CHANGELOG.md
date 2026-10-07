# @telorun/language-server

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
