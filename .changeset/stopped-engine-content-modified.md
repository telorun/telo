---
"@telorun/language-host": patch
---

A request still pending on an engine the router stops because no open document uses it any more — its document moved to another telo version, or closed — is now rejected as `ContentModified` (`-32801`) instead of an internal error. Editors drop such an answer silently and ask again, so VS Code no longer logs `Request textDocument/codeAction failed … engine was stopped` when a module moves engines. An engine that fails still rejects its pending requests as an error.
