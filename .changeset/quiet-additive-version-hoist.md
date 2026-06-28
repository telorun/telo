---
"@telorun/analyzer": patch
---

Stop warning on additive pre-1.0 version hoists. When the same module is
imported at different versions within one major, the graph already resolves
every importer to the highest version — a non-lossy, by-design redirect. It no
longer emits a `MODULE_VERSION_HOISTED` warning per import edge (which flooded
`telo check` and `telo run` output for normal version skew).

A `MODULE_VERSION_HOISTED` warning is still raised for the genuinely ambiguous
case — two sources claiming the same version with differing content — and an
incompatible major mismatch remains a hard `MODULE_VERSION_CONFLICT` error.
