---
"@telorun/ide-support": patch
---

Export the CEL-tree walk (`walkCel`, `flattenChain`, `chainAt`) from the package root.

They were already the package's single answer to "walk this expression" — rename is built on them — but only reachable inside it, so a host asking the same question had to write a second `celChildren` and would answer differently the first time the CEL node union grew a case. The editor asks it before deleting a resource: a provider is reached through `resources.<name>` in CEL rather than through a reference slot, so a delete that consulted only the reference walk would report no references and silently break every expression reading it.
