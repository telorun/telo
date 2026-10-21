---
"@telorun/editor-protocol": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
---

The language-server engine serves the model structured editors read, computed from the analysis its diagnostics come from at the module's own telo version. An engine advertising `experimental.telo.viewModel` answers `telo/viewModel` with an owner module's view model — its module graph, each templated kind's body as a graph, how every kind spelling and reference constraint resolves, the invocation contracts, which of the owner's resources — and, separately, of each template body's entries — every output-constrained slot refuses and why (a slot addressed by its kind and its JSON Pointer in that kind's schema), every reference the owner writes, and the LSP version of each open document the analysis read, so a host can tell a model computed before its latest edit — or `null` for an owner it is not analysing; it sends `telo/viewModelChanged` with a revision after each analysis of an owner and when it drops one; and it answers `telo/celCompletion` with completion for a CEL value typed into a form field, addressed by resource and field path. The protocol stays at generation 1: the additions are negotiated by the capability, and the schema and README document every field.
