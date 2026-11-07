---
"@telorun/analyzer": patch
"@telorun/cel": patch
"@telorun/cli": patch
"@telorun/debug-ui": patch
"@telorun/debug-wire": patch
"@telorun/editor-protocol": patch
"@telorun/glob": patch
"@telorun/ide-support": patch
"@telorun/kernel": patch
"@telorun/language-host": patch
"@telorun/k8s-runner": patch
"@telorun/language-server": patch
"@telorun/message-format": patch
"@telorun/runner-core": patch
"@telorun/templating": patch
"telo-vscode": patch
---

A published package's README and markdown links to files in the repository are rewritten to the git tag of the release run that publishes it (`v<version>`, or `packages-<x.y>-<n>`) when it is packed, instead of pointing at whichever ref a reader's browser happens to resolve them against. Source files are left as written.
