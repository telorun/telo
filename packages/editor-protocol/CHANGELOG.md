# @telorun/editor-protocol

## 0.2.0

### Minor Changes

- b9e6234: The language-server engine serves the model structured editors read, computed from the analysis its diagnostics come from at the module's own telo version. An engine advertising `experimental.telo.viewModel` answers `telo/viewModel` with an owner module's view model — its module graph, each templated kind's body as a graph, how every kind spelling and reference constraint resolves, the invocation contracts, which of the owner's resources — and, separately, of each template body's entries — every output-constrained slot refuses and why (a slot addressed by its kind and its JSON Pointer in that kind's schema), every reference the owner writes, and the LSP version of each open document the analysis read, so a host can tell a model computed before its latest edit — or `null` for an owner it is not analysing; it sends `telo/viewModelChanged` with a revision after each analysis of an owner and when it drops one; and it answers `telo/celCompletion` with completion for a CEL value typed into a form field, addressed by resource and field path. The protocol stays at generation 1: the additions are negotiated by the capability, and the schema and README document every field.

## 0.1.1

### Patch Changes

- 587220a: `@telorun/editor-protocol` is released under the MIT License from this version: it declares `"license": "MIT"` and ships the MIT text. Versions already published keep the license they shipped with.

## 0.1.0

### Minor Changes

- eadb75a: Added: `@telorun/editor-protocol`, the contract between an editor host and a telo language-server engine. It exports protocol generation `1`, the `experimental.telo.protocol` capability, the host-served requests `telo/read`, `telo/exists`, `telo/listDirectory` (entries `{ name, kind }`, `kind` one of `file` / `directory` / `symlink` / `other`, read without following links), `telo/hub/searchRefs` and `telo/hub/listVersions` (a module directory reads as its `TELO_MODULE_FILENAME`, `telo.yaml`; `include:` globs are expanded by the engine over `telo/listDirectory`), the `telo/requirements` notification (an owner module, its member documents and every `requires: telo:` range in its closure as a normalized interval), the `Diagnostic.data` shape carrying a quick fix, and the `telo.upgradeImport` / `telo.upgradeAllImports` / `telo.refreshImportUpgrades` commands — as TypeScript types and as `editor-protocol-schema.json` for hosts in other languages. The README is the protocol spec: it fixes one canonical `file:` URI form that identity is compared in (an empty authority for a local file, a UNC share's lowercased host, `file:////host/…` folded to `file://host/…`), the handshake's engine identity (`X` for a release, `X+unreleased` for a build made while that release is pending) and its verification, and the rule that a receiver ignores members and enum values it does not know — the published schema accordingly closes no object.
