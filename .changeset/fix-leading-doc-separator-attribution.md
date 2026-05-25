---
"@telorun/analyzer": patch
---

Fix diagnostic line attribution in multi-doc YAML files that start with `---`. The leading `---` is the start marker for doc 0, not a separator before an empty doc; treating it as a separator drifted every subsequent doc's `sourceLine` by one entry, so diagnostics for doc N landed inside doc N-1's text (e.g. an `Http.Server` error squiggling on a preceding `Telo.Import` block).
