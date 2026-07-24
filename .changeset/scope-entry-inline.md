---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Reject `!ref` references in `x-telo-scope` fields (e.g. `Run.Sequence`'s `with:`). Such an entry previously registered a config-less resource and failed deep in the controller with a misleading schema error; the kernel now throws `ERR_SCOPE_ENTRY_NOT_INLINE` and `telo check` flags it statically as `SCOPE_ENTRY_NOT_INLINE`, pointing at the offending entry. Scope fields declare inline resource definitions; reference an outer resource from a sibling field like `targets:` instead.

Also remove the unwired `keepAlive` field from the `Telo.Application` schema — process liveness is governed by resources acquiring a kernel hold (e.g. an HTTP server), not by this flag, which had no runtime effect.
