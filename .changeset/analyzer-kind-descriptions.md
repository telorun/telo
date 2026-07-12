---
"@telorun/analyzer": minor
---

Add the `KIND_MISSING_DESCRIPTION` warning: a `Telo.Library` that exports a
locally-defined kind whose `Telo.Definition` has no `metadata.description` now
gets a non-blocking warning. The description is the primary text the
federated-discovery hub embeds for semantic `search_resources`, so exported
kinds should carry one. Re-exported kinds (`exports.kinds: [Alias.Kind]`) and
non-exported internal kinds are not flagged, and the check only fires when a
library is analyzed directly — importing an under-described library never leaks
warnings to its consumer.
