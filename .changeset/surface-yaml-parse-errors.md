---
"@telorun/analyzer": minor
"@telorun/kernel": patch
"@telorun/cli": patch
---

Surface YAML parse failures as error diagnostics. A document that fails to
parse (e.g. an unquoted scalar containing `: ` that the parser reads as a
nested mapping) previously produced a mangled `toJSON()` projection that
static analysis silently accepted — `telo check` reported "passed" while the
registry rejected the same file on push. The loader now aggregates every
file's YAML `parseErrors` into `LoadedGraph.parseDiagnostics` (fatal `Error`
diagnostics carrying the parser's line/column range), surfaced by `telo check`
/ `telo publish` / the editor / VS Code and treated as fatal by the kernel at
load.
