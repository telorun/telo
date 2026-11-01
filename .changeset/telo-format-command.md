---
"@telorun/analyzer": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
"telo-vscode": minor
---

Add `telo format`: rewrites manifests to the canonical layout (scalar lists and small scalar maps in flow style, everything else untouched), with `--check` for CI. The language server answers document formatting with the same engine and the VS Code extension turns format-on-save on for Telo manifests.
