---
"@telorun/vscode-extension": patch
---

Register a `telo` language id and auto-promote yaml manifests to it so Red Hat's YAML extension stops firing `!cel` / `!literal` "unresolved tag" warnings on Telo manifests. Includes a stub TextMate grammar that delegates to `source.yaml` for highlighting and a basic language-configuration for brackets, comments, and indentation.
