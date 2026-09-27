---
"@telorun/language-server": patch
---

The engine no longer walks above a Windows drive root when looking for an owner `telo.yaml` or an enclosing `telo-workspace.yaml`: it asked the host about `file:///telo-workspace.yaml`, which a Windows host cannot resolve, so a `telo-workspace.yaml` lost its diagnostics and completions. A relative path can no longer climb out of its drive either.
