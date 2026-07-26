---
"@telorun/run": minor
---

Add `Run.Choice` — a first-match decision table.

Ordered `when → value` rows return one value: the first row whose CEL predicate
holds wins, with an optional `default` for the no-match case. Fills the gap
between `Run.Value` (one value, branching only via nested ternaries),
`Run.Sequence`'s `switch` (equality keys, not predicates), and `if`/`elseif`
(arbitrary predicates, but selects steps to execute rather than a value).

An optional instance-level `outputType` gives every row one shared result
contract and types `steps.<name>.result` for callers. When declared, `telo check`
validates every row against it — including rows no current input would select —
via the new `x-telo-value-schema-from` annotation. A non-exhaustive table
with no `default` throws `ERR_NO_MATCH` rather than returning a silent null; a
non-boolean predicate is `ERR_INVALID_PREDICATE`; a winning row that violates
`outputType` is `ERR_OUTPUT_INVALID`, named against the row that produced it.
